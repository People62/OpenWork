// Koneksi SQLite dan migrasinya.
//
// Versi skema disimpan di `user_version` milik SQLite, bukan di tabel buatan
// sendiri — jadi tidak ada keadaan di mana tabel migrasi ada tapi skemanya
// belum, atau sebaliknya.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

use crate::galat::Galat;

/// Dipegang Tauri sebagai state. Satu koneksi di balik mutex sudah cukup untuk
/// Rilis 1; kalau kelak jadi sempit, penggantinya adalah pool — bukan membuka
/// koneksi per pemanggilan.
pub struct Db {
    pub koneksi: Mutex<Connection>,
}

fn migrasi() -> Migrations<'static> {
    Migrations::new(vec![
        // 1 — tulang punggung Rilis 1: workspace, sesi, pesan.
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
    ])
}

fn siapkan(koneksi: &Connection) -> Result<(), Galat> {
    // ON DELETE CASCADE di atas tidak berarti apa-apa tanpa baris ini —
    // SQLite mematikan foreign key secara bawaan, per koneksi.
    koneksi.pragma_update(None, "foreign_keys", "ON")?;
    // WAL supaya membaca tidak terhalang menulis. Relevan begitu streaming
    // token masuk di Fase 2.
    koneksi.pragma_update(None, "journal_mode", "WAL")?;
    Ok(())
}

pub fn buka(jalur: &Path) -> Result<Db, Galat> {
    if let Some(induk) = jalur.parent() {
        std::fs::create_dir_all(induk)
            .map_err(|e| Galat::BasisData(format!("gagal membuat {}: {e}", induk.display())))?;
    }

    let mut koneksi = Connection::open(jalur)
        .map_err(|e| Galat::BasisData(format!("gagal membuka {}: {e}", jalur.display())))?;

    siapkan(&koneksi)?;
    migrasi().to_latest(&mut koneksi)?;

    Ok(Db {
        koneksi: Mutex::new(koneksi),
    })
}

/// Basis data di dalam memori, dipakai tes. Jalur migrasinya sama persis dengan
/// yang dipakai aplikasi — kalau berbeda, tesnya tidak menguji apa pun.
#[cfg(test)]
pub fn buka_di_memori() -> Result<Db, Galat> {
    let mut koneksi = Connection::open_in_memory()?;
    siapkan(&koneksi)?;
    migrasi().to_latest(&mut koneksi)?;
    Ok(Db {
        koneksi: Mutex::new(koneksi),
    })
}

pub fn jalur_bawaan(dir_data: PathBuf) -> PathBuf {
    dir_data.join("rantai.db")
}

#[cfg(test)]
mod tes {
    use super::*;

    #[test]
    fn migrasi_valid() {
        // Menangkap SQL yang salah ketik tanpa perlu menjalankan aplikasinya.
        assert!(migrasi().validate().is_ok());
    }

    #[test]
    fn foreign_key_menyala() {
        let db = buka_di_memori().expect("gagal membuka basis data di memori");
        let k = db.koneksi.lock().unwrap();
        let nyala: i64 = k
            .query_row("PRAGMA foreign_keys", [], |b| b.get(0))
            .expect("gagal membaca pragma");
        assert_eq!(
            nyala, 1,
            "foreign key mati — ON DELETE CASCADE tidak berlaku"
        );
    }
}
