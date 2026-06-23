use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewBuilder,
    WebviewUrl, WindowEvent,
};

/// Allocate a hidden console for the parent process on Windows.
///
/// `portable-pty` spawns ConPTY children via `CreateProcessW` without
/// `CREATE_NO_WINDOW` or `CREATE_NEW_CONSOLE`. When the parent has no console
/// attached (as is the case for this GUI subsystem app), Windows allocates a
/// fresh visible console window for each child — the blank black window that
/// appears behind BYOCLI for every spawned shell.
///
/// Allocating a console for the parent once and hiding it means children
/// inherit the existing (hidden) console instead of getting their own window.
/// Called once from `run()` before any terminal is spawned.
#[cfg(windows)]
fn attach_hidden_console() {
    use windows::Win32::System::Console::{AllocConsole, GetConsoleWindow};
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};

    // SAFETY: AllocConsole attaches a new console to the calling process. It's
    // unsafe only in the FFI sense (no inherent memory-safety hazard). It
    // returns Err if a console is already attached — harmless, we just bail.
    // GetConsoleWindow returns 0 if no console is attached; ShowWindow with
    // HWND(0) is a documented no-op. The window handle, when non-zero, is valid
    // for the process lifetime.
    unsafe {
        let _ = AllocConsole();
        let hwnd = GetConsoleWindow();
        if hwnd.0 as usize != 0 {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

#[cfg(not(windows))]
fn attach_hidden_console() {}

struct TerminalProcess {
  master: Box<dyn MasterPty + Send>,
  writer: Box<dyn Write + Send>,
  child: Box<dyn Child + Send + Sync>,
}

/// Sentinel exit code emitted when a session was killed via `kill_terminal`.
/// The frontend uses this to distinguish intentional kills (no retry, no
/// "failed" framing) from genuine non-zero exits. Uses the conventional Unix
/// "killed by signal" encoding (128 + signal) with SIGKILL (9) = 137.
const KILLED_EXIT_CODE: u32 = 137;

/// Minimal content-type guesser for the local-file HTTP server. Covers the
/// browser-renderable types the file-tree double-click opens.
fn guess_mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("html") | Some("htm") | Some("xhtml") => "text/html; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("pdf") => "application/pdf",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Start a minimal localhost HTTP server that serves files from disk. Returns
/// the bound port.
///
/// Why this exists: WebView2 blocks `file://` navigation from external webview
/// origins and doesn't reliably honor Tauri's registered custom protocols in
/// child webviews (the URL gets mangled into `file:////?/C:/...` /
/// `https://localfile:////?/...`). The only origin all webviews universally
/// allow is `http://`, so we serve local files over `http://127.0.0.1:PORT`.
/// This is how Vite/webpack serve local content — battle-tested and zero
/// webview-scope uncertainty.
///
/// The server runs for the app's lifetime on a background thread. It serves any
/// file by absolute path (the URL path is the percent-decoded filesystem path),
/// which is acceptable because BYOCLI only constructs these URLs from files the
/// user double-clicked in their own workspace.
pub fn start_local_file_server() -> Result<u16, String> {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // Accept the listener once per thread; the server thread owns it for life.
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            // Read the request line (minimal HTTP/1.x parsing — we only need the
            // path). Bound the read so a malformed client can't hang us.
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]);
            // Parse: `GET /<path> HTTP/1.1`. WebView2 injects a sandbox prefix
            // into the path even for localhost URLs — the raw request line comes
            // in as `GET /?/C:/Users/.../index.html` (or with `?` percent-encoded
            // as `%3F`). We percent-decode first, then strip the leading slash
            // and any `?/` sandbox prefix, so the remainder is a clean path.
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .map(|p| {
                    let decoded = percent_decode(p);
                    let after_slash = decoded.strip_prefix('/').unwrap_or(&decoded);
                    after_slash.strip_prefix("?/").unwrap_or(after_slash).to_string()
                });

            let response = match path {
                Some(decoded) => {
                    // On Windows the path looks like `C:/Users/.../index.html`.
                    // The browser may URL-encode the drive separator; decoding
                    // already handled that. If the file exists, serve it.
                    let candidate = PathBuf::from(&decoded);
                    match fs::read(&candidate) {
                        Ok(bytes) => {
                            let mime = guess_mime(&decoded);
                            let body = String::from_utf8_lossy(&bytes).into_owned();
                            // Rewrite relative asset references to absolute
                            // localfile/http URLs so a served HTML file's <link>
                            // and <script> tags resolve against the same server.
                            // (Without this, `style.css` in index.html would 404.)
                            let body = if mime.starts_with("text/html") {
                                rewrite_html_assets(&body, &candidate)
                            } else {
                                body
                            };
                            let len = body.len();
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{}",
                                mime, len, body
                            )
                        }
                        Err(_) => {
                            let msg = format!("404 Not Found: {}", decoded);
                            format!(
                                "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                msg.len(), msg
                            )
                        }
                    }
                }
                None => {
                    let msg = "400 Bad Request";
                    format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        msg.len(), msg
                    )
                }
            };
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    Ok(port)
}

