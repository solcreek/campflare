//! The desktop shell: one window showing apps/web. The web app talks to the
//! Campflare server itself (fetch and WebSocket from the webview), so the
//! shell only adds what a browser tab would do differently: links open in the
//! system browser, the session lives in the OS keychain or, without one, a
//! private file (`session.rs`), and signing in through the browser comes back
//! to a loopback listener (`oauth.rs`).

mod oauth;
mod session;

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Links to other origins open in the system browser, not inside the app.
const OPEN_LINKS_OUTSIDE: &str = r#"
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null
  if (!link) return
  const url = new URL(link.href, location.href)
  if (url.origin === location.origin || !/^(https?|mailto):$/.test(url.protocol)) return
  event.preventDefault()
  window.__TAURI__.opener.openUrl(url.href)
}, true)
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(oauth::OAuthState::default())
        .invoke_handler(tauri::generate_handler![
            session::session_load,
            session::session_save,
            session::session_clear,
            oauth::oauth_listen,
            oauth::oauth_wait,
            oauth::oauth_cancel
        ])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Campflare")
                .inner_size(1200.0, 800.0)
                .min_inner_size(720.0, 480.0)
                .initialization_script(OPEN_LINKS_OUTSIDE)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Campflare desktop app");
}
