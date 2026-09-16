// Rantai — Fase 0: kerangka yang berjalan.
//
// Berkas ini sengaja tipis. Tujuan Fase 0 bukan membangun fitur, melainkan
// membuktikan rantai build dan IPC di ketiga webview — WebKitGTK, WKWebView,
// WebView2 — sebelum ada satu pun baris fitur yang bergantung padanya.
//
// Tauri *adalah* program Rust; ini bukan cangkang yang BE-nya disambungkan dari
// luar. Mulai Fase 1, BE lokal tumbuh persis di sini sebagai `#[tauri::command]`
// tambahan: SQLite, model domain, lalu pengelolaan proses OpenCode. Tidak ada
// HTTP loopback, port dinamis, CORS, atau token di antaranya.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Manager, State};

/// Sinyal yang menutup gerbang Fase 0. Urutannya berarti: yang kedua tidak
/// mungkin tiba kalau yang pertama tidak.
///
///   1. `webview-termuat` — halaman termuat, bundel jalan, React ter-mount
///   2. `ipc-bulat`       — jawaban Rust sampai ke layar lalu kembali ke Rust
const SINYAL: [&str; 2] = ["webview-termuat", "ipc-bulat"];

const BATAS_BAWAAN_MS: u64 = 120_000;

// ---------------------------------------------------------------- perintah

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sapaan {
    pesan: String,
    platform: &'static str,
    arsitektur: &'static str,
    versi_tauri: &'static str,
    versi_aplikasi: &'static str,
}

/// Perintah pertama, dan untuk sementara satu-satunya yang berarti. Ia ada
/// supaya ada sesuatu yang nyata untuk dipanggil dari antarmuka.
#[tauri::command]
fn halo(nama: String) -> Sapaan {
    Sapaan {
        pesan: format!("Halo dari Rust, {nama}."),
        platform: std::env::consts::OS,
        arsitektur: std::env::consts::ARCH,
        versi_tauri: tauri::VERSION,
        versi_aplikasi: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
fn lapor_sinyal(nama: String, papan: State<'_, Papan>) -> Result<(), String> {
    if !SINYAL.contains(&nama.as_str()) {
        return Err(format!("sinyal tak dikenal: {nama}"));
    }
    papan.catat(&nama);
    Ok(())
}

// ------------------------------------------------------------------ papan

/// Tempat sinyal dikumpulkan. Di luar mode smoke ia hanya terisi dan diabaikan;
/// biayanya nol dan keberadaannya membuat jalur yang diuji CI persis sama
/// dengan jalur yang dipakai sehari-hari.
#[derive(Default)]
struct Papan {
    terlihat: Mutex<Vec<String>>,
    berubah: Condvar,
}

impl Papan {
    fn catat(&self, nama: &str) {
        let mut terlihat = self.terlihat.lock().expect("papan sinyal teracuni");
        if !terlihat.iter().any(|s| s == nama) {
            terlihat.push(nama.to_string());
        }
        self.berubah.notify_all();
    }
}

// ---------------------------------------------------------------- pengawas

#[derive(Serialize)]
struct Laporan {
    lulus: bool,
    diminta: Vec<&'static str>,
    diterima: Vec<String>,
    hilang: Vec<&'static str>,
    detik: f64,
    platform: &'static str,
    arsitektur: &'static str,
}

/// Mode smoke: jalankan aplikasinya sungguhan, tunggu sinyalnya, lalu keluar
/// dengan kode yang berarti. Langkah CI yang hijau belum tentu mengerjakan
/// sesuatu — ini yang membedakan "terbangun" dari "terbuka dan hidup".
fn awasi(handle: tauri::AppHandle, batas: Duration, tujuan: PathBuf) {
    std::thread::spawn(move || {
        let papan = handle.state::<Papan>();
        let mulai = Instant::now();

        let mut terlihat = papan.terlihat.lock().expect("papan sinyal teracuni");
        while !SINYAL.iter().all(|s| terlihat.iter().any(|t| t == s)) {
            let sisa = match batas.checked_sub(mulai.elapsed()) {
                Some(sisa) if !sisa.is_zero() => sisa,
                _ => break,
            };
            let (berikutnya, _) = papan
                .berubah
                .wait_timeout(terlihat, sisa)
                .expect("papan sinyal teracuni");
            terlihat = berikutnya;
        }
        let diterima: Vec<String> = terlihat.clone();
        drop(terlihat);

        let hilang: Vec<&'static str> = SINYAL
            .iter()
            .copied()
            .filter(|s| !diterima.iter().any(|t| t == s))
            .collect();

        let laporan = Laporan {
            lulus: hilang.is_empty(),
            diminta: SINYAL.to_vec(),
            diterima,
            hilang: hilang.clone(),
            detik: mulai.elapsed().as_secs_f64(),
            platform: std::env::consts::OS,
            arsitektur: std::env::consts::ARCH,
        };

        let teks = serde_json::to_string_pretty(&laporan)
            .unwrap_or_else(|e| format!("{{\"galat\":\"gagal menulis laporan: {e}\"}}"));

        if let Some(induk) = tujuan.parent() {
            if let Err(e) = std::fs::create_dir_all(induk) {
                eprintln!("smoke: gagal membuat {}: {e}", induk.display());
            }
        }
        if let Err(e) = std::fs::write(&tujuan, &teks) {
            eprintln!("smoke: gagal menulis {}: {e}", tujuan.display());
        }

        if laporan.lulus {
            eprintln!(
                "smoke: lulus — semua sinyal tiba dalam {:.1}s",
                laporan.detik
            );
            std::process::exit(0);
        }

        // Sebutkan apa yang tidak pernah tiba, bukan hanya bahwa sesuatu gagal.
        eprintln!(
            "smoke: gagal setelah {:.1}s — sinyal yang tidak pernah tiba: {}",
            laporan.detik,
            hilang.join(", ")
        );
        eprintln!("{teks}");
        std::process::exit(1);
    });
}

fn mode_smoke() -> bool {
    std::env::var("RANTAI_SMOKE").is_ok_and(|v| v == "1")
}

fn batas_smoke() -> Duration {
    let ms = std::env::var("RANTAI_SMOKE_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(BATAS_BAWAAN_MS);
    Duration::from_millis(ms)
}

fn tujuan_laporan() -> PathBuf {
    std::env::var("RANTAI_SMOKE_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("rantai-smoke.json"))
}

// ------------------------------------------------------------------- main

fn main() {
    tauri::Builder::default()
        .manage(Papan::default())
        // Kalau sinyal tidak pernah tiba, pertanyaan pertamanya selalu sama:
        // apakah halamannya termuat, dan dari alamat mana. Tanpa jejak ini,
        // kegagalan mode smoke tampak seperti diam total.
        .on_page_load(|jendela, muatan| {
            if mode_smoke() {
                eprintln!(
                    "smoke: halaman {:?} di {} ({})",
                    muatan.event(),
                    muatan.url(),
                    jendela.label()
                );
            }
        })
        .invoke_handler(tauri::generate_handler![halo, lapor_sinyal])
        .setup(|app| {
            if mode_smoke() {
                awasi(app.handle().clone(), batas_smoke(), tujuan_laporan());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("gagal menjalankan aplikasi Tauri");
}
