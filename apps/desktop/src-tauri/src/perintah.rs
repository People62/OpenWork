// Perbatasan antara antarmuka dan BE lokal.
//
// Tidak ada HTTP, port, CORS, atau token di sini — hanya fungsi Rust yang
// dipanggil langsung dari React lewat `invoke()`. Setiap perintah di berkas ini
// ikut terbawa ke `bindings.ts` berikut tipe argumen dan tipe kembaliannya.

use rusqlite::Connection;
use tauri::State;
use uuid::Uuid;

use serde::Serialize;
use specta::Type;

use crate::db::Db;
use crate::domain::{Milidetik, Peran, Pesan, Sesi, Workspace};
use crate::galat::Galat;

fn sekarang() -> Milidetik {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn id_baru() -> String {
    Uuid::new_v4().to_string()
}

// ------------------------------------------------------------- workspace

#[tauri::command]
#[specta::specta]
pub fn buat_workspace(nama: String, jalur: String, db: State<'_, Db>) -> Result<Workspace, Galat> {
    let nama = nama.trim().to_string();
    let jalur = jalur.trim().to_string();

    if nama.is_empty() {
        return Err(Galat::MasukanTakSah("nama workspace kosong".into()));
    }
    if jalur.is_empty() {
        return Err(Galat::MasukanTakSah("jalur workspace kosong".into()));
    }

    let ws = Workspace {
        id: id_baru(),
        nama,
        jalur,
        dibuat_pada: sekarang(),
    };

    let k = kunci(&db)?;
    k.execute(
        "INSERT INTO workspace (id, nama, jalur, dibuat_pada) VALUES (?1, ?2, ?3, ?4)",
        (&ws.id, &ws.nama, &ws.jalur, ws.dibuat_pada),
    )?;

    Ok(ws)
}

#[tauri::command]
#[specta::specta]
pub fn daftar_workspace(db: State<'_, Db>) -> Result<Vec<Workspace>, Galat> {
    let k = kunci(&db)?;
    let mut pernyataan =
        k.prepare("SELECT id, nama, jalur, dibuat_pada FROM workspace ORDER BY dibuat_pada DESC")?;
    let baris = pernyataan.query_map([], baca_workspace)?;
    baris.collect::<Result<Vec<_>, _>>().map_err(Galat::from)
}

// ------------------------------------------------------------------ sesi

#[tauri::command]
#[specta::specta]
pub fn buat_sesi(workspace_id: String, judul: String, db: State<'_, Db>) -> Result<Sesi, Galat> {
    let judul = judul.trim().to_string();
    if judul.is_empty() {
        return Err(Galat::MasukanTakSah("judul sesi kosong".into()));
    }

    let k = kunci(&db)?;
    pastikan_ada(&k, "workspace", &workspace_id)?;

    let saat = sekarang();
    let sesi = Sesi {
        id: id_baru(),
        workspace_id,
        judul,
        dibuat_pada: saat,
        diperbarui_pada: saat,
    };

    k.execute(
        "INSERT INTO sesi (id, workspace_id, judul, dibuat_pada, diperbarui_pada)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        (
            &sesi.id,
            &sesi.workspace_id,
            &sesi.judul,
            sesi.dibuat_pada,
            sesi.diperbarui_pada,
        ),
    )?;

    Ok(sesi)
}

#[tauri::command]
#[specta::specta]
pub fn daftar_sesi(workspace_id: String, db: State<'_, Db>) -> Result<Vec<Sesi>, Galat> {
    let k = kunci(&db)?;
    let mut pernyataan = k.prepare(
        "SELECT id, workspace_id, judul, dibuat_pada, diperbarui_pada
         FROM sesi WHERE workspace_id = ?1 ORDER BY diperbarui_pada DESC",
    )?;
    let baris = pernyataan.query_map([&workspace_id], baca_sesi)?;
    baris.collect::<Result<Vec<_>, _>>().map_err(Galat::from)
}

// ----------------------------------------------------------------- pesan

#[tauri::command]
#[specta::specta]
pub fn tambah_pesan(
    sesi_id: String,
    peran: Peran,
    isi: String,
    db: State<'_, Db>,
) -> Result<Pesan, Galat> {
    if isi.trim().is_empty() {
        return Err(Galat::MasukanTakSah("isi pesan kosong".into()));
    }

    let k = kunci(&db)?;
    pastikan_ada(&k, "sesi", &sesi_id)?;

    let pesan = Pesan {
        id: id_baru(),
        sesi_id,
        peran,
        isi,
        dibuat_pada: sekarang(),
    };

    k.execute(
        "INSERT INTO pesan (id, sesi_id, peran, isi, dibuat_pada) VALUES (?1, ?2, ?3, ?4, ?5)",
        (
            &pesan.id,
            &pesan.sesi_id,
            pesan.peran.sebagai_teks(),
            &pesan.isi,
            pesan.dibuat_pada,
        ),
    )?;

    // Sesi yang baru saja dipakai naik ke atas daftar. Tanpa ini, urutan
    // "terakhir dipakai" di layar berbohong.
    k.execute(
        "UPDATE sesi SET diperbarui_pada = ?1 WHERE id = ?2",
        (pesan.dibuat_pada, &pesan.sesi_id),
    )?;

    Ok(pesan)
}

