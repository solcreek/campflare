//! Signing in through the system browser. The webview can't be the target of
//! a redirect, so, like the CLI (RFC 8252), the app listens on a free loopback
//! port and the browser comes back to `http://127.0.0.1:<port>/callback` with
//! `?code&state` (or `?error&state`). The web app does the rest: PKCE, the
//! authorize URL, checking the state and redeeming the code.
//!
//! `oauth_listen` binds and returns the port, `oauth_wait` takes the one
//! callback (answering the browser with a page that says to close the tab),
//! and `oauth_cancel` stops a wait. A wait gives up after `TIMEOUT`.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

/// How long the person has to sign in and consent in the browser.
const TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How often a wait looks for the browser, and for a cancel.
const POLL: Duration = Duration::from_millis(50);
/// The most of a request it reads: the request line and headers, nothing more.
const MAX_HEAD: usize = 16 * 1024;

/// The listener between `oauth_listen` and `oauth_wait`, and which sign-in is current.
#[derive(Default)]
pub struct OAuthState {
    listener: Mutex<Option<TcpListener>>,
    /// Bumped by each new listen and by cancel: a wait from an older one stops.
    generation: Arc<AtomicU64>,
}

/// The browser's return, as the query string had it.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn oauth_listen(state: State<'_, OAuthState>) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    // Non-blocking, so a wait can notice a cancel or its deadline between connections.
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.listener.lock().map_err(|e| e.to_string())? = Some(listener);
    Ok(port)
}

