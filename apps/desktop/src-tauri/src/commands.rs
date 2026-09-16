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
use crate::domain::{Message, Millis, Role, Session, Workspace};
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

// --------------------------------------------------------------- sessions

#[tauri::command]
#[specta::specta]
pub fn create_session(
    workspace_id: String,
    title: String,
    db: State<'_, Db>,
) -> Result<Session, Error> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(Error::InvalidInput("session title is empty".into()));
    }

    let c = lock(&db)?;
    ensure_exists(&c, "workspace", &workspace_id)?;

    let at = now();
    let session = Session {
        id: new_id(),
        workspace_id,
        title,
        created_at: at,
        updated_at: at,
    };

    c.execute(
        "INSERT INTO session (id, workspace_id, title, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        (
            &session.id,
            &session.workspace_id,
            &session.title,
            session.created_at,
            session.updated_at,
        ),
    )?;

    Ok(session)
}

#[tauri::command]
#[specta::specta]
pub fn list_sessions(workspace_id: String, db: State<'_, Db>) -> Result<Vec<Session>, Error> {
    let c = lock(&db)?;
    let mut statement = c.prepare(
        "SELECT id, workspace_id, title, created_at, updated_at
         FROM session WHERE workspace_id = ?1 ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map([&workspace_id], read_session)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Error::from)
}

// --------------------------------------------------------------- messages

#[tauri::command]
#[specta::specta]
pub fn add_message(
    session_id: String,
    role: Role,
    content: String,
    db: State<'_, Db>,
) -> Result<Message, Error> {
    if content.trim().is_empty() {
        return Err(Error::InvalidInput("message content is empty".into()));
    }

    let c = lock(&db)?;
    ensure_exists(&c, "session", &session_id)?;

    let message = Message {
        id: new_id(),
        session_id,
        role,
        content,
        created_at: now(),
    };

    c.execute(
        "INSERT INTO message (id, session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        (
            &message.id,
            &message.session_id,
            message.role.as_text(),
            &message.content,
            message.created_at,
        ),
    )?;

    // A session that was just used rises to the top of the list. Without this,
    // the "last used" order on screen lies.
    c.execute(
        "UPDATE session SET updated_at = ?1 WHERE id = ?2",
        (message.created_at, &message.session_id),
    )?;

    Ok(message)
}

#[tauri::command]
#[specta::specta]
pub fn list_messages(session_id: String, db: State<'_, Db>) -> Result<Vec<Message>, Error> {
    let c = lock(&db)?;
    let mut statement = c.prepare(
        "SELECT id, session_id, role, content, created_at
         FROM message WHERE session_id = ?1 ORDER BY created_at",
    )?;
    let rows = statement.query_map([&session_id], read_message)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Error::from)
}

// ---------------------------------------------------------- health check

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCheck {
    pub write_read_intact: bool,
    // Row counts, not timestamps — `u32` crosses to TypeScript without needing
    // any exception, and a local database will not reach its limit.
    pub workspace_count: u32,
    pub session_count: u32,
    pub message_count: u32,
}

/// Writes a workspace, a session and a message, reads them back, then rolls all
/// of it away. The transaction is rolled back when `tx` drops, so no rows are
/// left behind — but the migrations, the foreign keys, the CHECK constraints and
/// the real read-write path are all genuinely exercised.
///
/// Called when the application opens, not only in CI: a corrupt or read-only
/// database is better found now than when the user presses their first button.
#[tauri::command]
#[specta::specta]
pub fn check_database(db: State<'_, Db>) -> Result<DatabaseCheck, Error> {
    let mut c = lock(&db)?;
    let tx = c.transaction()?;

    let at = now();
    let workspace_id = new_id();
    let session_id = new_id();
    let content = "write-read check";

    tx.execute(
        "INSERT INTO workspace (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
        (&workspace_id, "check", format!("/check/{workspace_id}"), at),
    )?;
    tx.execute(
        "INSERT INTO session (id, workspace_id, title, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        (&session_id, &workspace_id, "check", at, at),
    )?;
    tx.execute(
        "INSERT INTO message (id, session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        (new_id(), &session_id, Role::User.as_text(), content, at),
    )?;

    let read_back: String = tx.query_row(
        "SELECT content FROM message WHERE session_id = ?1",
        [&session_id],
        |r| r.get(0),
    )?;

    let count = |table: &str| -> Result<u32, Error> {
        // Counted inside the transaction, so the trial rows above are included;
        // that is why each one subtracts one.
        let sql = format!("SELECT COUNT(*) FROM {table}");
        let total = tx.query_row(&sql, [], |r| r.get::<_, i64>(0))?;
        Ok(total.saturating_sub(1).max(0) as u32)
    };

    let result = DatabaseCheck {
        write_read_intact: read_back == content,
        workspace_count: count("workspace")?,
        session_count: count("session")?,
        message_count: count("message")?,
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

fn ensure_exists(c: &Connection, table: &str, id: &str) -> Result<(), Error> {
    // `table` never comes from the interface — only from callers in this file —
    // so there is no way in for injection through a table name.
    let sql = format!("SELECT 1 FROM {table} WHERE id = ?1");
    if c.query_row(&sql, [id], |_| Ok(())).is_ok() {
        Ok(())
    } else {
        Err(Error::NotFound(format!("{table} {id}")))
    }
}

fn read_workspace(r: &rusqlite::Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: r.get(0)?,
        name: r.get(1)?,
        path: r.get(2)?,
        created_at: r.get(3)?,
    })
}

fn read_session(r: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        title: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
    })
}

fn read_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    let role: String = r.get(2)?;
    Ok(Message {
        id: r.get(0)?,
        session_id: r.get(1)?,
        role: Role::from_text(&role).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(Error::Database(format!("unknown role: {role}"))),
            )
        })?,
        content: r.get(3)?,
        created_at: r.get(4)?,
    })
}
