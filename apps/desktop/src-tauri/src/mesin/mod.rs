// Mesin OpenCode, dikelola dari Rust.
//
// Di OpenWork, bagian ini adalah BE lokal TypeScript yang berjalan sebagai
// proses bun terpisah. Di sini ia tinggal di dalam proses Tauri — tapi OpenCode
// sendiri tetap proses anak, dan tetap 46–67% dari memori. Yang hilang adalah
// lapisan bun di antaranya, bukan mesinnya.
//
// Tiga hal yang harus benar, dan ketiganya sudah pernah salah di Rantai:
//
//   1. Binary yang tidak ada harus mengatakan begitu — bukan menyebut sinyal
//      atau exit code dari lapisan pembersihan.
//   2. Proses anak tidak boleh menjadi yatim saat aplikasi ditutup.
//   3. Percakapan harus bisa dihentikan di tengah tanpa meninggalkan sisa.

pub mod klien;
pub mod temukan;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use specta::Type;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub use temukan::Sumber;

/// Batas menunggu mesin menyatakan dirinya sehat. OpenCode memuat konfigurasi
/// dan plugin saat menyala, jadi ini bukan sepersekian detik.
const BATAS_SIAP: Duration = Duration::from_secs(45);

/// Jeda antar-ketukan ke /api/health saat menunggu.
const JEDA_KETUK: Duration = Duration::from_millis(150);

/// Waktu yang diberikan kepada proses untuk menutup dirinya sendiri sebelum
/// dipaksa.
const BATAS_TUTUP: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum Galat {
    #[error(
        "binary OpenCode tidak ditemukan. Tempat yang diperiksa:\n  {}",
        .diperiksa.join("\n  ")
    )]
    BinaryTakDitemukan { diperiksa: Vec<String> },

    #[error("gagal menjalankan {jalur}: {sebab}")]
    GagalDijalankan { jalur: String, sebab: String },

    #[error(
        "mesin berhenti sebelum siap (kode {kode}). Keluaran terakhirnya:\n  {}",
        .keluaran.join("\n  ")
    )]
    BerhentiSebelumSiap { kode: String, keluaran: Vec<String> },

    #[error(
        "mesin tidak pernah menyatakan siap dalam {detik} detik. Keluaran terakhirnya:\n  {}",
        .keluaran.join("\n  ")
    )]
    TakPernahSiap { detik: u64, keluaran: Vec<String> },

    #[error("mesin belum menyala")]
    BelumMenyala,

    #[error("bicara ke mesin gagal: {0}")]
    Http(String),
}

/// Bentuk galat yang menyeberang ke antarmuka.
///
/// `Galat` sendiri sengaja tidak menurunkan `Type`: ia tipe internal yang
/// variannya akan bertambah, dan bentuk internal itu bukan kontrak. Yang jadi
/// kontrak adalah pesannya — dan justru di situlah seluruh nilai jalur gagal di
/// fase ini berada.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GalatMesin {
    pub pesan: String,
}

