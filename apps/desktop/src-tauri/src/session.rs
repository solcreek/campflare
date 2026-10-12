//! The signed-in session (`{url, token}`) in the OS credential store: the
//! macOS Keychain, the Windows Credential Manager, or the Secret Service on
//! Linux. The web app reaches it through the `session_*` commands; a browser
//! tab keeps it in localStorage instead.
//!
//! Some systems have no credential store: a Linux desktop without
//! gnome-keyring or KWallet, a headless session, a CI runner. There the session
//! falls back to a file in the app's config directory that only its owner can
//! read (mode 0600 on Unix), written atomically. The keychain is preferred
//! whenever it works: a load looks there first, and once the keychain works
//! again, the file's session moves into it and the file is deleted.
//! `session_save` tells the web app which one kept the session.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use keyring::{Entry, Error};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

/// The keychain item's service; the same as the app's bundle identifier.
const SERVICE: &str = "com.campflare.desktop";
/// The keychain item's account. One session per installation.
const ACCOUNT: &str = "session";
/// The fallback file's name in the app's config directory.
const FILE_NAME: &str = "session.json";

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub url: String,
    pub token: String,
    /// Whatever else the web app keeps with the session, carried through unread.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Never prints the token, so a stray `{:?}` can't leak it into a log.
impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("url", &self.url)
            .field("token", &"…")
            .field("extra", &self.extra.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// The JSON kept in the credential store (or the file).
pub fn encode(session: &Session) -> String {
    serde_json::to_string(session).expect("strings and JSON values always serialise")
}

/// The session in a stored secret, or None for one that isn't a complete session.
pub fn decode(secret: &str) -> Option<Session> {
    serde_json::from_str::<Session>(secret)
        .ok()
        .filter(|s| !s.url.is_empty() && !s.token.is_empty())
}

/// Where a session was kept: the web app tells the person when it's the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Keychain,
    File,
}

/// Why a store didn't answer.
#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    /// There is no store to ask, or the platform couldn't reach it: use the file.
    Unavailable(String),
    /// The store is there but refused this request.
    Failed(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Unavailable(e) | StoreError::Failed(e) => f.write_str(e),
        }
    }
}

/// One secret, kept somewhere. `get` is None when nothing is kept; `delete`
/// of nothing succeeds.
pub trait SecretStore {
    fn get(&self) -> Result<Option<String>, StoreError>;
    fn set(&self, secret: &str) -> Result<(), StoreError>;
    fn delete(&self) -> Result<(), StoreError>;
}

/// The OS credential store, through the keyring crate.
pub struct Keychain;

impl Keychain {
    fn entry() -> Result<Entry, StoreError> {
        Entry::new(SERVICE, ACCOUNT).map_err(classify)
    }
}

/// "No store / the platform failed" against everything else. NoEntry is
/// handled by each caller: it means the store works and holds nothing.
fn classify(error: Error) -> StoreError {
    match error {
        Error::PlatformFailure(_)
        | Error::NoStorageAccess(_)
        | Error::NoDefaultStore
        | Error::NotSupportedByStore(_) => StoreError::Unavailable(error.to_string()),
        _ => StoreError::Failed(error.to_string()),
    }
}

impl SecretStore for Keychain {
    fn get(&self) -> Result<Option<String>, StoreError> {
        match Self::entry()?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(classify(e)),
        }
    }

    fn set(&self, secret: &str) -> Result<(), StoreError> {
        Self::entry()?.set_password(secret).map_err(classify)
    }

    fn delete(&self) -> Result<(), StoreError> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(classify(e)),
        }
    }
}

/// The fallback: a file only its owner can read, replaced atomically.
pub struct FileStore {
    pub path: PathBuf,
}

impl FileStore {
    fn temp(&self) -> PathBuf {
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(".tmp");
        self.path.with_file_name(name)
    }
}

fn failed(error: std::io::Error) -> StoreError {
    StoreError::Failed(error.to_string())
}

/// The directory (and its parents), private to the owner when it's new.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

impl SecretStore for FileStore {
    fn get(&self) -> Result<Option<String>, StoreError> {
        match fs::read_to_string(&self.path) {
            Ok(secret) => Ok(Some(secret)),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(failed(e)),
        }
    }

