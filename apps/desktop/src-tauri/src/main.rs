// Rantai — Fase 1: data dan domain di Rust.
//
// Tauri *adalah* program Rust; ini bukan cangkang yang BE-nya disambungkan dari
// luar. BE lokal tinggal di berkas-berkas di sebelah ini, dan antarmuka
// memanggilnya lewat `invoke()` — tanpa HTTP loopback, port dinamis, CORS, atau
// token.
//
// Seluruh permukaan perintah masih sinkron. Async baru masuk di Fase 2, saat
// proses OpenCode dikelola dari sini — dan di situlah kesulitan Rust yang
// sebenarnya menunggu.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod db;
mod domain;
mod galat;
mod mesin;
mod percakapan;
mod perintah;
mod smoke;
mod tautan;

use serde::Serialize;
use specta::Type;
use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder};

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Sapaan {
    pesan: String,
    platform: String,
    arsitektur: String,
    versi_tauri: String,
    versi_aplikasi: String,
}

/// Perintah pertama, dari Fase 0. Ia bertahan karena mode smoke memakainya
/// untuk membuktikan IPC bulat sebelum menyentuh basis data.
#[tauri::command]
#[specta::specta]
fn halo(nama: String) -> Sapaan {
    Sapaan {
        pesan: format!("Halo dari Rust, {nama}."),
        platform: std::env::consts::OS.to_string(),
        arsitektur: std::env::consts::ARCH.to_string(),
        versi_tauri: tauri::VERSION.to_string(),
        versi_aplikasi: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// Satu tempat yang mendaftarkan seluruh perintah. Dipakai dua kali: oleh
/// aplikasi saat berjalan, dan oleh tes yang menulis `bindings.ts`. Karena
/// keduanya membaca daftar yang sama, tipe di layar tidak bisa melenceng dari
/// tipe di Rust tanpa ada yang gagal.
fn pembangun() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            halo,
            smoke::lapor_sinyal,
            smoke::harapan_smoke,
            perintah::buat_workspace,
            perintah::daftar_workspace,
            perintah::buat_sesi,
            perintah::daftar_sesi,
            perintah::tambah_pesan,
            perintah::daftar_pesan,
            perintah::periksa_basis_data,
            percakapan::status_mesin,
            percakapan::nyalakan_mesin,
            percakapan::matikan_mesin,
            percakapan::buat_sesi_mesin,
            percakapan::kirim_prompt,
            percakapan::hentikan_percakapan,
            tautan::status_tautan_dalam,
            tautan::daftarkan_tautan_dalam,
            tautan::buka_di_browser,
            tautan::tautan_peluncuran,
        ])
        // Peristiwa ikut dihasilkan ke bindings.ts, lengkap dengan pendengarnya.
        .events(collect_events![
            mesin::klien::Kepingan,
            percakapan::Selesai,
            tautan::TautanDalam
        ])
}

fn main() {
    let pembangun = pembangun();

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(smoke::Papan::default())
        .manage(mesin::Mesin::default())
        .manage(percakapan::Percakapan::default())
        .manage(tautan::Peluncuran::default())
        .invoke_handler(pembangun.invoke_handler())
        // Kalau sinyal tidak pernah tiba, pertanyaan pertamanya selalu sama:
        // apakah halamannya termuat, dan dari alamat mana. Tanpa jejak ini,
        // kegagalan mode smoke tampak seperti diam total.
        .on_page_load(|jendela, muatan| {
            if smoke::aktif() {
                eprintln!(
                    "smoke: halaman {:?} di {} ({})",
                    muatan.event(),
                    muatan.url(),
                    jendela.label()
                );
            }
        })
        .setup(move |app| {
            pembangun.mount_events(app);
            tautan::pasang(app.handle());

            let dir_data = app
                .path()
                .app_data_dir()
                .expect("tidak ada direktori data aplikasi");
            let jalur = db::jalur_bawaan(dir_data);

            match db::buka(&jalur) {
                Ok(db) => {
                    app.manage(db);
                }
                Err(e) => {
                    // Cetak seluruh rantainya. Basis data yang gagal dibuka
                    // membuat setiap perintah berikutnya gagal dengan alasan
                    // yang terdengar seperti hal lain.
                    eprintln!("gagal membuka basis data di {}: {e}", jalur.display());
                    return Err(Box::new(e));
                }
            }

            if smoke::aktif() {
                eprintln!("smoke: basis data di {}", jalur.display());
                smoke::awasi(app.handle().clone());
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("gagal membangun aplikasi Tauri")
        // Menutup jendela tidak otomatis mematikan proses anak: `kill_on_drop`
        // hanya berlaku pada jalur drop yang normal, dan tidak semua jalan
        // keluar melewatinya. Gerbang Fase 2 menuntut tidak ada proses yatim,
        // jadi pematiannya dilakukan di sini, di jalan keluar yang pasti
        // dilewati.
        .run(|handle, peristiwa| {
            if matches!(peristiwa, tauri::RunEvent::Exit) {
                let mesin = handle.state::<mesin::Mesin>();
                if let Err(e) = tauri::async_runtime::block_on(mesin.matikan()) {
                    eprintln!("gagal mematikan mesin saat keluar: {e}");
                }
            }
        });
}

#[cfg(test)]
mod tes {
    use super::*;
    use specta_typescript::Typescript;

    /// Tempat `bindings.ts` mendarat, relatif terhadap src-tauri.
    const TUJUAN_BINDINGS: &str = "../../ui/app/bindings.ts";

    /// Inilah gerbang Fase 1. Tes ini menulis ulang `bindings.ts` dari daftar
    /// perintah di Rust; CI menjalankannya lalu menuntut `git diff` bersih. Jadi
    /// mengubah bentuk data di Rust tanpa memperbarui berkas itu menggagalkan
    /// CI, dan memperbaruinya memunculkan galat tipe di Next.js sampai
    /// pemanggilnya ikut diperbaiki.
    #[test]
    fn bindings_mutakhir() {
        pembangun()
            .export(
                Typescript::default().header("// Dihasilkan dari Rust. Jangan disunting tangan.\n"),
                TUJUAN_BINDINGS,
            )
            .expect("gagal menulis bindings.ts");
    }
}
