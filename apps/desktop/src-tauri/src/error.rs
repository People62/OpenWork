// One error type for the whole command boundary.
//
// A reported error is often the cleanup error rather than its cause, so the
// variants here carry the original message from the layer below instead of
// replacing it with something tidier that has lost the substance.

use serde::Serialize;
use specta::Type;

#[derive(Debug, Serialize, Type)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum Error {
    /// The database refused, failed to open, or its migrations did not run.
    Database(String),
    /// What was asked for does not exist. Kept apart from `Database` because the
    /// interface usually wants to treat it differently — not a failure, just
    /// empty.
    NotFound(String),
    /// Input from the interface makes no sense before it ever reaches the
    /// database.
    InvalidInput(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Database(m) => write!(f, "database: {m}"),
            Error::NotFound(m) => write!(f, "not found: {m}"),
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