/// Percent-decode a URL path component into a filesystem path string. Converts
/// `%20` → space, `%25` → `%`, etc. Non-UTF8 bytes fall back to lossy conversion.
fn percent_decode(input: &str) -> String {
    let mut out = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        // `+` is sometimes used for spaces in query strings; treat as space.
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Rewrite relative `src`/`href` attributes in an HTML document so they point
/// back at the local server, letting the browser fetch sibling assets
/// (stylesheets, scripts, images) referenced by the served file. Absolute and
/// already-qualified URLs (http://, //, #, data:, mailto:) are left alone.
///
/// Manual string scan rather than regex to avoid pulling in a crate. We look
/// for `src="..."` and `href="..."` and rewrite relative values.
fn rewrite_html_assets(html: &str, base_file: &Path) -> String {
    let port = LOCAL_FILE_PORT.get().copied().unwrap_or(0);
    let dir = base_file.parent().unwrap_or_else(|| Path::new("."));
    let mut out = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Match `src=` or `href=` (case-insensitive) followed by a quoted value.
        if let Some(attr_len) = match_attr(bytes, i, "src").or_else(|| match_attr(bytes, i, "href")) {
            let attr = &html[i..i + attr_len];
            out.push_str(attr);
            i += attr_len;
            // Optional whitespace before =
            while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                out.push(bytes[i] as char);
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'=' {
                out.push('=');
                i += 1;
                while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                    out.push(bytes[i] as char);
                    i += 1;
                }
                // Find the quote char and the closing quote.
                if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                    let quote = bytes[i];
                    out.push(quote as char);
                    i += 1;
                    let start = i;
                    while i < bytes.len() && bytes[i] != quote {
                        i += 1;
                    }
                    let value = &html[start..i];
                    let is_relative = !value.starts_with("http://")
                        && !value.starts_with("https://")
                        && !value.starts_with("//")
                        && !value.starts_with('#')
                        && !value.starts_with("data:")
                        && !value.starts_with("mailto:")
                        && !value.starts_with("tel:");
                    if is_relative && port > 0 {
                        let joined = dir.join(value);
                        let abs = joined.to_string_lossy().replace('\\', "/");
                        out.push_str(&format!("http://127.0.0.1:{port}/{abs}"));
                    } else {
                        out.push_str(value);
                    }
                    if i < bytes.len() {
                        out.push(quote as char);
                        i += 1;
                    }
                }
            }
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

/// If `bytes` at position `i` matches `attr=` (case-insensitive, ignoring
/// leading/trailing spaces), return the byte length matched (the attribute name
/// only, not the `=`). Returns None otherwise.
fn match_attr(bytes: &[u8], i: usize, attr: &str) -> Option<usize> {
    let ab = attr.as_bytes();
    if i + ab.len() > bytes.len() {
        return None;
    }
    for (j, &c) in ab.iter().enumerate() {
        if bytes[i + j].to_ascii_lowercase() != c.to_ascii_lowercase() {
            return None;
        }
    }
    Some(ab.len())
}

// Set by start_local_file_server() so rewrite_html_assets can build absolute
// URLs. Stored in a OnceLock so it's read-only after init.
static LOCAL_FILE_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

struct TerminalState {
    processes: Arc<Mutex<HashMap<String, TerminalProcess>>>,
    /// Session ids explicitly killed via `kill_terminal`. Their exit is expected
    /// and must not be reported as a failure to the frontend (which would
    /// trigger spurious retries). Removed when the reader thread observes exit.
    killed: Arc<Mutex<HashSet<String>>>,
}

impl Default for TerminalState {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            killed: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

struct DatabaseState {
    connection: Mutex<Connection>,
}

/// Holds the port of the localhost file server, if it started successfully.
/// Managed as Tauri state so the `get_local_file_server_port` command can read
/// it without touching the OnceLock directly.
struct LocalFileServerPort(u16);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnRequest {
    session_id: String,
    workspace_id: String,
    cwd: String,
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
    exit_code: u32,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AnnotationPayload {
    url: String,
    tag: String,
    text: String,
    selector: String,
    xpath: String,
    bounds: Bounds,
    nearby_text: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
struct BrowserWebviewRequest {
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTreeEntry {
    name: String,
    path: String,
    kind: String,
}

#[derive(Debug, Serialize)]
struct DirectoryListing {
    entries: Vec<FileTreeEntry>,
    truncated: bool,
}

fn canonical_workspace_path(root: &Path, requested: &Path) -> Result<(PathBuf, PathBuf), String> {
    let canonical_root = root.canonicalize().map_err(|error| {
        format!("Could not access workspace '{}': {error}", root.display())
    })?;
    let canonical_requested = requested.canonicalize().map_err(|error| {
        format!("Could not access '{}': {error}", requested.display())
    })?;
    if !canonical_requested.starts_with(&canonical_root) {
        return Err("The requested directory is outside the workspace.".to_string());
    }
    Ok((canonical_root, canonical_requested))
}

fn read_workspace_directory(root: String, path: String) -> Result<DirectoryListing, String> {
    const MAX_DIRECTORY_ENTRIES: usize = 500;
    let root_path = PathBuf::from(&root);
    let requested_path = if path.trim().is_empty() {
        root_path.clone()
    } else {
        PathBuf::from(&path)
    };
    let (canonical_root, canonical_requested) =
        canonical_workspace_path(&root_path, &requested_path)?;
    if !canonical_requested.is_dir() {
        return Err("The requested path is not a directory.".to_string());
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    for result in fs::read_dir(&canonical_requested).map_err(|error| error.to_string())? {
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            truncated = true;
            break;
        }
        let entry = match result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        let entry_path = entry.path();
        let kind = if file_type.is_dir() {
            "directory"
        } else if file_type.is_symlink() {
            match entry_path.canonicalize() {
                Ok(target) if target.starts_with(&canonical_root) => "symlink",
                _ => continue,
            }
        } else {
            "file"
        };
        entries.push(FileTreeEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry_path.to_string_lossy().to_string(),
            kind: kind.to_string(),
        });
    }
    entries.sort_by(|left, right| {
        let left_directory = left.kind == "directory";
        let right_directory = right.kind == "directory";
        match (left_directory, right_directory) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
        }
    });
    Ok(DirectoryListing { entries, truncated })
}

#[tauri::command]
async fn list_workspace_directory(root: String, path: String) -> Result<DirectoryListing, String> {
    tauri::async_runtime::spawn_blocking(move || read_workspace_directory(root, path))
        .await
        .map_err(|error| format!("Directory task failed: {error}"))?
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let path = data_dir.join("byocli.sqlite3");
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA wal_autocheckpoint = 100;
             CREATE TABLE IF NOT EXISTS app_state (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL,
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())
             );",
        )
        .map_err(|error| error.to_string())?;
    let has_state: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_state WHERE key = 'app')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !has_state {
        let legacy_path = app
            .path()
            .config_dir()
            .map_err(|error| error.to_string())?
            .join("com.relay.workspace")
            .join("relay.sqlite3");
        if legacy_path.exists() {
            let legacy = Connection::open_with_flags(
                &legacy_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|error| error.to_string())?;
            let legacy_state = legacy.query_row(
                "SELECT value FROM app_state WHERE key = 'app'",
                [],
                |row| row.get::<_, String>(0),
            );
            if let Ok(value) = legacy_state {
                connection
                    .execute(
                        "INSERT INTO app_state (key, value, updated_at) VALUES ('app', ?1, unixepoch())",
                        params![value],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(connection)
}

#[tauri::command]
fn load_app_state(database: State<'_, DatabaseState>) -> Result<Option<Value>, String> {
    let connection = database.connection.lock().map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT value FROM app_state WHERE key = 'app'")
        .map_err(|error| error.to_string())?;
    let mut rows = statement.query([]).map_err(|error| error.to_string())?;
    if let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let raw: String = row.get(0).map_err(|error| error.to_string())?;
        serde_json::from_str(&raw).map(Some).map_err(|error| error.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn save_app_state(state: Value, database: State<'_, DatabaseState>) -> Result<(), String> {
    let raw = serde_json::to_string(&state).map_err(|error| error.to_string())?;
    let connection = database.connection.lock().map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO app_state (key, value, updated_at) VALUES ('app', ?1, unixepoch())
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![raw],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_automation_temp_directory() -> Result<String, String> {
    let path = std::env::temp_dir().join("BYOCLI").join("automations");
    fs::create_dir_all(&path).map_err(|error| {
        format!("Could not create BYOCLI's automation temp directory: {error}")
    })?;
    // Best-effort sweep of stale automation work dirs so the temp location
    // doesn't accumulate indefinitely. Anything not modified in the last seven
    // days is removed; errors are ignored (the OS also reclaims its temp dir on
    // its own schedule). This runs once per app start — the frontend calls this
    // command at boot.
    const STALE_AFTER_SECS: u64 = 7 * 24 * 60 * 60;
    if let Ok(entries) = fs::read_dir(&path) {
        let now = std::time::SystemTime::now();
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else { continue };
            let Ok(modified) = metadata.modified() else { continue };
            // Age = how long since the entry was last modified. Stale if older
            // than the threshold.
            let stale = now
                .duration_since(modified)
                .map(|age| age.as_secs() > STALE_AFTER_SECS)
                .unwrap_or(false);
            if !stale {
                continue;
            }
            if metadata.is_dir() {
                let _ = fs::remove_dir_all(entry.path());
            } else {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_local_file_server_port(state: State<'_, LocalFileServerPort>) -> Result<u16, String> {
    Ok(state.0)
}

#[tauri::command]
fn get_running_terminal_session_ids(
    terminal_state: State<'_, TerminalState>,
) -> Result<Vec<String>, String> {
    let processes = terminal_state.processes.lock().map_err(|error| error.to_string())?;
    Ok(processes.keys().cloned().collect())
}

#[cfg(windows)]
fn resolve_windows_command(command: &str) -> PathBuf {
    let requested = PathBuf::from(command);
    let extensions = ["exe", "com", "cmd", "bat"];

    if requested.extension().is_some() {
        return requested;
    }

    if requested.components().count() > 1 {
        for extension in extensions {
            let candidate = requested.with_extension(extension);
            if candidate.is_file() {
                return candidate;
            }
        }
        return requested;
    }

    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for extension in extensions {
                let candidate = directory.join(command).with_extension(extension);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }

    requested
}

fn terminal_command(request: &SpawnRequest) -> CommandBuilder {
    #[cfg(windows)]
    {
        let resolved = resolve_windows_command(&request.command);
        let extension = resolved
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if extension == "cmd" || extension == "bat" {
            let mut command = CommandBuilder::new("cmd.exe");
            command.args(["/D", "/S", "/C"]);
            command.arg(resolved);
            command.args(request.args.clone());
            return command;
        }

        let mut command = CommandBuilder::new(resolved);
        command.args(request.args.clone());
        return command;
    }

    #[cfg(not(windows))]
    {
        let mut command = CommandBuilder::new(&request.command);
        command.args(request.args.clone());
        command
    }
}

#[tauri::command]
fn spawn_terminal(
    request: SpawnRequest,
    app: AppHandle,
    terminal_state: State<'_, TerminalState>,
) -> Result<(), String> {
    {
        let processes = terminal_state.processes.lock().map_err(|error| error.to_string())?;
        if processes.contains_key(&request.session_id) {
            return Ok(());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: request.rows.max(2),
            cols: request.cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    let mut command = terminal_command(&request);
    command.cwd(PathBuf::from(&request.cwd));
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("BYOCLI_WORKSPACE_ID", &request.workspace_id);

    let child = pair.slave.spawn_command(command).map_err(|error| {
        format!(
            "Could not start '{}' in '{}': {}",
            request.command, request.cwd, error
        )
    })?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
    let session_id = request.session_id.clone();
    let output_app = app.clone();
    let processes = terminal_state.processes.clone();
    let killed_set = terminal_state.killed.clone();

    terminal_state
        .processes
        .lock()
        .map_err(|error| error.to_string())?
        .insert(
            request.session_id,
            TerminalProcess {
                master: pair.master,
                writer,
                child,
            },
        );

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let data = String::from_utf8_lossy(&buffer[..count]).replace('\u{0007}', "");
                    let _ = output_app.emit(
                        "terminal-output",
                        TerminalOutput {
                            session_id: session_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        // Pull the child out of the map under the lock, but do NOT call `wait()`
        // while holding it — `wait()` blocks until the OS reaps the process, which
        // can lag PTY EOF on Windows and would stall every other terminal command
        // (write/resize/kill) across all sessions.
        let child = processes
            .lock()
            .ok()
            .and_then(|mut running| running.remove(&session_id));
        // HashSet::remove returns bool directly — true if the session was marked
        // killed. If the lock is poisoned, assume not killed and let the child's
        // real exit status decide.
        let was_killed = killed_set
            .lock()
            .map(|mut set| set.remove(&session_id))
            .unwrap_or(false);
        // For an explicitly killed session, report a sentinel exit code so the
        // frontend can distinguish "user killed" from "crashed" and skip retries.
        let exit_code = if was_killed {
            KILLED_EXIT_CODE
        } else {
            match child {
                Some(mut process) => process
                    .child
                    .wait()
                    .ok()
                    .map(|status| status.exit_code())
                    .unwrap_or(1),
                None => {
                    // Already removed (e.g. killed concurrently) — treat as killed.
                    KILLED_EXIT_CODE
                }
            }
        };
        let _ = output_app.emit(
            "terminal-exit",
            TerminalExit {
                session_id: session_id.clone(),
                exit_code,
            },
        );
    });
    Ok(())
}

#[tauri::command]
fn write_terminal(
    session_id: String,
    data: String,
    terminal_state: State<'_, TerminalState>,
) -> Result<(), String> {
    let mut processes = terminal_state.processes.lock().map_err(|error| error.to_string())?;
    let process = processes
        .get_mut(&session_id)
        .ok_or_else(|| format!("Terminal session {session_id} is not running"))?;
    process.writer.write_all(data.as_bytes()).map_err(|error| error.to_string())?;
    process.writer.flush().map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    terminal_state: State<'_, TerminalState>,
) -> Result<(), String> {
    let processes = terminal_state.processes.lock().map_err(|error| error.to_string())?;
    let process = processes
        .get(&session_id)
        .ok_or_else(|| format!("Terminal session {session_id} is not running"))?;
    process
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn kill_terminal(
    session_id: String,
    terminal_state: State<'_, TerminalState>,
) -> Result<(), String> {
    // Record this session as intentionally killed *before* removing it, so the
    // reader thread's exit handler emits KILLED_EXIT_CODE instead of treating
    // the reap as a crash (which would surface as "failed" and trigger retries).
    if let Ok(mut killed) = terminal_state.killed.lock() {
        killed.insert(session_id.clone());
    }
    let mut processes = terminal_state.processes.lock().map_err(|error| error.to_string())?;
    if let Some(mut process) = processes.remove(&session_id) {
        process.child.kill().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn kill_all_terminals(terminal_state: State<'_, TerminalState>) -> Result<(), String> {
    // Mark every session as intentionally killed, then kill them. Used on app
    // quit (to reap child processes deterministically) and on frontend reload
    // reconciliation (to clean up orphans the new frontend won't reattach to).
    let processes: Vec<(String, TerminalProcess)> = {
        let mut map = terminal_state
            .processes
            .lock()
            .map_err(|error| error.to_string())?;
        if let Ok(mut killed) = terminal_state.killed.lock() {
            for id in map.keys() {
                killed.insert(id.clone());
            }
        }
        map.drain().collect()
    };
    for (_, mut process) in processes {
        let _ = process.child.kill();
    }
    Ok(())
}

#[tauri::command]
fn open_external(target: String) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("Nothing was provided to open.".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        command.arg(&target);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&target);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&target);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open '{target}': {error}"))
}

#[tauri::command]
async fn open_browser_webview(request: BrowserWebviewRequest, app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview(&request.label) {
        existing.close().map_err(|error| error.to_string())?;
    }

    let url = Url::parse(&request.url).map_err(|error| format!("Invalid browser URL: {error}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window was not found".to_string())?;
    let builder = WebviewBuilder::new(&request.label, WebviewUrl::External(url))
        .devtools(true)
        .initialization_script(
            r#"
            (() => {
              const muteMedia = (root = document) => {
                root.querySelectorAll?.("audio, video").forEach((media) => {
                  media.muted = true;
                  media.volume = 0;
                });
              };
              document.addEventListener("play", (event) => {
                if (event.target instanceof HTMLMediaElement) {
                  event.target.muted = true;
                  event.target.volume = 0;
                }
              }, true);
              document.addEventListener("DOMContentLoaded", () => {
                muteMedia();
                new MutationObserver((records) => {
                  records.forEach((record) => record.addedNodes.forEach((node) => {
                    if (node instanceof Element) {
                      if (node instanceof HTMLMediaElement) {
                        node.muted = true;
                        node.volume = 0;
                      }
                      muteMedia(node);
                    }
                  }));
                }).observe(document.documentElement, { childList: true, subtree: true });
              });
              const NativeAudio = window.Audio;
              if (NativeAudio) {
                window.Audio = function(...args) {
                  const audio = new NativeAudio(...args);
                  audio.muted = true;
                  audio.volume = 0;
                  return audio;
                };
                window.Audio.prototype = NativeAudio.prototype;
              }
              for (const key of ["AudioContext", "webkitAudioContext"]) {
                const NativeContext = window[key];
                if (!NativeContext) continue;
                window[key] = function(...args) {
                  const context = new NativeContext(...args);
                  context.suspend?.();
                  return context;
                };
                window[key].prototype = NativeContext.prototype;
              }
            })();
            "#,
        )
        .zoom_hotkeys_enabled(true);

    window
        .add_child(
            builder,
            LogicalPosition::new(request.x, request.y),
            LogicalSize::new(request.width.max(1.0), request.height.max(1.0)),
        )
        .map(|_| ())
        .map_err(|error| format!("Could not create browser webview: {error}"))
}

#[tauri::command]
fn navigate_browser_webview(label: String, url: String, app: AppHandle) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Browser webview '{label}' was not found"))?;
    let url = Url::parse(&url).map_err(|error| format!("Invalid browser URL: {error}"))?;
    webview.navigate(url).map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_browser_webview(
    label: String,
    bounds: BrowserBounds,
    app: AppHandle,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Browser webview '{label}' was not found"))?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| error.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn close_browser_webview(label: String, app: AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_browser_webview_visibility(label: String, visible: bool, app: AppHandle) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Browser webview '{label}' was not found"))?;
    if visible {
        webview.show().map_err(|error| error.to_string())
    } else {
        webview.hide().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn browser_webview_action(label: String, action: String, app: AppHandle) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Browser webview '{label}' was not found"))?;
    match action.as_str() {
        "back" => webview.eval("history.back()").map_err(|error| error.to_string()),
        "forward" => webview.eval("history.forward()").map_err(|error| error.to_string()),
        "reload" => webview.reload().map_err(|error| error.to_string()),
        "devtools" => {
            webview.open_devtools();
            Ok(())
        }
        _ => Err(format!("Unknown browser action '{action}'")),
    }
}

#[tauri::command]
fn capture_annotation(payload: AnnotationPayload, app: AppHandle) -> Result<(), String> {
    if let Some(main_webview) = app.get_webview("main") {
        let _ = main_webview.set_focus();
    }
    app.emit("browser-annotation", payload).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_annotation_mode(
    webview_label: String,
    enabled: bool,
    app: AppHandle,
) -> Result<(), String> {
    let webview = app
        .get_webview(&webview_label)
        .ok_or_else(|| format!("Browser webview '{webview_label}' was not found"))?;
    let enabled_literal = if enabled { "true" } else { "false" };
    let script = format!(
        r##"
        (() => {{
          const KEY = "__byocliAnnotation";
          const prior = window[KEY];
          if (prior?.cleanup) prior.cleanup();
          if (!{enabled_literal}) return;

          const style = document.createElement("style");
          style.dataset.byocliAnnotation = "true";
          style.textContent = `
            [data-byocli-hover] {{ outline: 2px solid #17f5c1 !important; outline-offset: 2px !important; cursor: crosshair !important; }}
          `;
          document.documentElement.appendChild(style);

          let hovered = null;
          const cssPath = (element) => {{
            if (!(element instanceof Element)) return "";
            const path = [];
            while (element && element.nodeType === Node.ELEMENT_NODE && element !== document.body) {{
              let selector = element.nodeName.toLowerCase();
              if (element.id) {{
                selector += "#" + CSS.escape(element.id);
                path.unshift(selector);
                break;
              }}
              const siblings = element.parentNode ? [...element.parentNode.children].filter(el => el.nodeName === element.nodeName) : [];
              if (siblings.length > 1) selector += `:nth-of-type(${{siblings.indexOf(element) + 1}})`;
              path.unshift(selector);
              element = element.parentElement;
            }}
            return path.join(" > ");
          }};
          const xpath = (element) => {{
            const segments = [];
            while (element && element.nodeType === Node.ELEMENT_NODE) {{
              let index = 1;
              let sibling = element.previousElementSibling;
              while (sibling) {{
                if (sibling.nodeName === element.nodeName) index++;
                sibling = sibling.previousElementSibling;
              }}
              segments.unshift(`${{element.nodeName.toLowerCase()}}[${{index}}]`);
              element = element.parentElement;
            }}
            return "/" + segments.join("/");
          }};
          const over = (event) => {{
            hovered?.removeAttribute("data-byocli-hover");
            hovered = event.target;
            hovered?.setAttribute("data-byocli-hover", "");
          }};
          const click = async (event) => {{
            event.preventDefault();
            event.stopPropagation();
            const element = event.target;
            const rect = element.getBoundingClientRect();
            const payload = {{
              url: location.href,
              tag: element.tagName,
              text: (window.getSelection()?.toString().trim() || element.innerText || element.textContent || "").trim().slice(0, 500),
              selector: cssPath(element),
              xpath: xpath(element),
              bounds: {{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }},
              nearbyText: (element.parentElement?.innerText || "").trim().slice(0, 700)
            }};
            if (window.__TAURI_INTERNALS__?.invoke) {{
              await window.__TAURI_INTERNALS__.invoke("capture_annotation", {{ payload }});
            }}
          }};
          document.addEventListener("mouseover", over, true);
          document.addEventListener("click", click, true);
          window[KEY] = {{
            cleanup() {{
              hovered?.removeAttribute("data-byocli-hover");
              style.remove();
              document.removeEventListener("mouseover", over, true);
              document.removeEventListener("click", click, true);
            }}
          }};
        }})();
        "##
    );
    webview.eval(&script).map_err(|error| error.to_string())
}

pub fn run() {
    attach_hidden_console();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(TerminalState::default())
        .setup(|app| {
            let database = open_database(app.handle())?;
            app.manage(DatabaseState {
                connection: Mutex::new(database),
            });

            // Start the localhost file server before any webview might need it.
            // Always register the port as managed state (even 0 on failure) so
            // the get_local_file_server_port command never throws; the frontend
            // treats 0 as "server unavailable" and falls back to open_external.
            match start_local_file_server() {
                Ok(port) => {
                    let _ = LOCAL_FILE_PORT.set(port);
                    app.manage(LocalFileServerPort(port));
                }
                Err(err) => {
                    eprintln!("Local file server failed to start: {err}");
                    app.manage(LocalFileServerPort(0));
                }
            }

            let open_item = MenuItem::with_id(app, "open", "Open BYOCLI", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit BYOCLI", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("BYOCLI automations")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        // Drain tracked PTY children before exiting so we don't
                        // orphan ConPTY processes on Windows. Best-effort: a kill
                        // failure shouldn't block quit.
                        if let Some(terminal_state) = app.try_state::<TerminalState>() {
                            let _ = kill_all_terminals(terminal_state);
                        }
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            let scheduler_app = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(15));
                let _ = scheduler_app.emit("automation-tick", ());
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_app_state,
            save_app_state,
            get_automation_temp_directory,
            get_local_file_server_port,
            get_running_terminal_session_ids,
            spawn_terminal,
            write_terminal,
            resize_terminal,
            kill_terminal,
            kill_all_terminals,
            open_external,
            list_workspace_directory,
            open_browser_webview,
            navigate_browser_webview,
            resize_browser_webview,
            close_browser_webview,
            set_browser_webview_visibility,
            browser_webview_action,
            capture_annotation,
            set_annotation_mode
        ])
        .run(tauri::generate_context!())
        .expect("error while running BYOCLI");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// Helper: assert that a kind slice contains the given name.
    fn names_for_kind(entries: &[FileTreeEntry], kind: &str) -> Vec<String> {
        entries
            .iter()
            .filter(|e| e.kind == kind)
            .map(|e| e.name.clone())
            .collect()
    }

    #[test]
    fn canonical_path_allows_inside_workspace() {
        let root = tempdir().unwrap();
        let inner = root.path().join("subdir");
        fs::create_dir_all(&inner).unwrap();
        let (canonical_root, canonical_inner) =
            canonical_workspace_path(root.path(), &inner).expect("inner dir is inside root");
        assert!(canonical_inner.starts_with(&canonical_root));
    }

    #[test]
    fn canonical_path_rejects_outside_workspace() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let err = canonical_workspace_path(root.path(), outside.path()).unwrap_err();
        assert!(
            err.contains("outside the workspace"),
            "expected sandbox-escape message, got: {err}"
        );
    }

    #[test]
    fn canonical_path_rejects_missing_root() {
        let ghost = tempdir().unwrap();
        let ghost_path = ghost.path().to_path_buf();
        drop(ghost); // delete it
        let err = canonical_workspace_path(&ghost_path, &ghost_path).unwrap_err();
        assert!(err.contains("Could not access"));
    }

    #[test]
    fn read_directory_lists_files_and_directories() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("readme.md"), "hi").unwrap();
        fs::create_dir_all(root.path().join("src")).unwrap();
        fs::write(root.path().join("src").join("main.rs"), "fn main(){}").unwrap();

        let listing = read_workspace_directory(
            root.path().to_string_lossy().to_string(),
            String::new(),
        )
        .expect("listing succeeds");

        let dirs = names_for_kind(&listing.entries, "directory");
        let files = names_for_kind(&listing.entries, "file");
        assert!(dirs.contains(&"src".to_string()));
        assert!(files.contains(&"readme.md".to_string()));
        // Non-recursive: src/main.rs is not at the top level.
        assert!(!files.contains(&"main.rs".to_string()));
        assert!(!listing.truncated);
    }

    #[test]
    fn read_directory_sorts_directories_before_files_case_insensitively() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("zeta.txt"), "").unwrap();
        fs::create_dir_all(root.path().join("ALPHA")).unwrap();
        fs::write(root.path().join("beta.txt"), "").unwrap();
        fs::create_dir_all(root.path().join("gamma")).unwrap();

        let listing = read_workspace_directory(
            root.path().to_string_lossy().to_string(),
            String::new(),
        )
        .unwrap();

        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        let dir_idx_alpha = names.iter().position(|n| *n == "ALPHA").unwrap();
        let dir_idx_gamma = names.iter().position(|n| *n == "gamma").unwrap();
        let file_idx_beta = names.iter().position(|n| *n == "beta.txt").unwrap();
        let file_idx_zeta = names.iter().position(|n| *n == "zeta.txt").unwrap();
        // All directories come before all files.
        assert!(dir_idx_alpha < file_idx_beta);
        assert!(dir_idx_gamma < file_idx_beta);
        // Within each kind, case-insensitive alphabetical.
        assert!(dir_idx_alpha < dir_idx_gamma); // ALPHA < gamma (case-insensitive)
        assert!(file_idx_beta < file_idx_zeta); // beta < zeta
    }

    #[test]
    fn read_directory_truncates_at_500_entries() {
        let root = tempdir().unwrap();
        for i in 0..600 {
            fs::write(root.path().join(format!("file_{i:03}.txt")), "").unwrap();
        }
        let listing = read_workspace_directory(
            root.path().to_string_lossy().to_string(),
            String::new(),
        )
        .unwrap();
        assert_eq!(listing.entries.len(), 500);
        assert!(listing.truncated);
    }

    #[test]
    fn read_directory_rejects_path_outside_workspace() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let err = read_workspace_directory(
            root.path().to_string_lossy().to_string(),
            outside.path().to_string_lossy().to_string(),
        )
        .unwrap_err();
        assert!(err.contains("outside the workspace"));
    }

    #[test]
    fn read_directory_rejects_file_as_path() {
        let root = tempdir().unwrap();
        let file_path = root.path().join("notadir.txt");
        fs::write(&file_path, "").unwrap();
        let err = read_workspace_directory(
            root.path().to_string_lossy().to_string(),
            file_path.to_string_lossy().to_string(),
        )
        .unwrap_err();
        assert!(err.contains("not a directory"));
    }

    #[cfg(unix)]
    #[test]
    fn read_directory_skips_symlinks_pointing_outside_workspace() {
        // A symlink inside the root that points outside must be skipped, not
        // listed — it's a potential sandbox escape. Unix-only: creating
        // symlinks on Windows requires elevated privileges.
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "shh").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            root.path().join("escape"),
        )
        .unwrap();
        let listing = read_workspace_directory(
            root.path().to_string_lossy().to_string(),
            String::new(),
        )
        .unwrap();
        assert!(
            !listing.entries.iter().any(|e| e.name == "escape"),
            "symlink escaping the workspace must not be listed"
        );
    }
}