    /// Writes a temporary file beside it (created 0600), syncs it, and renames
    /// it over the old one: a reader sees the old session or the new, never half.
    fn set(&self, secret: &str) -> Result<(), StoreError> {
        if let Some(dir) = self.path.parent() {
            create_private_dir(dir).map_err(failed)?;
        }
        let temp = self.temp();
        // A temporary left by a crash may have other permissions: start afresh.
        match fs::remove_file(&temp) {
            Err(e) if e.kind() != ErrorKind::NotFound => return Err(failed(e)),
            _ => {}
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let written = options.open(&temp).and_then(|mut file| {
            file.write_all(secret.as_bytes())?;
            file.sync_all()
        });
        if let Err(e) = written.and_then(|()| fs::rename(&temp, &self.path)) {
            let _ = fs::remove_file(&temp);
            return Err(failed(e));
        }
        // The rename itself survives a crash once the directory is synced (Unix only).
        #[cfg(unix)]
        if let Some(dir) = self.path.parent() {
            let _ = fs::File::open(dir).and_then(|d| d.sync_all());
        }
        Ok(())
    }

    fn delete(&self) -> Result<(), StoreError> {
        match fs::remove_file(&self.path) {
            Err(e) if e.kind() != ErrorKind::NotFound => Err(failed(e)),
            _ => Ok(()),
        }
    }
}

/// The keychain's session; else the file's, moved into the keychain when it works.
pub fn load(keychain: &dyn SecretStore, file: &dyn SecretStore) -> Result<Option<Session>, String> {
    let kept = keychain.get();
    if let Ok(Some(secret)) = &kept
        && let Some(session) = decode(secret)
    {
        // The keychain wins; a file left from before is stale.
        let _ = file.delete();
        return Ok(Some(session));
    }
    let from_file = file
        .get()
        .map_err(|e| e.to_string())?
        .and_then(|s| decode(&s));
    match (kept, from_file) {
        // The keychain works again: move the session into it, keeping the file if that fails.
        (Ok(_), Some(session)) => {
            if keychain.set(&encode(&session)).is_ok() {
                let _ = file.delete();
            }
            Ok(Some(session))
        }
        (Ok(_), None) | (Err(StoreError::Unavailable(_)), None) => Ok(None),
        (Err(_), Some(session)) => Ok(Some(session)),
        (Err(e @ StoreError::Failed(_)), None) => Err(e.to_string()),
    }
}

/// Into the keychain, or the file when there is no keychain to use.
pub fn save(
    keychain: &dyn SecretStore,
    file: &dyn SecretStore,
    session: &Session,
) -> Result<Backend, String> {
    let secret = encode(session);
    match keychain.set(&secret) {
        Ok(()) => {
            // The keychain has it now: a fallback copy would only outlive a sign-out.
            let _ = file.delete();
            Ok(Backend::Keychain)
        }
        Err(StoreError::Unavailable(_)) => {
            file.set(&secret).map_err(|e| e.to_string())?;
            Ok(Backend::File)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Both places. No keychain at all is not a failure to clear.
pub fn clear(keychain: &dyn SecretStore, file: &dyn SecretStore) -> Result<(), String> {
    let from_keychain = match keychain.delete() {
        Err(StoreError::Unavailable(_)) => Ok(()),
        other => other,
    };
    file.delete().and(from_keychain).map_err(|e| e.to_string())
}

/// One session operation at a time: a load moving the file into the keychain
/// must not interleave with a save or a clear.
static LOCK: Mutex<()> = Mutex::new(());

fn with_stores<T>(
    app: &AppHandle,
    run: impl FnOnce(&Keychain, &FileStore) -> Result<T, String>,
) -> Result<T, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let file = FileStore {
        path: dir.join(FILE_NAME),
    };
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    run(&Keychain, &file)
}

// `async` runs them off the main thread: the first Keychain access may wait
// on a permission prompt, and the window must not freeze meanwhile.

#[tauri::command(async)]
pub fn session_load(app: AppHandle) -> Result<Option<Session>, String> {
    with_stores(&app, |keychain, file| load(keychain, file))
}

#[tauri::command(async)]
pub fn session_save(app: AppHandle, session: Session) -> Result<Backend, String> {
    with_stores(&app, |keychain, file| save(keychain, file, &session))
}

#[tauri::command(async)]
pub fn session_clear(app: AppHandle) -> Result<(), String> {
    with_stores(&app, |keychain, file| clear(keychain, file))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn session() -> Session {
        Session {
            url: "https://campflare.example".into(),
            token: "xoxp-1".into(),
            extra: Map::new(),
        }
    }

    #[test]
    fn round_trips_through_json() {
        let json = encode(&session());
        assert_eq!(
            json,
            r#"{"url":"https://campflare.example","token":"xoxp-1"}"#
        );
        assert_eq!(decode(&json), Some(session()));
    }

    #[test]
    fn carries_unknown_fields_through() {
        // Field order doesn't matter; fields the shell doesn't know come back as they were.
        let json =
            r#"{"token":"xoxp-1","via":"token","url":"https://campflare.example","n":{"a":[1]}}"#;
        let decoded = decode(json).unwrap();
        assert_eq!(decoded.url, "https://campflare.example");
        assert_eq!(decoded.extra.get("via"), Some(&Value::from("token")));
        let again: Value = serde_json::from_str(&encode(&decoded)).unwrap();
        assert_eq!(again, serde_json::from_str::<Value>(json).unwrap());
    }

    #[test]
    fn keeps_how_the_session_was_obtained() {
        let mut oauth = session();
        oauth.extra.insert("via".into(), Value::from("oauth"));
        let json = encode(&oauth);
        assert_eq!(
            json,
            r#"{"url":"https://campflare.example","token":"xoxp-1","via":"oauth"}"#
        );
        assert_eq!(decode(&json), Some(oauth));
    }

    #[test]
    fn rejects_incomplete_or_garbled_secrets() {
        for secret in [
            "",
            "{not json",
            "null",
            r#"{"url":"https://campflare.example"}"#,
            r#"{"url":"https://campflare.example","token":""}"#,
            r#"{"url":"","token":"xoxp-1"}"#,
            r#"{"url":"https://campflare.example","token":1}"#,
        ] {
            assert_eq!(decode(secret), None, "{secret}");
        }
    }

    #[test]
    fn debug_hides_the_token() {
        let printed = format!("{:?}", session());
        assert!(printed.contains("campflare.example"));
        assert!(!printed.contains("xoxp-1"));
    }

    #[test]
    fn classifies_keyring_errors() {
        assert!(matches!(
            classify(Error::NoDefaultStore),
            StoreError::Unavailable(_)
        ));
        assert!(matches!(
            classify(Error::NotSupportedByStore("x".into())),
            StoreError::Unavailable(_)
        ));
        assert!(matches!(
            classify(Error::TooLong("x".into(), 1)),
            StoreError::Failed(_)
        ));
        assert!(matches!(
            classify(Error::BadEncoding(vec![0xff])),
            StoreError::Failed(_)
        ));
    }

    /// A fresh directory under the system's temporary one, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let path = std::env::temp_dir().join(format!(
                "campflare-desktop-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&path);
            Self(path)
        }

        /// A file store two directories down, so `set` must create them.
        fn store(&self) -> FileStore {
            FileStore {
                path: self
                    .0
                    .join("config")
                    .join("com.campflare.desktop")
                    .join(FILE_NAME),
            }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// An in-memory credential store that works, or answers every call with
    /// the error it's given.
    #[derive(Default)]
    struct FakeKeychain {
        kept: RefCell<Option<String>>,
        broken: Option<fn() -> StoreError>,
    }

    impl FakeKeychain {
        fn unavailable() -> Self {
            Self {
                broken: Some(|| StoreError::Unavailable("no Secret Service".into())),
                ..Self::default()
            }
        }

        fn failing() -> Self {
            Self {
                broken: Some(|| StoreError::Failed("locked".into())),
                ..Self::default()
            }
        }

        fn check(&self) -> Result<(), StoreError> {
            self.broken.map_or(Ok(()), |e| Err(e()))
        }
    }

    impl SecretStore for FakeKeychain {
        fn get(&self) -> Result<Option<String>, StoreError> {
            self.check()?;
            Ok(self.kept.borrow().clone())
        }
        fn set(&self, secret: &str) -> Result<(), StoreError> {
            self.check()?;
            *self.kept.borrow_mut() = Some(secret.into());
            Ok(())
        }
        fn delete(&self) -> Result<(), StoreError> {
            self.check()?;
            self.kept.borrow_mut().take();
            Ok(())
        }
    }

    fn multilingual() -> Session {
        let mut extra = Map::new();
        extra.insert(
            "name".into(),
            Value::from("陳大文 · 山田花子 · 김민준 · José Müller-Façon"),
        );
        // How the token was obtained, which the app keeps with the session (it revokes only "oauth" ones).
        extra.insert("via".into(), Value::from("oauth"));
        Session {
            url: "http://127.0.0.1:4100".into(),
            token: "xoxp-2-ünïcödé".into(),
            extra,
        }
    }

    #[test]
    fn the_file_round_trips_and_clears() {
        let dir = TempDir::new();
        let file = dir.store();
        assert_eq!(file.get(), Ok(None));
        file.set(&encode(&multilingual())).unwrap();
        assert_eq!(decode(&file.get().unwrap().unwrap()), Some(multilingual()));
        // Replacing it leaves only the new session and no temporary file.
        file.set(&encode(&session())).unwrap();
        assert_eq!(decode(&file.get().unwrap().unwrap()), Some(session()));
        assert!(!file.temp().exists());
        file.delete().unwrap();
        assert_eq!(file.get(), Ok(None));
        // Deleting nothing is fine.
        file.delete().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let file = dir.store();
        file.set(&encode(&session())).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&file.path), 0o600);
        assert_eq!(mode(file.path.parent().unwrap()), 0o700);
        // Still 0600 after a temporary left behind with wider permissions.
        fs::write(file.temp(), "stale").unwrap();
        fs::set_permissions(file.temp(), fs::Permissions::from_mode(0o644)).unwrap();
        file.set(&encode(&multilingual())).unwrap();
        assert_eq!(mode(&file.path), 0o600);
        assert!(!file.temp().exists());
    }

    #[test]
    fn a_failed_write_leaves_the_old_session() {
        let dir = TempDir::new();
        let file = dir.store();
        file.set(&encode(&session())).unwrap();
        // A directory where the temporary file goes makes the write fail before the rename.
        fs::create_dir(file.temp()).unwrap();
        fs::write(file.temp().join("x"), "").unwrap();
        assert!(matches!(
            file.set(&encode(&multilingual())),
            Err(StoreError::Failed(_))
        ));
        assert_eq!(decode(&file.get().unwrap().unwrap()), Some(session()));
    }

    #[test]
    fn saves_to_the_keychain_when_it_works() {
        let dir = TempDir::new();
        let (keychain, file) = (FakeKeychain::default(), dir.store());
        file.set(&encode(&multilingual())).unwrap();
        assert_eq!(save(&keychain, &file, &session()), Ok(Backend::Keychain));
        assert_eq!(
            keychain.kept.borrow().as_deref().and_then(decode),
            Some(session())
        );
        // No second copy outlives it.
        assert_eq!(file.get(), Ok(None));
        assert_eq!(load(&keychain, &file), Ok(Some(session())));
    }

    #[test]
    fn falls_back_to_the_file_without_a_keychain() {
        let dir = TempDir::new();
        let (keychain, file) = (FakeKeychain::unavailable(), dir.store());
        assert_eq!(load(&keychain, &file), Ok(None));
        assert_eq!(save(&keychain, &file, &multilingual()), Ok(Backend::File));
        assert_eq!(load(&keychain, &file), Ok(Some(multilingual())));
        clear(&keychain, &file).unwrap();
        assert_eq!(load(&keychain, &file), Ok(None));
    }

    #[test]
    fn a_keychain_that_refuses_is_an_error_not_a_fallback() {
        let dir = TempDir::new();
        let (keychain, file) = (FakeKeychain::failing(), dir.store());
        assert_eq!(save(&keychain, &file, &session()), Err("locked".into()));
        assert_eq!(file.get(), Ok(None));
        assert_eq!(load(&keychain, &file), Err("locked".into()));
        assert_eq!(clear(&keychain, &file), Err("locked".into()));
        // A session already in the file still signs in.
        file.set(&encode(&session())).unwrap();
        assert_eq!(load(&keychain, &file), Ok(Some(session())));
    }

    #[test]
    fn moves_the_file_into_the_keychain_once_it_works() {
        let dir = TempDir::new();
        let file = dir.store();
        assert_eq!(
            save(&FakeKeychain::unavailable(), &file, &multilingual()),
            Ok(Backend::File)
        );
        // A later launch finds a working keychain.
        let keychain = FakeKeychain::default();
        assert_eq!(load(&keychain, &file), Ok(Some(multilingual())));
        assert_eq!(
            keychain.kept.borrow().as_deref().and_then(decode),
            Some(multilingual())
        );
        assert_eq!(file.get(), Ok(None));
        assert_eq!(load(&keychain, &file), Ok(Some(multilingual())));
    }

    #[test]
    fn prefers_the_keychain_and_drops_a_stale_file() {
        let dir = TempDir::new();
        let (keychain, file) = (FakeKeychain::default(), dir.store());
        keychain.set(&encode(&session())).unwrap();
        file.set(&encode(&multilingual())).unwrap();
        assert_eq!(load(&keychain, &file), Ok(Some(session())));
        assert_eq!(file.get(), Ok(None));
    }

    #[test]
    fn a_garbled_keychain_item_gives_way_to_the_file() {
        let dir = TempDir::new();
        let (keychain, file) = (FakeKeychain::default(), dir.store());
        keychain.set("{not json").unwrap();
        file.set(&encode(&session())).unwrap();
        assert_eq!(load(&keychain, &file), Ok(Some(session())));
        assert_eq!(
            keychain.kept.borrow().as_deref().and_then(decode),
            Some(session())
        );
    }

    #[test]
    fn clear_empties_both() {
        let dir = TempDir::new();
        let (keychain, file) = (FakeKeychain::default(), dir.store());
        keychain.set(&encode(&session())).unwrap();
        file.set(&encode(&multilingual())).unwrap();
        clear(&keychain, &file).unwrap();
        assert_eq!(*keychain.kept.borrow(), None);
        assert_eq!(file.get(), Ok(None));
        assert_eq!(load(&keychain, &file), Ok(None));
    }
}