#[tauri::command]
pub async fn oauth_wait(state: State<'_, OAuthState>) -> Result<Callback, String> {
    let listener = state
        .listener
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("no sign-in is listening")?;
    let generation = Arc::clone(&state.generation);
    let mine = generation.load(Ordering::SeqCst);
    // Polling blocks: off the async runtime's workers.
    tauri::async_runtime::spawn_blocking(move || {
        wait_for_callback(&listener, Instant::now() + TIMEOUT, || {
            generation.load(Ordering::SeqCst) != mine
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn oauth_cancel(state: State<'_, OAuthState>) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.listener.lock().map_err(|e| e.to_string())?.take();
    Ok(())
}

/// Accepts connections until one is the browser's request to /callback, answering every one.
pub fn wait_for_callback(
    listener: &TcpListener,
    deadline: Instant,
    cancelled: impl Fn() -> bool,
) -> Result<Callback, String> {
    loop {
        if cancelled() {
            return Err("cancelled".into());
        }
        if Instant::now() >= deadline {
            return Err("timed out".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(callback) = answer(stream) {
                    return Ok(callback);
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {
                thread::sleep(POLL)
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Reads one request and answers it: the callback page, or 404 for anything else (a favicon…).
fn answer(mut stream: TcpStream) -> Option<Callback> {
    // Accepted sockets may inherit non-blocking; a slow or silent client must not hang the wait.
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let head = read_head(&mut stream);
    let callback = parse_callback(&head);
    let response = match &callback {
        Some(c) => {
            let message = if c.error.is_some() {
                "Sign-in didn't finish. You can close this tab and return to Campflare."
            } else {
                "Signed in. You can close this tab and return to Campflare."
            };
            let body = format!(
                "<!doctype html><meta charset=\"utf-8\"><title>Campflare</title>\
                 <p style=\"font:16px system-ui;margin:3rem\">{message}</p>"
            );
            format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\n\
                 cache-control: no-store\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
        }
        None => "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into(),
    };
    // The browser may already have gone; the callback counts all the same.
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    callback
}

/// The request line and headers, up to the blank line (or MAX_HEAD bytes, or a timeout).
fn read_head(stream: &mut impl Read) -> String {
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while head.len() < MAX_HEAD && !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    String::from_utf8_lossy(&head).into_owned()
}

/// The callback in a request head: `GET /callback?… HTTP/1.1`. None for any other request.
pub fn parse_callback(head: &str) -> Option<Callback> {
    let line = head.lines().next()?;
    let mut parts = line.split(' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if method != "GET" || !version.starts_with("HTTP/") || parts.next().is_some() {
        return None;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        return None;
    }
    let mut callback = Callback::default();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let slot = match decode(key).as_str() {
            "code" => &mut callback.code,
            "state" => &mut callback.state,
            "error" => &mut callback.error,
            _ => continue,
        };
        // The first value wins, as URLSearchParams.get() would have it.
        slot.get_or_insert_with(|| decode(value));
    }
    Some(callback)
}

/// application/x-www-form-urlencoded: `+` is a space, `%XX` a byte; bytes that aren't UTF-8 become U+FFFD.
pub fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => match (
                bytes.get(i + 1).and_then(hex),
                bytes.get(i + 2).and_then(hex),
            ) {
                (Some(hi), Some(lo)) => {
                    out.push(hi << 4 | lo);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: &u8) -> Option<u8> {
    (*b as char).to_digit(16).map(|d| d as u8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn get(target: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nAccept: text/html\r\n\r\n")
    }

    #[test]
    fn reads_the_code_and_state() {
        assert_eq!(
            parse_callback(&get(
                "/callback?code=abc&state=s1&iss=https%3A%2F%2Fx.test%2Fauth"
            )),
            Some(Callback {
                code: Some("abc".into()),
                state: Some("s1".into()),
                error: None
            })
        );
    }

    #[test]
    fn reads_an_error_and_decodes_every_script() {
        // A state in Chinese, Japanese, Korean and accented Latin, percent-encoded as browsers send it.
        let state = "état-状態-상태-Grüße";
        let encoded: String = state
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b == b'-' {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        let c = parse_callback(&get(&format!(
            "/callback?error=access_denied&error_description=User+denied+access&state={encoded}"
        )))
        .unwrap();
        assert_eq!(c.error.as_deref(), Some("access_denied"));
        assert_eq!(c.state.as_deref(), Some(state));
        assert_eq!(c.code, None);
    }

    #[test]
    fn ignores_other_requests() {
        assert_eq!(parse_callback(&get("/favicon.ico")), None);
        assert_eq!(parse_callback(&get("/callback/x?code=1")), None);
        assert_eq!(
            parse_callback("POST /callback?code=1 HTTP/1.1\r\n\r\n"),
            None
        );
        assert_eq!(parse_callback("GET /callback?code=1\r\n\r\n"), None);
        assert_eq!(parse_callback("GET /callback HTTP/1.1 extra\r\n\r\n"), None);
        assert_eq!(parse_callback(""), None);
        // A callback with nothing in it is still the callback: the web app says what's missing.
        assert_eq!(parse_callback(&get("/callback")), Some(Callback::default()));
    }

    #[test]
    fn keeps_the_first_value_and_skips_unknown_keys() {
        let c = parse_callback(&get("/callback?code=1&code=2&&x=y&state")).unwrap();
        assert_eq!(c.code.as_deref(), Some("1"));
        assert_eq!(c.state.as_deref(), Some(""));
    }

    #[test]
    fn decodes_form_encoding() {
        assert_eq!(decode("a+b%20c"), "a b c");
        assert_eq!(decode("%E6%97%A5%E6%9C%AC"), "日本");
        assert_eq!(decode("100%"), "100%");
        assert_eq!(decode("%zz%4"), "%zz%4");
        assert_eq!(decode("%FF"), "\u{FFFD}");
        assert_eq!(decode("%é"), "%é"); // not hex: kept, and no slicing inside a character
    }

    fn listening() -> (TcpListener, u16) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        (listener, port)
    }

    /// A browser request over real TCP; returns what the listener answered.
    fn browse(port: u16, target: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(get(target).as_bytes()).unwrap();
        let mut answer = String::new();
        s.read_to_string(&mut answer).unwrap();
        answer
    }

    #[test]
    fn answers_the_browser_and_returns_the_callback() {
        let (listener, port) = listening();
        let browser = thread::spawn(move || {
            (
                browse(port, "/favicon.ico"),
                browse(port, "/callback?code=c1&state=s1"),
            )
        });
        let got = wait_for_callback(&listener, Instant::now() + Duration::from_secs(10), || {
            false
        });
        let (favicon, page) = browser.join().unwrap();
        assert!(favicon.starts_with("HTTP/1.1 404"));
        assert!(page.starts_with("HTTP/1.1 200 OK"));
        assert!(page.contains("You can close this tab"));
        assert_eq!(got.unwrap().code.as_deref(), Some("c1"));
    }

    #[test]
    fn tells_the_browser_when_sign_in_failed() {
        let (listener, port) = listening();
        let browser = thread::spawn(move || browse(port, "/callback?error=access_denied&state=s"));
        let got = wait_for_callback(&listener, Instant::now() + Duration::from_secs(10), || {
            false
        });
        assert!(browser.join().unwrap().contains("Sign-in didn't finish"));
        assert_eq!(got.unwrap().error.as_deref(), Some("access_denied"));
    }

    #[test]
    fn gives_up_at_the_deadline_or_on_cancel() {
        let (listener, _) = listening();
        assert_eq!(
            wait_for_callback(&listener, Instant::now(), || false),
            Err("timed out".into())
        );
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        let got = thread::scope(|s| {
            s.spawn(|| {
                thread::sleep(Duration::from_millis(120));
                cancel.store(true, Ordering::SeqCst);
            });
            wait_for_callback(&listener, Instant::now() + Duration::from_secs(10), || {
                cancel.load(Ordering::SeqCst)
            })
        });
        assert_eq!(got, Err("cancelled".into()));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