#[tauri::command]
#[specta::specta]
pub fn daftar_pesan(sesi_id: String, db: State<'_, Db>) -> Result<Vec<Pesan>, Galat> {
    let k = kunci(&db)?;
    let mut pernyataan = k.prepare(
        "SELECT id, sesi_id, peran, isi, dibuat_pada
         FROM pesan WHERE sesi_id = ?1 ORDER BY dibuat_pada",
    )?;
    let baris = pernyataan.query_map([&sesi_id], baca_pesan)?;
    baris.collect::<Result<Vec<_>, _>>().map_err(Galat::from)
}

// -------------------------------------------------------- periksa data

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PeriksaDb {
    pub tulis_baca_utuh: bool,
    // Jumlah baris, bukan cap waktu — `u32` lewat ke TypeScript tanpa perlu
    // pengecualian apa pun, dan basis data lokal tidak akan menyentuh batasnya.
    pub jumlah_workspace: u32,
    pub jumlah_sesi: u32,
    pub jumlah_pesan: u32,
}

/// Menulis workspace, sesi, dan pesan, membacanya kembali, lalu membatalkan
/// seluruhnya. Transaksinya di-rollback saat `tx` jatuh, jadi tidak ada sisa
/// baris — tapi migrasi, foreign key, CHECK constraint, dan jalur baca-tulis
/// yang sesungguhnya semuanya benar-benar dilewati.
///
/// Dipanggil saat aplikasi dibuka, bukan hanya di CI: basis data yang rusak
/// atau hanya-baca sebaiknya ketahuan sekarang, bukan saat pengguna menekan
/// tombol pertamanya.
#[tauri::command]
#[specta::specta]
pub fn periksa_basis_data(db: State<'_, Db>) -> Result<PeriksaDb, Galat> {
    let mut k = kunci(&db)?;
    let tx = k.transaction()?;

    let saat = sekarang();
    let ws_id = id_baru();
    let sesi_id = id_baru();
    let isi = "periksa tulis-baca";

    tx.execute(
        "INSERT INTO workspace (id, nama, jalur, dibuat_pada) VALUES (?1, ?2, ?3, ?4)",
        (&ws_id, "periksa", format!("/periksa/{ws_id}"), saat),
    )?;
    tx.execute(
        "INSERT INTO sesi (id, workspace_id, judul, dibuat_pada, diperbarui_pada)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        (&sesi_id, &ws_id, "periksa", saat, saat),
    )?;
    tx.execute(
        "INSERT INTO pesan (id, sesi_id, peran, isi, dibuat_pada) VALUES (?1, ?2, ?3, ?4, ?5)",
        (
            id_baru(),
            &sesi_id,
            Peran::Pengguna.sebagai_teks(),
            isi,
            saat,
        ),
    )?;

    let terbaca: String = tx.query_row(
        "SELECT isi FROM pesan WHERE sesi_id = ?1",
        [&sesi_id],
        |b| b.get(0),
    )?;

    let hitung = |tabel: &str| -> Result<u32, Galat> {
        // Dihitung di dalam transaksi, jadi baris percobaan di atas ikut
        // terhitung; itulah sebabnya masing-masing dikurangi satu.
        let sql = format!("SELECT COUNT(*) FROM {tabel}");
        let jumlah = tx.query_row(&sql, [], |b| b.get::<_, i64>(0))?;
        Ok(jumlah.saturating_sub(1).max(0) as u32)
    };

    let hasil = PeriksaDb {
        tulis_baca_utuh: terbaca == isi,
        jumlah_workspace: hitung("workspace")?,
        jumlah_sesi: hitung("sesi")?,
        jumlah_pesan: hitung("pesan")?,
    };

    // Tidak ada commit. Saat `tx` jatuh, seluruhnya dibatalkan.
    drop(tx);

    Ok(hasil)
}

// ---------------------------------------------------------------- bantu

fn kunci<'a>(db: &'a State<'_, Db>) -> Result<std::sync::MutexGuard<'a, Connection>, Galat> {
    db.koneksi
        .lock()
        .map_err(|e| Galat::BasisData(format!("koneksi teracuni: {e}")))
}

fn pastikan_ada(k: &Connection, tabel: &str, id: &str) -> Result<(), Galat> {
    // `tabel` tidak pernah berasal dari antarmuka — hanya dari pemanggil di
    // berkas ini — jadi tidak ada jalan masuk untuk injeksi lewat nama tabel.
    let sql = format!("SELECT 1 FROM {tabel} WHERE id = ?1");
    let ada = k.query_row(&sql, [id], |_| Ok(())).is_ok();
    if ada {
        Ok(())
    } else {
        Err(Galat::TidakDitemukan(format!("{tabel} {id}")))
    }
}

fn baca_workspace(b: &rusqlite::Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: b.get(0)?,
        nama: b.get(1)?,
        jalur: b.get(2)?,
        dibuat_pada: b.get(3)?,
    })
}

fn baca_sesi(b: &rusqlite::Row<'_>) -> rusqlite::Result<Sesi> {
    Ok(Sesi {
        id: b.get(0)?,
        workspace_id: b.get(1)?,
        judul: b.get(2)?,
        dibuat_pada: b.get(3)?,
        diperbarui_pada: b.get(4)?,
    })
}

fn baca_pesan(b: &rusqlite::Row<'_>) -> rusqlite::Result<Pesan> {
    let peran: String = b.get(2)?;
    Ok(Pesan {
        id: b.get(0)?,
        sesi_id: b.get(1)?,
        peran: Peran::dari_teks(&peran).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(Galat::BasisData(format!("peran tak dikenal: {peran}"))),
            )
        })?,
        isi: b.get(3)?,
        dibuat_pada: b.get(4)?,
    })
}
