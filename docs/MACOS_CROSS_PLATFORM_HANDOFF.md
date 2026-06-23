# BYOCLI macOS and Cross-Platform Handoff

Prepared June 22, 2026.

## Purpose

This guide is for continuing BYOCLI development on macOS without weakening or replacing the existing Windows behavior.

BYOCLI's core architecture is already suitable for macOS and Linux:

- Tauri provides the native application shell.
- `portable-pty` provides native pseudoterminals.
- React and xterm.js render the shared interface.
- SQLite stores application state.
- Rust owns native processes, filesystem access, temporary directories, external URL opening, the tray, and embedded browser webviews.

The main portability gap is not Tauri itself. It is that several frontend paths currently assume PowerShell, Windows paths, and Windows terminology. The recommended fix is a small native platform abstraction: Rust detects capabilities once, then the frontend consumes structured values instead of guessing the operating system or hardcoding executable names.

## Guiding rules

1. Keep one shared product and state model. Do not fork the application into Windows and macOS implementations.
2. Put OS detection and executable resolution in Rust, not React.
3. Store semantic intent in persisted state. Store `profileId: "shell"` rather than treating `powershell.exe` as the identity of a shell.
4. Resolve commands at launch time. Do not persist absolute paths to globally installed CLI tools unless a user explicitly overrides one.
5. Use `PathBuf`, Tauri path APIs, and native temporary/configuration directories. Never compose OS paths with string separators.
6. Use small `#[cfg(...)]` branches behind shared Rust functions.
7. Preserve existing Windows profile IDs and behavior so saved Windows workspaces continue to restore.
8. Treat browser annotation, tray behavior, process signals, and GUI `PATH` discovery as platform capabilities that require real-device testing.

## Current portability hotspots

The following locations should be addressed first:

| Area | Current assumption | Location |
| --- | --- | --- |
| Built-in shell | `powershell.exe` and the label `PowerShell` | `src/lib/defaults.ts` |
| Automation execution | Always starts non-interactive PowerShell | `src/App.tsx` |
| Quick Commands | Always creates a PowerShell tab | `src/App.tsx` and `README.md` |
| Empty/default state | Contains a developer-specific Windows path | `src/lib/defaults.ts` |
| Browser-only fallback | Returns a Windows workspace and guesses OS from the user agent | `src/lib/platform.ts` |
| Demo terminal text | Contains Windows paths and PowerShell prompts | `src/components/TerminalPane.tsx` |
| UI language | Refers to isolated PowerShell processes | `src/components/AutomationsView.tsx` |
| Dev cleanup | Uses a PowerShell-only cleanup script | `package.json`, `scripts/byocli-tauri.mjs`, and `scripts/stop-byocli-dev.ps1` |
| Shortcut labels | Displays `Ctrl` even though handlers already accept Command | `src/components/Sidebar.tsx` and related UI |
| Tray artwork | Reuses the application icon | `src-tauri/src/lib.rs` |

Some native code is already correctly portable:

- `get_automation_temp_directory` uses `std::env::temp_dir()`.
- `open_external` selects `explorer.exe`, `open`, or `xdg-open` with compile-time OS branches.
- Windows npm shim handling is contained in a `#[cfg(windows)]` branch.
- The non-Windows PTY path already starts the requested executable directly.
- SQLite uses Tauri's native configuration directory.

## Recommended platform contract

Add one native command such as `get_platform_info`. Call it during application bootstrap and keep the result in application state or a React context.

The frontend should not use `navigator.userAgent`, `process.platform`, path separator checks, or hardcoded shell executables for native behavior.

Suggested shared shape:

```ts
export type PlatformInfo = {
  os: "windows" | "macos" | "linux";
  arch: string;
  displayName: string;
  primaryModifier: "Ctrl" | "Command";
  primaryModifierSymbol: "Ctrl" | "⌘";
  defaultShell: {
    name: string;
    command: string;
    args: string[];
    automationArgsPrefix: string[];
  };
  homeDirectory: string;
  tempDirectory: string;
  configDirectory: string;
  pathSeparator: "/" | "\\";
  supportsTray: boolean;
  supportsBrowserDevtools: boolean;
};
```

The `pathSeparator` can help with display-only behavior, but filesystem operations should still use native APIs rather than manually joining strings.

Suggested Rust model:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellSpec {
    name: String,
    command: String,
    args: Vec<String>,
    automation_args_prefix: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: &'static str,
    arch: String,
    display_name: &'static str,
    primary_modifier: &'static str,
    primary_modifier_symbol: &'static str,
    default_shell: ShellSpec,
    home_directory: String,
    temp_directory: String,
    config_directory: String,
    path_separator: &'static str,
    supports_tray: bool,
    supports_browser_devtools: bool,
}
```

Create private Rust helpers such as:

```rust
fn platform_info(app: &tauri::AppHandle) -> Result<PlatformInfo, String>;
fn default_shell() -> ShellSpec;
fn resolve_executable(command: &str) -> Result<PathBuf, String>;
fn automation_command(shell: &ShellSpec, command: &str) -> (String, Vec<String>);
```

Keep all compile-time branching inside those helpers:

```rust
#[cfg(target_os = "windows")]
fn default_shell() -> ShellSpec {
    ShellSpec {
        name: "PowerShell".into(),
        command: "powershell.exe".into(),
        args: vec!["-NoLogo".into()],
        automation_args_prefix: vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
        ],
    }
}

