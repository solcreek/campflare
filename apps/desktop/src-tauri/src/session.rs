//! The signed-in session (`{url, token}`) in the OS credential store: the
//! macOS Keychain, the Windows Credential Manager, or the Secret Service on
//! Linux. The web app reaches it through the `session_*` commands; a browser
//! tab keeps it in localStorage instead.

use std::fmt;

use keyring::{Entry, Error};
use serde::{Deserialize, Serialize};

/// The keychain item's service; the same as the app's bundle identifier.
const SERVICE: &str = "com.campflare.desktop";
/// The keychain item's account. One session per installation.
const ACCOUNT: &str = "session";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub url: String,
    pub token: String,
}

/// Never prints the token, so a stray `{:?}` can't leak it into a log.
impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("url", &self.url)
            .field("token", &"…")
            .finish()
    }
}

/// The JSON kept in the credential store.
pub fn encode(session: &Session) -> String {
    serde_json::to_string(session).expect("a struct of two strings always serialises")
}

/// The session in a stored secret, or None for one that isn't a complete session.
pub fn decode(secret: &str) -> Option<Session> {
    serde_json::from_str::<Session>(secret)
        .ok()
        .filter(|s| !s.url.is_empty() && !s.token.is_empty())
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

// `async` runs them off the main thread: the first Keychain access may wait
// on a permission prompt, and the window must not freeze meanwhile.

#[tauri::command(async)]
pub fn session_load() -> Result<Option<Session>, String> {
    match entry()?.get_password() {
        Ok(secret) => Ok(decode(&secret)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(async)]
pub fn session_save(session: Session) -> Result<(), String> {
    entry()?
        .set_password(&encode(&session))
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn session_clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session {
            url: "https://campflare.example".into(),
            token: "xoxp-1".into(),
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
    fn decodes_what_the_web_app_sends() {
        // Unknown fields are ignored; field order doesn't matter.
        let json = r#"{"token":"xoxp-1","url":"https://campflare.example","extra":1}"#;
        assert_eq!(decode(json), Some(session()));
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
}
