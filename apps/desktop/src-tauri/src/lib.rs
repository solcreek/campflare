//! The desktop shell: one window showing apps/web. The web app talks to the
//! Campflare server itself (fetch and WebSocket from the webview), so the
//! shell only adds what a browser tab would do differently: links open in the
//! system browser, the session lives in the OS keychain or, without one, a
//! private file (`session.rs`), and signing in through the browser comes back
//! to a loopback listener (`oauth.rs`). `campflare://` links (permalinks
//! for the app) are handed to the web app as they come, which decides what they
//! mean (apps/web/src/deep-link.ts).

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
    let builder = tauri::Builder::default();
    // Windows and Linux open a link by starting the app with it as the only
    // argument. A second launch hands its arguments to the running app (the
    // deep-link feature passes them on to that plugin) and exits; the running
    // one brings its window forward. macOS sends the link to the running app.
    // First, so a second launch exits before anything else starts.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));
    builder
        // The link the app was started with (getCurrent) and those that come later (onOpenUrl).
        .plugin(tauri_plugin_deep_link::init())
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
            // Installers register the scheme (Info.plist, the registry, the .desktop
            // file); an AppImage isn't installed, so it registers itself when run.
            #[cfg(target_os = "linux")]
            if std::env::var_os("APPIMAGE").is_some() {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
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
