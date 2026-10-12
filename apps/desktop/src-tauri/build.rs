/// The app's own commands. Listing them makes tauri-build generate
/// `allow-<command>` permissions, so a window may call only what its
/// capability grants (capabilities/default.json).
const COMMANDS: &[&str] = &["session_load", "session_save", "session_clear"];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
