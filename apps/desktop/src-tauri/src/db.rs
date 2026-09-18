// The SQLite connection and its migrations.
//
// The schema version lives in SQLite's own `user_version` rather than a
// hand-rolled table, so there is no state in which the migration table exists
// but the schema does not, or the other way round.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

use crate::error::Error;

/// Held by Tauri as state. One connection behind a mutex is enough for
/// Release 1; if it ever becomes the bottleneck the answer is a pool — not
/// opening a connection per call.
pub struct Db {
    pub connection: Mutex<Connection>,
}

fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        // 1 — the Release 1 backbone: workspaces, sessions, messages.
        //
        // Named in Indonesian, as the whole codebase once was. Migration 2
        // renames it; this one is left exactly as it shipped, because a
        // migration that is edited after it has run somewhere is no longer a
        // migration.
        M::up(
            r#"
            CREATE TABLE workspace (
                id          TEXT PRIMARY KEY NOT NULL,
                nama        TEXT NOT NULL,
                jalur       TEXT NOT NULL UNIQUE,
                dibuat_pada INTEGER NOT NULL
            );

            CREATE TABLE sesi (
                id              TEXT PRIMARY KEY NOT NULL,
                workspace_id    TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
                judul           TEXT NOT NULL,
                dibuat_pada     INTEGER NOT NULL,
                diperbarui_pada INTEGER NOT NULL
            );

            CREATE INDEX idx_sesi_workspace ON sesi(workspace_id, diperbarui_pada DESC);

            CREATE TABLE pesan (
                id          TEXT PRIMARY KEY NOT NULL,
                sesi_id     TEXT NOT NULL REFERENCES sesi(id) ON DELETE CASCADE,
                peran       TEXT NOT NULL CHECK (peran IN ('pengguna', 'asisten')),
                isi         TEXT NOT NULL,
                dibuat_pada INTEGER NOT NULL
            );

            CREATE INDEX idx_pesan_sesi ON pesan(sesi_id, dibuat_pada);
            "#,
        ),
        // 2 — English names, to match the rest of the code.
        //
        // Done as a migration rather than by editing migration 1, because
        // databases created by the published pre-release already exist. They
        // carry real rows, and rewriting history under them would either lose
        // those rows or leave the schema disagreeing with the code.
        //
        // `workspace` and `sesi` only need renames. `pesan` has to be rebuilt:
        // its CHECK constraint names the old role values, and SQLite cannot
        // alter a constraint in place.
        M::up(
            r#"
            ALTER TABLE workspace RENAME COLUMN nama TO name;
            ALTER TABLE workspace RENAME COLUMN jalur TO path;
            ALTER TABLE workspace RENAME COLUMN dibuat_pada TO created_at;

            ALTER TABLE sesi RENAME TO session;
            ALTER TABLE session RENAME COLUMN judul TO title;
            ALTER TABLE session RENAME COLUMN dibuat_pada TO created_at;
            ALTER TABLE session RENAME COLUMN diperbarui_pada TO updated_at;

            DROP INDEX idx_sesi_workspace;
            CREATE INDEX idx_session_workspace ON session(workspace_id, updated_at DESC);

            CREATE TABLE message (
                id         TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                content    TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            INSERT INTO message (id, session_id, role, content, created_at)
            SELECT
                id,
                sesi_id,
                CASE peran WHEN 'pengguna' THEN 'user' ELSE 'assistant' END,
                isi,
                dibuat_pada
            FROM pesan;

            DROP INDEX idx_pesan_sesi;
            DROP TABLE pesan;

            CREATE INDEX idx_message_session ON message(session_id, created_at);
            "#,
        ),
        // 3 — conversations go back to OpenCode, which never stopped storing
        // them.
        //
        // `session` and `message` held a second copy of rows OpenCode already
        // keeps in its own SQLite: title, model, cost, tokens, reasoning, tool
        // calls, forks. That store is the one the engine reads as context for
        // the next turn, so whenever the two parted company — a stream cut
        // short, a compaction, a revert — the screen would show one
        // conversation while the model answered from another.
        //
        // The rows are dropped rather than migrated anywhere. There is nowhere
        // to migrate them *to*: every conversation held here was produced by an
        // engine that wrote its own copy at the same time, and that copy is
        // still there, richer than this one ever was.
        //
        // What stays is the workspace — a folder someone chose, under a name
        // they chose. OpenCode derives its `project` from the path alone and has
        // no room for the name.
        M::up(
            r#"
            DROP INDEX IF EXISTS idx_message_session;
            DROP TABLE IF EXISTS message;
            DROP INDEX IF EXISTS idx_session_workspace;
            DROP TABLE IF EXISTS session;
            "#,
        ),
    ])
}

fn prepare(connection: &Connection) -> Result<(), Error> {
    // The ON DELETE CASCADE above means nothing without this line — SQLite
    // turns foreign keys off by default, per connection.
    connection.pragma_update(None, "foreign_keys", "ON")?;
    // WAL so that reading is not blocked by writing. This matters as soon as
    // token streaming lands.
    connection.pragma_update(None, "journal_mode", "WAL")?;
    Ok(())
}

pub fn open(path: &Path) -> Result<Db, Error> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::Database(format!("could not create {}: {e}", parent.display())))?;
    }

    let mut connection = Connection::open(path)
        .map_err(|e| Error::Database(format!("could not open {}: {e}", path.display())))?;

    prepare(&connection)?;
    migrations().to_latest(&mut connection)?;

    Ok(Db {
        connection: Mutex::new(connection),
    })
}

