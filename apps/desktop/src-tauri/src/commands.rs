// The boundary between the interface and the local backend.
//
// No HTTP, no ports, no CORS, no tokens here — just Rust functions called
// straight from React through `invoke()`. Every command in this file carries
// into `bindings.ts` along with its argument and return types.

use rusqlite::Connection;
use serde::Serialize;
use specta::Type;
use tauri::State;
use uuid::Uuid;

use crate::db::Db;
use crate::domain::{Millis, Workspace};
use crate::error::Error;

fn now() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

// ------------------------------------------------------------- workspaces

#[tauri::command]
#[specta::specta]
pub fn create_workspace(name: String, path: String, db: State<'_, Db>) -> Result<Workspace, Error> {
    let name = name.trim().to_string();
    let path = path.trim().to_string();

    if name.is_empty() {
        return Err(Error::InvalidInput("workspace name is empty".into()));
    }
    if path.is_empty() {
        return Err(Error::InvalidInput("workspace path is empty".into()));
    }

    let workspace = Workspace {
        id: new_id(),
        name,
        path,
        created_at: now(),
    };

    let c = lock(&db)?;
    c.execute(
        "INSERT INTO workspace (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
        (
            &workspace.id,
            &workspace.name,
            &workspace.path,
            workspace.created_at,
        ),
    )?;

    Ok(workspace)
}

#[tauri::command]
#[specta::specta]
pub fn list_workspaces(db: State<'_, Db>) -> Result<Vec<Workspace>, Error> {
    let c = lock(&db)?;
    let mut statement =
        c.prepare("SELECT id, name, path, created_at FROM workspace ORDER BY created_at DESC")?;
    let rows = statement.query_map([], read_workspace)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Error::from)
}

// ---------------------------------------------------------- health check

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCheck {
    pub write_read_intact: bool,
    // A row count, not a timestamp — `u32` crosses to TypeScript without needing
    // any exception, and a local database will not reach its limit.
    pub workspace_count: u32,
}

/// Writes a workspace, reads it back, then rolls it away. The transaction is
/// rolled back when `tx` drops, so no rows are left behind — but the migrations
/// and the real read-write path are genuinely exercised.
///
/// It used to write a session and a message too. Neither is ours to write any
/// more: OpenCode owns conversations, and the tables that held them are gone.
///
/// Called when the application opens, not only in CI: a corrupt or read-only
/// database is better found now than when the user presses their first button.
#[tauri::command]
#[specta::specta]
pub fn check_database(db: State<'_, Db>) -> Result<DatabaseCheck, Error> {
    let mut c = lock(&db)?;
    let tx = c.transaction()?;

    let workspace_id = new_id();
    let path = format!("/check/{workspace_id}");

    tx.execute(
        "INSERT INTO workspace (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
        (&workspace_id, "check", &path, now()),
    )?;

    let read_back: String = tx.query_row(
        "SELECT path FROM workspace WHERE id = ?1",
        [&workspace_id],
        |r| r.get(0),
    )?;

    // Counted inside the transaction, so the trial row above is included; that
    // is why it subtracts one.
    let total: i64 = tx.query_row("SELECT COUNT(*) FROM workspace", [], |r| r.get(0))?;

    let result = DatabaseCheck {
        write_read_intact: read_back == path,
        workspace_count: total.saturating_sub(1).max(0) as u32,
    };

    // No commit. When `tx` drops, all of it is rolled back.
    drop(tx);

    Ok(result)
}

// ----------------------------------------------------------------- helpers

fn lock<'a>(db: &'a State<'_, Db>) -> Result<std::sync::MutexGuard<'a, Connection>, Error> {
    db.connection
        .lock()
        .map_err(|e| Error::Database(format!("connection poisoned: {e}")))
}

fn read_workspace(r: &rusqlite::Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: r.get(0)?,
        name: r.get(1)?,
        path: r.get(2)?,
        created_at: r.get(3)?,
    })
}
