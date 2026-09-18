// One error type for the whole command boundary.
//
// A reported error is often the cleanup error rather than its cause, so the
// variants here carry the original message from the layer below instead of
// replacing it with something tidier that has lost the substance.
//
// There was a `NotFound` too, for a session or a message that did not exist.
// Neither is looked up here any more — OpenCode owns conversations — and a
// variant nothing constructs is a shape the interface has to handle for a case
// that cannot arise.

use serde::Serialize;
use specta::Type;

#[derive(Debug, Serialize, Type)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum Error {
    /// The database refused, failed to open, or its migrations did not run.
    Database(String),
    /// Input from the interface makes no sense before it ever reaches the
    /// database.
    InvalidInput(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Database(m) => write!(f, "database: {m}"),
            Error::InvalidInput(m) => write!(f, "invalid input: {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Database(e.to_string())
    }
}

impl From<rusqlite_migration::Error> for Error {
    fn from(e: rusqlite_migration::Error) -> Self {
        Error::Database(format!("migration: {e}"))
    }
}
