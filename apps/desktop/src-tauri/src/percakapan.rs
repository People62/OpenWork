// Perbatasan percakapan: menyalakan mesin, mengirim prompt, mengalirkan token ke
// layar, dan menghentikannya di tengah.
//
// Token tidak dikembalikan sebagai nilai perintah — ia mengalir sebagai
// peristiwa Tauri. `invoke()` adalah permintaan-jawaban; aliran token bukan.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;
use tokio::sync::Mutex;

use crate::mesin::klien::{Kepingan, Klien, Model};
use crate::mesin::{GalatMesin, Mesin, StatusMesin};

/// Ditandai saat aliran berhenti — selesai sendiri, dibatalkan, atau gagal.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct Selesai {
    pub sesi_mesin_id: String,
    pub dibatalkan: bool,
    pub galat: Option<String>,
}

/// Aliran yang sedang berjalan, berikut sakelar pembatalnya.
#[derive(Default)]
pub struct Percakapan {
    batal: Arc<Mutex<Option<tokio::sync::watch::Sender<bool>>>>,
}

#[tauri::command]
#[specta::specta]
pub async fn status_mesin(mesin: State<'_, Mesin>) -> Result<StatusMesin, GalatMesin> {
    Ok(mesin.status().await)
}

#[tauri::command]
#[specta::specta]
pub async fn nyalakan_mesin(
    dir_kerja: String,
    app: AppHandle,
    mesin: State<'_, Mesin>,
) -> Result<StatusMesin, GalatMesin> {
    let dir = PathBuf::from(dir_kerja);
    let dir_aplikasi = dir_sebelah_aplikasi(&app);
    Ok(mesin.nyalakan(&dir, dir_aplikasi.as_deref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn matikan_mesin(mesin: State<'_, Mesin>) -> Result<StatusMesin, GalatMesin> {
    mesin.matikan().await?;
    Ok(mesin.status().await)
}

/// Model yang benar-benar tersedia di mesin yang sedang menyala.
///
/// Wajib ditanyakan, bukan ditebak: ketersediaan provider bergantung pada
/// direktori kerja mesin. Folder yang sama bisa punya puluhan model atau nol,
/// tergantung apakah ia dikenali sebagai proyek oleh OpenCode.
#[tauri::command]
#[specta::specta]
pub async fn daftar_model(mesin: State<'_, Mesin>) -> Result<Vec<Model>, GalatMesin> {
    let klien = Klien::baru(mesin.alamat().await?);
    Ok(klien.daftar_model().await?)
}

/// Membuat sesi mesin dengan model yang ditetapkan padanya.
///
/// Model tidak boleh dikosongkan begitu saja di pemakaian sungguhan: sesi tanpa
/// model jatuh ke bawaan mesin, dan kalau bawaan itu tidak bisa dipakai,
/// kegagalannya tidak muncul di aliran peristiwa sama sekali — hanya di log
/// mesin. Antarmuka akan tampak menggantung tanpa sebab.
#[tauri::command]
#[specta::specta]
pub async fn buat_sesi_mesin(
    model: Option<Model>,
    mesin: State<'_, Mesin>,
) -> Result<String, GalatMesin> {
    let klien = Klien::baru(mesin.alamat().await?);
    Ok(klien.buat_sesi(model.as_ref()).await?.id)
}

/// Mengirim prompt lalu mengalirkan jawabannya sebagai peristiwa. Perintah ini
/// kembali segera; alirannya berjalan di latar sampai selesai atau dihentikan.
#[tauri::command]
#[specta::specta]
pub async fn kirim_prompt(
    sesi_mesin_id: String,
    teks: String,
    app: AppHandle,
    mesin: State<'_, Mesin>,
    percakapan: State<'_, Percakapan>,
) -> Result<(), GalatMesin> {
    let klien = Klien::baru(mesin.alamat().await?);

    // Aliran sebelumnya dihentikan lebih dulu. Dua aliran atas sesi yang sama
    // akan menggandakan tiap token di layar.
    let (kirim_batal, terima_batal) = tokio::sync::watch::channel(false);
    if let Some(lama) = percakapan.batal.lock().await.replace(kirim_batal) {
        let _ = lama.send(true);
    }

    let aliran_klien = klien.clone();
    let aliran_app = app.clone();
    let aliran_sesi = sesi_mesin_id.clone();

    tokio::spawn(async move {
        let pengirim = aliran_app.clone();
        let hasil = aliran_klien
            .alirkan(
                &aliran_sesi,
                terima_batal.clone(),
                move |kepingan: Kepingan| {
                    let _ = kepingan.emit(&pengirim);
                },
            )
            .await;

        let _ = Selesai {
            sesi_mesin_id: aliran_sesi,
            dibatalkan: *terima_batal.borrow(),
            galat: hasil.err().map(|e| e.to_string()),
        }
        .emit(&aliran_app);
    });

    Ok(klien.kirim_prompt(&sesi_mesin_id, &teks).await?)
}

/// Menghentikan percakapan di tengah — sisi mesin lewat `interrupt`, sisi Rust
/// dengan menutup alirannya. Keduanya perlu: menutup aliran saja meninggalkan
/// mesin tetap menghasilkan token ke ruang hampa.
#[tauri::command]
#[specta::specta]
pub async fn hentikan_percakapan(
    sesi_mesin_id: String,
    mesin: State<'_, Mesin>,
    percakapan: State<'_, Percakapan>,
) -> Result<(), GalatMesin> {
    if let Some(sakelar) = percakapan.batal.lock().await.take() {
        let _ = sakelar.send(true);
    }

    let klien = Klien::baru(mesin.alamat().await?);
    Ok(klien.hentikan(&sesi_mesin_id).await?)
}

/// Direktori tempat binary aplikasi berada — di situlah sidecar diletakkan saat
/// aplikasi dipaketkan.
fn dir_sebelah_aplikasi(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .or_else(|| std::env::current_exe().ok()?.parent().map(PathBuf::from))
}
