use byocli_lib::start_local_file_server;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;
use tempfile::NamedTempFile;

/// Helper: send an HTTP/1.0 request to a host:port and return the full response.
fn http_get(host: &str, port: u16, path: &str) -> String {
    let addr = format!("{host}:{port}");
    let mut stream = TcpStream::connect_timeout(
        &addr.parse().expect("valid addr"),
        Duration::from_secs(2),
    )
    .expect("connect to server");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[test]
fn server_starts_and_serves_an_html_file() {
    // Write a temp HTML file.
    let mut tmp = NamedTempFile::with_suffix(".html").unwrap();
    let html = "<!doctype html><html><body><h1>Hello BYOCLI</h1></body></html>";
    tmp.write_all(html.as_bytes()).unwrap();
    tmp.flush().unwrap();
    let path = tmp.path().to_string_lossy().replace('\\', "/");

    let port = start_local_file_server().expect("server starts");
    assert!(port > 0);

    // The server expects the URL path to be the filesystem path. On Windows
    // that's `/C:/Users/.../file.html` (leading slash + drive).
    let url_path = format!("/{path}");
    let response = http_get("127.0.0.1", port, &url_path);

    assert!(response.starts_with("HTTP/1.1 200"), "expected 200, got: {}", &response[..response.len().min(80)]);
    assert!(response.contains("Content-Type: text/html"), "missing html content-type");
    assert!(response.contains("Hello BYOCLI"), "body missing the file content");
}

#[test]
fn server_returns_404_for_missing_file() {
    let port = start_local_file_server().expect("server starts");
    let response = http_get("127.0.0.1", port, "/C:/this/path/does/not/exist.html");
    assert!(response.starts_with("HTTP/1.1 404"), "expected 404, got: {}", &response[..response.len().min(80)]);
}

/// Regression: WebView2 injects a `?/` sandbox prefix into the path even for
/// localhost URLs. The raw request line is `GET /?/C:/Users/.../index.html`.
/// The server must strip both the leading slash AND the `?/` to recover the
/// real filesystem path. Without this fix the file 404s.
#[test]
fn server_strips_webview2_sandbox_prefix() {
    let mut tmp = NamedTempFile::with_suffix(".html").unwrap();
    let html = "<!doctype html><body>prefix test</body>";
    tmp.write_all(html.as_bytes()).unwrap();
    tmp.flush().unwrap();
    let path = tmp.path().to_string_lossy().replace('\\', "/");

    let port = start_local_file_server().expect("server starts");

    // The exact form WebView2 sends: leading slash + literal `?/` + path.
    let url_path = format!("/?/{path}");
    let response = http_get("127.0.0.1", port, &url_path);

    assert!(
        response.starts_with("HTTP/1.1 200"),
        "sandbox-prefixed path should serve the file, got: {}",
        &response[..response.len().min(120)]
    );
    assert!(response.contains("prefix test"), "body missing file content");
}

/// Some webviews percent-encode the `?` as `%3F`. Cover that form too.
#[test]
fn server_strips_percent_encoded_sandbox_prefix() {
    let mut tmp = NamedTempFile::with_suffix(".html").unwrap();
    let html = "<!doctype html><body>encoded prefix</body>";
    tmp.write_all(html.as_bytes()).unwrap();
    tmp.flush().unwrap();
    let path = tmp.path().to_string_lossy().replace('\\', "/");

    let port = start_local_file_server().expect("server starts");

    let url_path = format!("/%3F/{path}");
    let response = http_get("127.0.0.1", port, &url_path);

    assert!(
        response.starts_with("HTTP/1.1 200"),
        "percent-encoded sandbox path should serve the file, got: {}",
        &response[..response.len().min(120)]
    );
    assert!(response.contains("encoded prefix"), "body missing file content");
}