/// An in-memory database for tests. It runs exactly the same migration path the
/// application does — if it differed, the tests would not be testing anything.
#[cfg(test)]
pub fn open_in_memory() -> Result<Db, Error> {
    let mut connection = Connection::open_in_memory()?;
    prepare(&connection)?;
    migrations().to_latest(&mut connection)?;
    Ok(Db {
        connection: Mutex::new(connection),
    })
}

pub fn default_path(data_dir: PathBuf) -> PathBuf {
    data_dir.join("rantai.db")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_valid() {
        // Catches mistyped SQL without having to run the application.
        assert!(migrations().validate().is_ok());
    }

    #[test]
    fn foreign_keys_are_on() {
        let db = open_in_memory().expect("could not open in-memory database");
        let c = db.connection.lock().unwrap();
        let on: i64 = c
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .expect("could not read pragma");
        assert_eq!(
            on, 1,
            "foreign keys are off — ON DELETE CASCADE does nothing"
        );
    }

    /// Migration 2 renames what migration 1 created. The rename is only correct
    /// if rows written under the old names survive it — so this walks the same
    /// path a real database takes: create at version 1, write, then migrate.
    #[test]
    fn rename_migration_carries_rows_across() {
        let mut c = Connection::open_in_memory().expect("in-memory database");
        prepare(&c).expect("pragmas");

        let only_first = Migrations::new(vec![migrations_first_only()]);
        only_first.to_latest(&mut c).expect("migration 1");

        c.execute_batch(
            r#"
            INSERT INTO workspace (id, nama, jalur, dibuat_pada)
                VALUES ('w1', 'ruang', '/tmp/ruang', 1);
            INSERT INTO sesi (id, workspace_id, judul, dibuat_pada, diperbarui_pada)
                VALUES ('s1', 'w1', 'judul', 1, 2);
            INSERT INTO pesan (id, sesi_id, peran, isi, dibuat_pada)
                VALUES ('m1', 's1', 'pengguna', 'halo', 3);
            "#,
        )
        .expect("rows under the old schema");

        // Stops at 2 on purpose. Migration 3 drops the two tables this test is
        // about, so running to the end would prove nothing about the rename —
        // it would only prove the tables are gone, which is a different claim
        // and has its own test below.
        migrations().to_version(&mut c, 2).expect("migration 2");

        let (name, path): (String, String) = c
            .query_row(
                "SELECT name, path FROM workspace WHERE id = 'w1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("workspace survived");
        assert_eq!((name.as_str(), path.as_str()), ("ruang", "/tmp/ruang"));

        let title: String = c
            .query_row("SELECT title FROM session WHERE id = 's1'", [], |r| {
                r.get(0)
            })
            .expect("session survived");
        assert_eq!(title, "judul");

        let (role, content): (String, String) = c
            .query_row(
                "SELECT role, content FROM message WHERE id = 'm1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("message survived");
        // The role values were translated too, not just the column names.
        assert_eq!((role.as_str(), content.as_str()), ("user", "halo"));
    }

    /// Migration 3 hands conversations back to OpenCode.
    ///
    /// What it must not do is take the workspace with them. A workspace is the
    /// one row Rantai still owns — the folder someone chose, under the name they
    /// chose — and OpenCode has nowhere to put that name.
    #[test]
    fn third_migration_drops_conversations_and_keeps_the_workspace() {
        let mut c = Connection::open_in_memory().expect("in-memory database");
        prepare(&c).expect("pragmas");

        let only_first = Migrations::new(vec![migrations_first_only()]);
        only_first.to_latest(&mut c).expect("migration 1");
        c.execute_batch(
            r#"
            INSERT INTO workspace (id, nama, jalur, dibuat_pada)
                VALUES ('w1', 'ruang', '/tmp/ruang', 1);
            INSERT INTO sesi (id, workspace_id, judul, dibuat_pada, diperbarui_pada)
                VALUES ('s1', 'w1', 'judul', 1, 2);
            INSERT INTO pesan (id, sesi_id, peran, isi, dibuat_pada)
                VALUES ('m1', 's1', 'pengguna', 'halo', 3);
            "#,
        )
        .expect("rows under the old schema");

        migrations().to_latest(&mut c).expect("every migration");

        let name: String = c
            .query_row("SELECT name FROM workspace WHERE id = 'w1'", [], |r| {
                r.get(0)
            })
            .expect("the workspace survived");
        assert_eq!(name, "ruang");

        for gone in ["session", "message"] {
            let count: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [gone],
                    |r| r.get(0),
                )
                .expect("could not read sqlite_master");
            assert_eq!(count, 0, "table `{gone}` is still there");
        }
    }

    /// Migration 1 on its own, for the test above.
    fn migrations_first_only() -> M<'static> {
        M::up(
            r#"
            CREATE TABLE workspace (
                id          TEXT PRIMARY KEY NOT NULL,
                nama        TEXT NOT NULL,
                jalur       TEXT NOT NULL UNIQUE,
                dibuat_pada INTEGER NOT NULL
            );
            CREATE TABLE sesi (
                id              TEXT PRIMARY KEY NOT NULL,
                workspace_id    TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
                judul           TEXT NOT NULL,
                dibuat_pada     INTEGER NOT NULL,
                diperbarui_pada INTEGER NOT NULL
            );
            CREATE INDEX idx_sesi_workspace ON sesi(workspace_id, diperbarui_pada DESC);
            CREATE TABLE pesan (
                id          TEXT PRIMARY KEY NOT NULL,
                sesi_id     TEXT NOT NULL REFERENCES sesi(id) ON DELETE CASCADE,
                peran       TEXT NOT NULL CHECK (peran IN ('pengguna', 'asisten')),
                isi         TEXT NOT NULL,
                dibuat_pada INTEGER NOT NULL
            );
            CREATE INDEX idx_pesan_sesi ON pesan(sesi_id, dibuat_pada);
            "#,
        )
    }
}
