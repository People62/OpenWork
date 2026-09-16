// Mode smoke — dipakai CI untuk membedakan "terbangun" dari "terbuka dan hidup".
//
// Aplikasinya dijalankan sungguhan, menunggu sinyal yang berurutan, lalu keluar
// dengan kode yang berarti. Langkah CI yang hijau belum tentu mengerjakan
// sesuatu; ini yang membuatnya mengerjakan sesuatu.

use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use specta::Type;
use tauri::{Manager, State};

/// Urutannya berarti: sinyal berikutnya tidak mungkin tiba kalau yang sebelumnya
/// tidak.
///
///   1. `webview-termuat` — halaman termuat, bundel jalan, React ter-mount
///   2. `ipc-bulat`       — jawaban Rust sampai ke layar lalu kembali ke Rust
///   3. `data-bulat`      — data ditulis ke SQLite lalu dibaca kembali utuh
const SINYAL_INTI: [&str; 3] = ["webview-termuat", "ipc-bulat", "data-bulat"];

/// Sinyal keempat, hanya diminta kalau CI memang menjalankan aplikasi tanpa
/// binary mesin. Gerbang Fase 2 menuntutnya secara eksplisit: jalankan tanpa
/// binary mesin, dan pastikan pesannya benar.
///
/// Ia dipisahkan karena OpenCode 176 MB dan tidak ikut di dalam repo. Menguji
/// *ketiadaannya* justru tidak butuh unduhan apa pun — jadi bagian gerbang ini
/// bisa berjalan di tiap putaran CI, di ketiga platform, dengan harga nol.
const SINYAL_MESIN_ABSEN: &str = "mesin-absen-benar";

/// Kalau ini menyala, aplikasi dijalankan dengan RANTAI_OPENCODE yang sengaja
/// menunjuk ketiadaan, dan antarmuka wajib membuktikan pesannya benar.
pub fn mesin_absen_diharapkan() -> bool {
    std::env::var("RANTAI_SMOKE_MESIN_ABSEN").is_ok_and(|v| v == "1")
}

fn sinyal_diminta() -> Vec<&'static str> {
    let mut sinyal = SINYAL_INTI.to_vec();
    if mesin_absen_diharapkan() {
        sinyal.push(SINYAL_MESIN_ABSEN);
    }
    sinyal
}

/// Diberitahukan ke antarmuka supaya ia tahu pemeriksaan mana yang harus
/// dijalankan. Tanpa ini, antarmuka harus menebak — dan menebak di jalur gagal
/// adalah persis cara tes menjadi cacat tanpa disadari.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HarapanSmoke {
    pub aktif: bool,
    pub mesin_absen: bool,
}

#[tauri::command]
#[specta::specta]
pub fn harapan_smoke() -> HarapanSmoke {
    HarapanSmoke {
        aktif: aktif(),
        mesin_absen: mesin_absen_diharapkan(),
    }
}

const BATAS_BAWAAN_MS: u64 = 120_000;

/// Tempat sinyal dikumpulkan. Di luar mode smoke ia hanya terisi dan diabaikan;
/// biayanya nol, dan keberadaannya membuat jalur yang diuji CI persis sama
/// dengan jalur yang dipakai sehari-hari.
#[derive(Default)]
pub struct Papan {
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

#[tauri::command]
#[specta::specta]
pub fn lapor_sinyal(nama: String, papan: State<'_, Papan>) -> Result<(), String> {
    if !sinyal_diminta().contains(&nama.as_str()) {
        return Err(format!("sinyal tak dikenal: {nama}"));
    }
    papan.catat(&nama);
    Ok(())
}

#[derive(Serialize, Type)]
struct Laporan {
    lulus: bool,
    diminta: Vec<&'static str>,
    diterima: Vec<String>,
    hilang: Vec<&'static str>,
    detik: f64,
    platform: &'static str,
    arsitektur: &'static str,
}

pub fn aktif() -> bool {
    std::env::var("RANTAI_SMOKE").is_ok_and(|v| v == "1")
}

fn batas() -> Duration {
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

/// Mematikan mesin sebelum proses berakhir. Dipanggil di tiap jalan keluar
/// pengawas — lulus maupun gagal.
fn matikan_mesin_dulu(handle: &tauri::AppHandle) {
    let mesin = handle.state::<crate::mesin::Mesin>();
    if let Err(e) = tauri::async_runtime::block_on(mesin.matikan()) {
        eprintln!("smoke: gagal mematikan mesin saat keluar: {e}");
    }
}

pub fn awasi(handle: tauri::AppHandle) {
    let batas = batas();
    let tujuan = tujuan_laporan();

    std::thread::spawn(move || {
        let papan = handle.state::<Papan>();
        let mulai = Instant::now();

        let diminta = sinyal_diminta();
        let mut terlihat = papan.terlihat.lock().expect("papan sinyal teracuni");
        while !diminta.iter().all(|s| terlihat.iter().any(|t| t == s)) {
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

        let hilang: Vec<&'static str> = diminta
            .iter()
            .copied()
            .filter(|s| !diterima.iter().any(|t| t == s))
            .collect();

        let laporan = Laporan {
            lulus: hilang.is_empty(),
            diminta: diminta.clone(),
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

        // std::process::exit tidak menjalankan destructor, jadi `kill_on_drop`
        // pada proses anak tidak pernah menyala. Tanpa baris ini, tiap kali
        // mode smoke keluar ia meninggalkan OpenCode hidup dan dipungut init —
        // yang ditemukan dengan mendaftar proses sesudah percobaan, bukan
        // dengan membaca kode.
        matikan_mesin_dulu(&handle);

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