impl From<Galat> for GalatMesin {
    fn from(e: Galat) -> Self {
        Self {
            pesan: e.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusMesin {
    pub menyala: bool,
    pub alamat: Option<String>,
    pub jalur_binary: Option<String>,
    pub sumber: Option<String>,
    pub detik_menyala: Option<f64>,
}

/// Proses mesin yang sedang hidup.
struct Hidup {
    anak: Child,
    alamat: String,
    jalur_binary: PathBuf,
    sumber: Sumber,
    sejak: Instant,
}

/// Dipegang Tauri sebagai state. Satu mesin untuk seluruh aplikasi pada Rilis 1;
/// beberapa workspace sekaligus adalah daun, bukan tulang punggung.
#[derive(Default)]
pub struct Mesin {
    hidup: Arc<Mutex<Option<Hidup>>>,
}

impl Mesin {
    pub async fn status(&self) -> StatusMesin {
        match &*self.hidup.lock().await {
            Some(h) => StatusMesin {
                menyala: true,
                alamat: Some(h.alamat.clone()),
                jalur_binary: Some(h.jalur_binary.display().to_string()),
                sumber: Some(format!("{:?}", h.sumber)),
                detik_menyala: Some(h.sejak.elapsed().as_secs_f64()),
            },
            None => StatusMesin {
                menyala: false,
                alamat: None,
                jalur_binary: None,
                sumber: None,
                detik_menyala: None,
            },
        }
    }

    pub async fn alamat(&self) -> Result<String, Galat> {
        self.hidup
            .lock()
            .await
            .as_ref()
            .map(|h| h.alamat.clone())
            .ok_or(Galat::BelumMenyala)
    }

    /// Menyalakan mesin di dalam `dir_kerja`, atau mengembalikan yang sudah
    /// hidup. Galatnya menyebutkan penyebab, bukan gejala.
    pub async fn nyalakan(
        &self,
        dir_kerja: &Path,
        dir_aplikasi: Option<&Path>,
    ) -> Result<StatusMesin, Galat> {
        let mut terkunci = self.hidup.lock().await;
        if terkunci.is_some() {
            drop(terkunci);
            return Ok(self.status().await);
        }

        let temuan = temukan::temukan(&temukan::Pencarian::dari_lingkungan(dir_aplikasi))?;

        let mut anak = Command::new(&temuan.jalur)
            .arg("serve")
            // Port 0 berarti sistem yang memilih. Nomornya dibaca dari keluaran
            // proses, bukan ditebak — dua aplikasi yang memakai port tetap akan
            // bertabrakan, dan tabrakan itu muncul sebagai kegagalan yang
            // terdengar seperti hal lain.
            .arg("--port")
            .arg("0")
            .arg("--hostname")
            .arg("127.0.0.1")
            .current_dir(dir_kerja)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Tanpa ini, menutup jendela meninggalkan OpenCode hidup di latar.
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| Galat::GagalDijalankan {
                jalur: temuan.jalur.display().to_string(),
                sebab: e.to_string(),
            })?;

        let alamat = match tunggu_siap(&mut anak).await {
            Ok(alamat) => alamat,
            Err(e) => {
                // Jangan tinggalkan proses setengah jadi kalau ia gagal siap.
                let _ = anak.kill().await;
                return Err(e);
            }
        };

        // "Sudah mendengarkan" dan "siap melayani" bukan hal yang sama. Baris
        // penanda tadi hanya membuktikan soket terbuka; ketukan ini membuktikan
        // mesinnya menjawab.
        if let Err(e) = tunggu_sehat(&alamat).await {
            let _ = anak.kill().await;
            return Err(e);
        }

        *terkunci = Some(Hidup {
            anak,
            alamat,
            jalur_binary: temuan.jalur,
            sumber: temuan.sumber,
            sejak: Instant::now(),
        });
        drop(terkunci);

        Ok(self.status().await)
    }

    /// Mematikan mesin. Diberi kesempatan menutup dirinya sendiri dulu, lalu
    /// dipaksa. Aman dipanggil saat mesin memang belum menyala.
    pub async fn matikan(&self) -> Result<(), Galat> {
        let Some(mut h) = self.hidup.lock().await.take() else {
            return Ok(());
        };

        let _ = h.anak.start_kill();

        let batas = Instant::now();
        loop {
            match h.anak.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => {}
                Err(_) => break,
            }
            if batas.elapsed() > BATAS_TUTUP {
                break;
            }
            tokio::time::sleep(JEDA_KETUK).await;
        }

        // Kalau sampai di sini ia masih hidup, tunggu sampai benar-benar
        // dituai — supaya tidak meninggalkan zombie.
        let _ = h.anak.kill().await;
        let _ = h.anak.wait().await;
        Ok(())
    }
}

/// Mengetuk /api/health sampai mesin menjawab, atau menyerah.
async fn tunggu_sehat(alamat: &str) -> Result<(), Galat> {
    let klien = klien::Klien::baru(alamat);
    let mulai = Instant::now();
    let mut terakhir = String::from("belum pernah menjawab");

    while mulai.elapsed() < BATAS_SIAP {
        match klien.sehat().await {
            Ok(true) => return Ok(()),
            Ok(false) => terakhir = "menjawab, tapi menyatakan dirinya tidak sehat".into(),
            Err(e) => terakhir = e.to_string(),
        }
        tokio::time::sleep(JEDA_KETUK).await;
    }

    Err(Galat::TakPernahSiap {
        detik: BATAS_SIAP.as_secs(),
        keluaran: vec![format!("{alamat}/api/health — {terakhir}")],
    })
}

/// Menunggu mesin siap, sambil membaca keluarannya.
///
/// Dua hal dipantau sekaligus, dan itu disengaja: baris "listening on" yang
/// memberi alamatnya, dan kematian proses. Kalau hanya alamat yang ditunggu,
/// proses yang mati saat menyala akan tampak sebagai batas waktu terlampaui —
/// pesan yang menyebut hal yang salah.
async fn tunggu_siap(anak: &mut Child) -> Result<String, Galat> {
    let stdout = anak.stdout.take();
    let stderr = anak.stderr.take();

    let (kirim, mut terima) = tokio::sync::mpsc::unbounded_channel::<String>();

    if let Some(keluaran) = stdout {
        let kirim = kirim.clone();
        tokio::spawn(async move {
            let mut baris = BufReader::new(keluaran).lines();
            while let Ok(Some(b)) = baris.next_line().await {
                if kirim.send(b).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(keluaran) = stderr {
        tokio::spawn(async move {
            let mut baris = BufReader::new(keluaran).lines();
            while let Ok(Some(b)) = baris.next_line().await {
                if kirim.send(b).is_err() {
                    break;
                }
            }
        });
    }

    let mulai = Instant::now();
    // Hanya beberapa baris terakhir yang disimpan; keluaran OpenCode bisa
    // panjang, dan yang berguna saat gagal selalu yang terakhir.
    let mut terakhir: Vec<String> = Vec::new();

    loop {
        if let Ok(Some(keadaan)) = anak.try_wait() {
            return Err(Galat::BerhentiSebelumSiap {
                kode: keadaan
                    .code()
                    .map(|k| k.to_string())
                    .unwrap_or_else(|| "tanpa kode".into()),
                keluaran: terakhir,
            });
        }

        if mulai.elapsed() > BATAS_SIAP {
            return Err(Galat::TakPernahSiap {
                detik: BATAS_SIAP.as_secs(),
                keluaran: terakhir,
            });
        }

        match tokio::time::timeout(JEDA_KETUK, terima.recv()).await {
            Ok(Some(baris)) => {
                if let Some(alamat) = alamat_dari(&baris) {
                    return Ok(alamat);
                }
                terakhir.push(baris);
                if terakhir.len() > 12 {
                    terakhir.remove(0);
                }
            }
            Ok(None) => {}
            Err(_) => {}
        }
    }
}

/// Membaca "opencode server listening on http://127.0.0.1:PORT".
fn alamat_dari(baris: &str) -> Option<String> {
    let potongan = baris
        .split_whitespace()
        .find(|k| k.starts_with("http://"))?;
    Some(potongan.trim_end_matches(['.', ',']).to_string())
}

#[cfg(test)]
mod tes {
    use super::*;

    #[test]
    fn membaca_alamat_dari_baris_penanda() {
        assert_eq!(
            alamat_dari("opencode server listening on http://127.0.0.1:47777").as_deref(),
            Some("http://127.0.0.1:47777")
        );
        assert_eq!(alamat_dari("timestamp=... message=loading"), None);
    }

    #[test]
    fn galat_binary_hilang_tidak_menyebut_sinyal() {
        let galat = Galat::BinaryTakDitemukan {
            diperiksa: vec!["/tmp/kosong/opencode — sidecar".into()],
        };
        let pesan = galat.to_string();
        assert!(pesan.contains("tidak ditemukan"));
        assert!(pesan.contains("/tmp/kosong/opencode"));
        assert!(!pesan.contains("SIGKILL"));
    }
}

#[cfg(test)]
mod tes_proses {
    use super::*;

    /// Tes ini menjalankan OpenCode sungguhan. Ia hanya berjalan kalau
    /// `RANTAI_OPENCODE_TES` menunjuk binary yang ada — kalau tidak, ia lewat
    /// tanpa berpura-pura menguji apa pun. Berpura-pura adalah persis kegagalan
    /// yang membuat tiga percobaan reproduksi di Rantai sia-sia.
    fn binary_tes() -> Option<PathBuf> {
        let jalur = PathBuf::from(std::env::var_os("RANTAI_OPENCODE_TES")?);
        jalur.is_file().then_some(jalur)
    }

    #[tokio::test]
    async fn menyala_lalu_mati_tanpa_meninggalkan_yatim() {
        let Some(binary) = binary_tes() else {
            eprintln!("dilewati: RANTAI_OPENCODE_TES tidak menunjuk binary");
            return;
        };

        let dir_kerja = std::env::temp_dir();
        let mesin = Mesin::default();

        let pencarian = temukan::Pencarian {
            timpaan: Some(binary),
            ..Default::default()
        };
        let temuan = temukan::temukan(&pencarian).expect("binary tes seharusnya ketemu");

        let status = nyalakan_dengan(&mesin, &dir_kerja, temuan)
            .await
            .expect("mesin seharusnya menyala");
        assert!(status.menyala);
        let alamat = status.alamat.clone().expect("alamat seharusnya ada");
        assert!(alamat.starts_with("http://127.0.0.1:"));

        // Benar-benar hidup, bukan hanya diklaim hidup.
        let klien = klien::Klien::baru(&alamat);
        assert!(klien.sehat().await.expect("ketukan gagal"));

        // Catat PID-nya supaya bisa diperiksa sesudah dimatikan.
        let pid = mesin
            .hidup
            .lock()
            .await
            .as_ref()
            .and_then(|h| h.anak.id())
            .expect("PID seharusnya ada");

        mesin.matikan().await.expect("mematikan gagal");
        assert!(!mesin.status().await.menyala);

        // Beri sistem sesaat untuk menuai prosesnya, lalu pastikan ia benar-benar
        // tidak ada — bukan sekadar dilepas oleh kita.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            !proses_masih_ada(pid),
            "proses {pid} masih hidup sesudah dimatikan — yatim"
        );
        assert!(
            klien.sehat().await.is_err(),
            "mesin masih menjawab sesudah dimatikan"
        );
    }

    #[cfg(unix)]
    pub(super) fn proses_masih_ada(pid: u32) -> bool {
        Path::new(&format!("/proc/{pid}")).exists()
    }

    #[cfg(not(unix))]
    pub(super) fn proses_masih_ada(_pid: u32) -> bool {
        false
    }

    /// Jalan pintas yang memakai temuan yang sudah ditentukan, supaya tes tidak
    /// bergantung pada lingkungan pencarian.
    async fn nyalakan_dengan(
        mesin: &Mesin,
        dir_kerja: &Path,
        temuan: temukan::Temuan,
    ) -> Result<StatusMesin, Galat> {
        // SAFETY: nilai ini hanya dibaca oleh `Pencarian::dari_lingkungan`, dan
        // tes proses dijalankan berurutan lewat `--test-threads` di CI.
        unsafe { std::env::set_var(temukan::ENV_TIMPA, &temuan.jalur) };
        let hasil = mesin.nyalakan(dir_kerja, None).await;
        unsafe { std::env::remove_var(temukan::ENV_TIMPA) };
        hasil
    }
}

#[cfg(test)]
mod tes_percakapan {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    /// Gerbang Fase 2, diuji lewat kode kita sendiri terhadap model sungguhan.
    ///
    /// Hanya berjalan kalau `RANTAI_OPENCODE_TES` menunjuk binary **dan**
    /// `RANTAI_MODEL_TES` menyebut model dalam bentuk `providerID/id`. Tanpa
    /// keduanya ia lewat sambil mengatakannya — berpura-pura menguji adalah
    /// kegagalan yang lebih buruk daripada tidak menguji.
    ///
    /// Direktori kerjanya penting: ketersediaan provider di OpenCode bergantung
    /// padanya. Dijalankan di akar repo, yang dikenali sebagai proyek.
    #[tokio::test]
    async fn percakapan_penuh_mengalir_lalu_bisa_dihentikan() {
        let (Some(binary), Some(model_teks)) = (
            std::env::var_os("RANTAI_OPENCODE_TES").map(PathBuf::from),
            std::env::var("RANTAI_MODEL_TES").ok(),
        ) else {
            eprintln!("dilewati: RANTAI_OPENCODE_TES dan RANTAI_MODEL_TES belum disetel");
            return;
        };
        if !binary.is_file() {
            eprintln!("dilewati: binary tes tidak ada");
            return;
        }
        let (provider_id, model_id) = model_teks
            .split_once('/')
            .expect("RANTAI_MODEL_TES harus berbentuk providerID/modelID");
        let model = klien::Model {
            provider_id: provider_id.to_string(),
            id: model_id.to_string(),
        };

        // Akar repo: dua tingkat di atas src-tauri.
        let akar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .expect("akar repo tidak ketemu");

        let mesin = Mesin::default();
        // SAFETY: tes ini dijalankan berurutan lewat --test-threads=1.
        unsafe { std::env::set_var(temukan::ENV_TIMPA, &binary) };
        let status = mesin
            .nyalakan(&akar, None)
            .await
            .expect("mesin seharusnya menyala");
        unsafe { std::env::remove_var(temukan::ENV_TIMPA) };

        let klien = klien::Klien::baru(status.alamat.clone().expect("alamat"));

        // Model harus benar-benar tersedia; kalau tidak, kegagalannya nanti
        // tidak muncul di aliran peristiwa sama sekali — hanya di log mesin.
        let tersedia = klien.daftar_model().await.expect("daftar model");
        assert!(
            tersedia
                .iter()
                .any(|m| m.provider_id == model.provider_id && m.id == model.id),
            "model {model_teks} tidak tersedia di {}; yang ada: {:?}",
            akar.display(),
            tersedia.iter().take(5).collect::<Vec<_>>()
        );

        let sesi = klien
            .buat_sesi(Some(&model))
            .await
            .expect("membuat sesi gagal");

        let terkumpul: Arc<StdMutex<Vec<klien::Kepingan>>> = Arc::default();
        let (kirim_batal, terima_batal) = tokio::sync::watch::channel(false);

        let aliran_klien = klien.clone();
        let aliran_sesi = sesi.id.clone();
        let aliran_kumpul = terkumpul.clone();
        let tugas = tokio::spawn(async move {
            aliran_klien
                .alirkan(&aliran_sesi, terima_batal, move |k| {
                    aliran_kumpul.lock().expect("kumpulan teracuni").push(k);
                })
                .await
        });

        // Beri aliran sesaat untuk terbuka sebelum prompt dikirim.
        tokio::time::sleep(Duration::from_millis(500)).await;
        klien
            .kirim_prompt(&sesi.id, "Hitung dari 1 sampai 40, satu angka per baris.")
            .await
            .expect("prompt ditolak");

        // Tunggu token sungguhan mulai mengalir.
        let mulai = Instant::now();
        loop {
            let ada_delta = terkumpul
                .lock()
                .expect("kumpulan teracuni")
                .iter()
                .any(|k| k.jenis.contains("delta"));
            if ada_delta {
                break;
            }
            assert!(
                mulai.elapsed() < Duration::from_secs(90),
                "tidak ada satu pun token dalam 90 detik; peristiwa yang tiba: {:?}",
                terkumpul
                    .lock()
                    .expect("kumpulan teracuni")
                    .iter()
                    .map(|k| k.jenis.clone())
                    .collect::<Vec<_>>()
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        // Hentikan di tengah — inilah yang menutup gerbangnya.
        klien.hentikan(&sesi.id).await.expect("interrupt gagal");
        let _ = kirim_batal.send(true);

        let selesai = tokio::time::timeout(Duration::from_secs(30), tugas).await;
        assert!(
            selesai.is_ok(),
            "aliran tidak berhenti dalam 30 detik sesudah dihentikan"
        );

        // Kunci dilepas sebelum `await` berikutnya. MutexGuard sinkron yang
        // dipegang melewati titik await bisa membuat runtime terkunci — clippy
        // menangkapnya, dan ia benar.
        let (jumlah, jenis, semua_milik_sesi) = {
            let kumpulan = terkumpul.lock().expect("kumpulan teracuni");
            (
                kumpulan.len(),
                kumpulan
                    .iter()
                    .map(|k| k.jenis.clone())
                    .collect::<std::collections::BTreeSet<_>>(),
                kumpulan
                    .iter()
                    .all(|k| k.sesi_mesin_id.as_deref() == Some(sesi.id.as_str())),
            )
        };
        assert!(
            semua_milik_sesi,
            "ada peristiwa milik sesi lain yang lolos saringan"
        );
        eprintln!("percakapan: {jumlah} peristiwa, jenis: {jenis:?}");

        let pid = mesin.hidup.lock().await.as_ref().and_then(|h| h.anak.id());
        mesin.matikan().await.expect("mematikan gagal");
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(pid) = pid {
            assert!(!tes_proses::proses_masih_ada(pid), "proses {pid} yatim");
        }
    }
}