#[cfg(target_os = "macos")]
fn default_shell() -> ShellSpec {
    let command = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    ShellSpec {
        name: shell_display_name(&command),
        command,
        args: vec!["-l".into()],
        automation_args_prefix: vec!["-lc".into()],
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_shell() -> ShellSpec {
    let command = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    ShellSpec {
        name: shell_display_name(&command),
        command,
        args: vec!["-l".into()],
        automation_args_prefix: vec!["-lc".into()],
    }
}
```

These are fallback values, not hardcoded product configuration. `$SHELL` remains the source of truth on Unix, and user profile overrides should take precedence.

## Shell and profile migration

Keep the built-in profile ID `shell`. Change its name, command, and arguments at runtime from `PlatformInfo.defaultShell`.

Do not rename the profile ID to `powershell`, `zsh`, or `bash`. Existing saved sessions use `profileId: "shell"`, and that semantic ID is what allows one persisted model to work across machines.

Recommended startup sequence:

1. Load `PlatformInfo`.
2. Load persisted app state.
3. Build the platform's built-in profiles.
4. Merge user-edited profiles into those built-ins.
5. Normalize restored sessions.
6. Launch a restored `shell` session using the current machine's shell specification.

Important migration behavior:

- A workspace created on Windows with `profileId: "shell"` should open as zsh on a Mac.
- A custom user profile explicitly configured as `pwsh` should remain `pwsh` if that executable is installed.
- CLI agent profiles such as `claude`, `codex`, and `omp` should retain their semantic IDs and resolve their executable dynamically on every machine.
- Do not save a resolved path such as `/opt/homebrew/bin/claude` over the user's portable command value `claude`.

## Command resolution and the macOS GUI environment

Applications opened from Finder do not always receive the same `PATH` as an interactive terminal. A CLI may work in Terminal but appear missing to BYOCLI.

Implement executable discovery in Rust and return diagnostic information to the UI. A practical search order is:

1. An explicit path configured by the user.
2. The process `PATH`.
3. Directories returned by a login shell.
4. Common package-manager and user executable directories.

The login-shell environment should be discovered dynamically. For example, run the selected Unix shell as a login shell and capture its environment, rather than assuming Homebrew is installed in one fixed directory.

Cache the resulting environment for the application session and offer a **Refresh CLI environment** action in Settings. Show the resolved command path in profile diagnostics, but keep it out of portable saved profile definitions.

On Windows, retain the existing `.exe`, `.com`, `.cmd`, and `.bat` resolution and the `cmd.exe /D /S /C` wrapper for command shims.

## Automations and Quick Commands

Move shell command construction into Rust. The frontend should send:

```ts
{
  sessionId,
  cwd,
  commandText: automation.command,
  executionMode: "shell-command"
}
```

Rust should translate this semantic request:

- Windows PowerShell: `powershell.exe ... -Command <command>`
- macOS zsh: `$SHELL -lc <command>`
- Linux shell: `$SHELL -lc <command>`

For interactive terminal tabs, use the shell's normal startup arguments. For automations, use the non-interactive command prefix. Keeping those two modes separate avoids shell initialization scripts unexpectedly changing scheduled execution.

Update UI copy from “PowerShell tab/process” to “shell tab/process.”

Quick Commands should continue to create a `shell` session. The current platform contract determines which shell that means.

## First-run behavior and paths

Remove the developer-specific workspace from `createDefaultState`.

Preferred first-run state:

- No workspace is selected.
- The main view presents **Open workspace**.
- The native folder picker supplies the first path.

If a default directory is required, ask Rust for the user's home directory through Tauri's path resolver. Do not construct `/Users/<name>`, `C:\Users\<name>`, or `/home/<name>`.

Keep using `std::env::temp_dir()` for BYOCLI Temp. Use Tauri's app config/data directories for persistent state. Use `PathBuf::join` for every native path operation.

Browser-only development fallbacks should use neutral fixture values or an injected mock `PlatformInfo`; they should not pretend to be a specific real machine.

## Embedded browser and annotations

The embedded browser uses the OS webview:

- Windows: WebView2
- macOS: WKWebView
- Linux: WebKitGTK

Validate these behaviors on macOS rather than assuming WebView2 parity:

- Creating, closing, hiding, and resizing child webviews.
- Multiple browser tabs and active-tab visibility.
- Navigating localhost HTTP and HTTPS URLs.
- Back, forward, and reload actions.
- DOM annotation script injection.
- Annotation payload delivery from a remote webview to the main application.
- Browser link interception from xterm.
- Focus return to the active terminal after sending annotations.
- Browser mute behavior.

Treat DevTools as a capability. Tauri documents restrictions around using private macOS DevTools APIs in production/App Store builds. Hide or disable the control when the current build/platform does not support it.

Do not loosen the remote capability broadly to fix a macOS-only issue. Keep annotation IPC scoped to the `browser-*` webviews and explicitly allowed URL patterns.

## Tray, Dock, and window behavior

The rounded application icon already generates `icon.icns` for macOS.

For the macOS menu bar, create a separate transparent, monochrome template icon rather than reusing the full-color application icon. Mark it as a template image on macOS so the system can render it correctly in light and dark menu bars. Keep the current application icon for the Dock and application bundle.

Linux trays vary by desktop environment. The application should continue functioning if no tray is available. If automations depend on remaining alive after the window closes, expose the current background state clearly and test the close/quit behavior on every supported platform.

Consider platform-specific Tauri configuration files only for genuine bundle or window differences:

- `src-tauri/tauri.macos.conf.json`
- `src-tauri/tauri.windows.conf.json`
- `src-tauri/tauri.linux.conf.json`

Tauri merges these into the shared configuration, avoiding runtime conditionals for packaging-only values.

## Development scripts

Replace the PowerShell-only development cleanup path with a cross-platform Node script.

The script should:

- Check whether port 1420 belongs to this BYOCLI workspace.
- Stop only BYOCLI-owned Vite/Tauri development processes.
- Avoid killing unrelated Node, Cargo, or Rust processes.
- Work with Windows process APIs and Unix process groups behind small platform-specific functions.
- Continue using `process.platform` inside this development-only Node adapter; do not expose it as application runtime state.

Avoid shell-dependent npm scripts when a small Node entry point can perform the same task.

## Keyboard and typography polish

The keyboard handlers already accept `ctrlKey || metaKey`. Render shortcut labels dynamically:

- Windows/Linux: `Ctrl K`, `Ctrl N`, `Ctrl B`
- macOS: `⌘K`, `⌘N`, `⌘B`

The terminal font stack will fall back safely, but visual consistency would improve by bundling an appropriately licensed monospace font or adding macOS/Linux-native fallbacks.

## macOS setup

On the Mac:

1. Install current Tauri prerequisites, Rust, Node.js, and npm.
2. Clone the repository and run `npm install`.
3. Run `npm run build` and `cargo check --manifest-path src-tauri/Cargo.toml`.
4. Run `npm run tauri dev`.
5. Test first with a clean BYOCLI config directory, then with copied Windows state to validate migration.
6. Build an application bundle with:

   ```bash
   npm run tauri build -- --bundles app
   ```

7. Test both Apple Silicon and Intel behavior. Prefer CI builds for both targets; produce a universal bundle only if distribution requirements justify it.

For public distribution outside the App Store, configure a Developer ID Application certificate and Apple notarization. Keep signing credentials in the macOS keychain or CI secrets, never in the repository.

## Suggested implementation order

### Phase 1: Platform foundation

- Add `PlatformInfo` and a native `get_platform_info` command.
- Replace the hardcoded built-in shell with the native shell specification.
- Remove hardcoded default workspace and demo paths.
- Render platform-aware shortcut labels.
- Keep all existing Windows regression tests green.

### Phase 2: Process execution

- Add semantic interactive-shell and shell-command launch modes.
- Move automation command construction into Rust.
- Add login-shell environment discovery and executable diagnostics.
- Test npm-installed CLI shims on Windows and Unix executables on macOS.

### Phase 3: Native UI validation

- Test WKWebView browser tabs and annotation transport.
- Add the macOS tray template icon.
- Gate DevTools by platform/build capability.
- Validate Dock, hide, close, reopen, quit, and scheduler behavior.

### Phase 4: Build and release

- Add a GitHub Actions matrix for Windows, macOS, and Linux.
- Build on each native operating system rather than treating cross-compilation as the primary release path.
- Add macOS signing and notarization.
- Add Linux packages and dependency documentation.
- Publish platform-specific artifacts with consistent versioning.

## Required regression checklist

Before merging cross-platform changes, verify:

- Existing Windows state loads without data loss.
- Windows still launches PowerShell and npm `.cmd` shims.
- A Windows `shell` session restores as PowerShell.
- A copied `shell` session restores as zsh on macOS without changing its profile ID.
- Claude Code, Codex CLI, Gemini CLI, OMP, Aider, OpenCode, and Goose either launch or display a useful executable-resolution error.
- Agent resume commands remain profile-specific and usable after restart.
- Quick Commands run in the current platform shell.
- Workspace and temp-scoped automations execute, time out, retry, and record output.
- Paths containing spaces and Unicode characters work.
- PTY input, resize, exit, kill, and restored-terminal focus work.
- Browser tabs, annotations, file tree traversal, and external links work.
- The app can reopen from the tray/menu bar and quit completely.
- App state remains isolated in the native BYOCLI configuration directory.

## Completion criteria

The cross-platform foundation is complete when React contains no production hardcoding for PowerShell, Windows user paths, OS temporary paths, or native executable resolution; Windows behavior remains unchanged; and the same saved semantic state can launch with the correct native shell on Windows, macOS, or Linux.

## Current Tauri references

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri platform-specific configuration](https://v2.tauri.app/reference/config/)
- [macOS application bundles](https://v2.tauri.app/distribute/macos-application-bundle/)
- [macOS code signing and notarization](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri distribution overview](https://v2.tauri.app/distribute/)

