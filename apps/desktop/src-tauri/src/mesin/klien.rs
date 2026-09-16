// Bagian @opencode-ai/sdk yang dipakai, ditulis ulang terhadap HTTP API-nya.
//
// SDK aslinya jauh lebih luas dari ini. Yang ditulis ulang hanya yang dituntut
// tulang punggung Rilis 1: membuat sesi, mengirim prompt, mengalirkan token,
// dan menghentikannya di tengah. Sisanya menyusul kalau memang dibutuhkan —
// bukan sekarang, dan bukan karena SDK-nya punya.
//
// Endpoint diambil dari /doc milik OpenCode v1.18.18 yang dijalankan langsung,
// bukan dari dokumentasi.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use specta::Type;

use super::Galat;

fn jadi_galat(e: reqwest::Error) -> Galat {
    // Cetak seluruh rantainya. reqwest menyembunyikan penyebab sebenarnya di
    // `source`, dan tanpa ini pesannya sering hanya "error sending request".
    let mut pesan = e.to_string();
    let mut sebab: &dyn std::error::Error = &e;
    while let Some(dalam) = std::error::Error::source(sebab) {
        pesan.push_str(&format!(" -> {dalam}"));
        sebab = dalam;
    }
    Galat::Http(pesan)
}

#[derive(Debug, Clone)]
pub struct Klien {
    http: reqwest::Client,
    alamat: String,
}

/// Hampir setiap jawaban OpenCode dibungkus `{"data": ...}`. Versi pertama
/// klien ini mengurai isinya langsung dan gagal pada panggilan pertama — ketahuan
/// dengan memanggil API-nya, bukan dengan membaca skemanya.
#[derive(Debug, Deserialize)]
struct Bungkus<T> {
    data: T,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SesiMesin {
    pub id: String,
}

/// Model yang benar-benar tersedia, ditanyakan ke mesin.
///
/// Wajib ditanyakan, bukan ditebak: ketersediaan provider bergantung pada
/// direktori kerja mesin. Folder yang sama bisa punya 31 model atau nol,
/// tergantung apakah ia dikenali sebagai proyek.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
}

#[derive(Debug, Serialize)]
struct BadanPrompt<'a> {
    prompt: IsiPrompt<'a>,
}

#[derive(Debug, Serialize)]
struct IsiPrompt<'a> {
    text: &'a str,
}

/// Satu kepingan yang mengalir dari mesin ke layar.
///
/// Ia peristiwa, bukan nilai kembalian — `invoke()` adalah permintaan-jawaban,
/// dan aliran token bukan. Menurunkan `Event` membuat tipenya ikut dihasilkan ke
/// `bindings.ts` berikut pendengarnya, jadi aturan "tidak pernah menulis tipe
/// dua kali" tetap berlaku untuk peristiwa, bukan hanya untuk perintah.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct Kepingan {
    /// Kosong untuk peristiwa yang bukan milik sesi mana pun — aliran global
    /// juga membawa `plugin.added`, `catalog.updated`, dan sejenisnya.
    pub sesi_mesin_id: Option<String>,
    /// Nama peristiwa apa adanya dari mesin. Tidak diterjemahkan di sini —
    /// menerjemahkannya berarti menebak, dan bentuk peristiwa OpenCode berubah
    /// antar-versi.
    pub jenis: String,
    /// Muatan mentah peristiwa, sebagai JSON.
    ///
    /// Sengaja diekspor sebagai `unknown`, bukan dimodelkan. Bentuk peristiwa
    /// OpenCode ditentukan OpenCode dan berubah antar-versi; menuliskannya di
    /// sini berarti menjanjikan kontrak yang tidak kita kuasai, dan janji itu
    /// akan diam-diam meleset pada pembaruan mesin berikutnya. Antarmuka
    /// menyempitkannya sendiri di tempat ia benar-benar dipakai.
    #[specta(type = specta_typescript::Unknown)]
    pub muatan: serde_json::Value,
}

impl Klien {
    pub fn baru(alamat: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            alamat: alamat.into(),
        }
    }

    fn url(&self, jalur: &str) -> String {
        format!("{}{}", self.alamat.trim_end_matches('/'), jalur)
    }

    /// Ketukan kesehatan. Dipakai sesudah proses menyatakan alamatnya, karena
    /// "sudah mendengarkan" dan "siap melayani" bukan hal yang sama.
    pub async fn sehat(&self) -> Result<bool, Galat> {
        let jawaban = self
            .http
            .get(self.url("/api/health"))
            .send()
            .await
            .map_err(jadi_galat)?;
        Ok(jawaban.status().is_success())
    }

    pub async fn daftar_model(&self) -> Result<Vec<Model>, Galat> {
        let jawaban = self
            .http
            .get(self.url("/api/model"))
            .send()
            .await
            .map_err(jadi_galat)?;

        let status = jawaban.status();
        let teks = jawaban.text().await.map_err(jadi_galat)?;
        if !status.is_success() {
            return Err(Galat::Http(format!(
                "daftar model gagal ({status}): {teks}"
            )));
        }

        serde_json::from_str::<Bungkus<Vec<Model>>>(&teks)
            .map(|b| b.data)
            .map_err(|e| Galat::Http(format!("daftar model tak terbaca: {e}; isinya: {teks}")))
    }

    /// Membuat sesi, dengan model yang ditetapkan di sesinya.
    ///
    /// Model **harus** ditetapkan di sini. Skema `/prompt` tidak punya medan
    /// model sama sekali — menyelipkannya di sana diabaikan diam-diam, dan sesi
    /// jatuh ke model bawaan mesin. Di mesin uji, bawaan itu adalah tier gratis
    /// OpenCode yang menolak dipakai dari luar aplikasi OpenCode.
    pub async fn buat_sesi(&self, model: Option<&Model>) -> Result<SesiMesin, Galat> {
        let badan = match model {
            Some(m) => serde_json::json!({
                "model": { "providerID": m.provider_id, "id": m.id }
            }),
            None => serde_json::json!({}),
        };

        let jawaban = self
            .http
            .post(self.url("/api/session"))
            .json(&badan)
            .send()
            .await
            .map_err(jadi_galat)?;

        let status = jawaban.status();
        let teks = jawaban.text().await.map_err(jadi_galat)?;
        if !status.is_success() {
            return Err(Galat::Http(format!(
                "membuat sesi gagal ({status}): {teks}"
            )));
        }

        serde_json::from_str::<Bungkus<SesiMesin>>(&teks)
            .map(|b| b.data)
            .map_err(|e| Galat::Http(format!("jawaban sesi tak terbaca: {e}; isinya: {teks}")))
    }

    pub async fn kirim_prompt(&self, sesi_mesin_id: &str, teks: &str) -> Result<(), Galat> {
        let jawaban = self
            .http
            .post(self.url(&format!("/api/session/{sesi_mesin_id}/prompt")))
            .json(&BadanPrompt {
                prompt: IsiPrompt { text: teks },
            })
            .send()
            .await
            .map_err(jadi_galat)?;

        let status = jawaban.status();
        if !status.is_success() {
            let teks = jawaban.text().await.unwrap_or_default();
            return Err(Galat::Http(format!("prompt ditolak ({status}): {teks}")));
        }
        Ok(())
    }

    /// Inilah yang menutup gerbang Fase 2: percakapan harus bisa dihentikan di
    /// tengah.
    pub async fn hentikan(&self, sesi_mesin_id: &str) -> Result<(), Galat> {
        let jawaban = self
            .http
            .post(self.url(&format!("/api/session/{sesi_mesin_id}/interrupt")))
            .send()
            .await
            .map_err(jadi_galat)?;

        let status = jawaban.status();
        if !status.is_success() {
            let teks = jawaban.text().await.unwrap_or_default();
            return Err(Galat::Http(format!(
                "menghentikan sesi gagal ({status}): {teks}"
            )));
        }
        Ok(())
    }

    /// Membuka aliran peristiwa dan memanggil `pada_kepingan` untuk tiap
    /// peristiwa milik sesi ini, sampai giliran selesai atau `batal` menyala.
    ///
    /// **Memakai aliran global `/api/event`, bukan `/api/session/{id}/event`.**
    /// Keduanya ada, dan perbedaannya baru terlihat saat dijalankan: aliran
    /// per-sesi bersifat durable dan kasar — ia hanya mengirim `text.started`
    /// dan `text.ended`, tanpa satu pun token di antaranya. Aliran global yang
    /// membawa `session.next.text.delta`. Satu percakapan sungguhan menghasilkan
    /// 8 peristiwa di aliran per-sesi dan 63 di aliran global.
    ///
    /// Harganya: peristiwa milik sesi lain ikut lewat, jadi disaring di sini.
    ///
    /// SSE diurai sendiri alih-alih memakai pustaka: bentuknya hanya dua jenis
    /// baris, dan satu dependensi lagi tidak sebanding.
    pub async fn alirkan<F>(
        &self,
        sesi_mesin_id: &str,
        batal: tokio::sync::watch::Receiver<bool>,
        mut pada_kepingan: F,
    ) -> Result<(), Galat>
    where
        F: FnMut(Kepingan),
    {
        let jawaban = self
            .http
            .get(self.url("/api/event"))
            .send()
            .await
            .map_err(jadi_galat)?;

        let status = jawaban.status();
        if !status.is_success() {
            let teks = jawaban.text().await.unwrap_or_default();
            return Err(Galat::Http(format!(
                "aliran peristiwa ditolak ({status}): {teks}"
            )));
        }

        let mut aliran = jawaban.bytes_stream();
        let mut sisa = String::new();

        while let Some(potongan) = aliran.next().await {
            if *batal.borrow() {
                break;
            }
            let potongan = potongan.map_err(jadi_galat)?;
            sisa.push_str(&String::from_utf8_lossy(&potongan));

            // Peristiwa SSE dipisahkan baris kosong, dan satu potongan jaringan
            // hampir tidak pernah berisi tepat satu peristiwa.
            while let Some(batas) = sisa.find("\n\n") {
                let blok: String = sisa.drain(..batas + 2).collect();
                let Some(kepingan) = urai_peristiwa(&blok) else {
                    continue;
                };
                if kepingan.sesi_mesin_id.as_deref() != Some(sesi_mesin_id) {
                    continue;
                }
                let akhir = kepingan.jenis == AKHIR_GILIRAN;
                pada_kepingan(kepingan);
                if akhir {
                    return Ok(());
                }
            }
        }

        Ok(())
    }
}

/// Peristiwa yang menandai giliran selesai.
///
/// Satu giliran dengan panggilan alat bisa punya beberapa langkah; untuk Rilis 1
/// yang hanya perlu satu percakapan sederhana, langkah pertama yang berakhir
/// sudah berarti selesai. Ini harus ditinjau ulang begitu alat masuk.
const AKHIR_GILIRAN: &str = "session.next.step.ended";

/// Mengurai satu blok SSE.
///
/// OpenCode **tidak mengirim baris `event:` sama sekali** — hanya `data:`, dan
/// jenis peristiwanya ada di dalam JSON-nya sebagai medan `type`. Versi pertama
/// pengurai ini membaca baris `event:` dan karena itu melabeli setiap peristiwa
/// "message". Terbaca dengan menangkap alirannya, bukan dengan membaca skema.
fn urai_peristiwa(blok: &str) -> Option<Kepingan> {
    let mut data = String::new();

    for baris in blok.lines() {
        if let Some(sisa) = baris.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(sisa.trim_start());
        }
    }

    if data.is_empty() {
        return None;
    }

    let terurai: serde_json::Value = serde_json::from_str(&data).ok()?;

    let jenis = terurai
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("tanpa-jenis")
        .to_string();

    let muatan = terurai.get("data").cloned().unwrap_or(terurai.clone());

    let sesi_mesin_id = muatan
        .get("sessionID")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());

    Some(Kepingan {
        sesi_mesin_id,
        jenis,
        muatan,
    })
}

#[cfg(test)]
mod tes {
    use super::*;

    /// Blok ini disalin apa adanya dari aliran sungguhan OpenCode v1.18.18 —
    /// bukan dikarang dari skema. Versi pertama tes ini memakai bentuk karangan
    /// dengan baris `event:`, dan lulus dengan gembira sementara kode yang
    /// diujinya tidak akan pernah bekerja terhadap mesin sesungguhnya.
    const BLOK_ASLI: &str = r#"data: {"id":"evt_1","type":"session.next.text.delta","durable":{"aggregateID":"ses_abc","seq":7,"version":1},"data":{"timestamp":1789548855918,"sessionID":"ses_abc","text":"ha"}}

"#;

    #[test]
    fn jenis_dibaca_dari_dalam_json_bukan_dari_baris_event() {
        let k = urai_peristiwa(BLOK_ASLI).expect("seharusnya terurai");
        assert_eq!(k.jenis, "session.next.text.delta");
        assert_eq!(k.sesi_mesin_id.as_deref(), Some("ses_abc"));
        assert_eq!(k.muatan["text"], "ha");
    }

    #[test]
    fn peristiwa_tanpa_sesi_tetap_terurai_tapi_tanpa_pemilik() {
        // Aliran global juga membawa hal-hal seperti ini, dan ia harus disaring
        // di pemanggil — bukan diam-diam dianggap milik sesi yang sedang aktif.
        let blok = r#"data: {"id":"evt_2","type":"plugin.added","data":{"name":"sesuatu"}}

"#;
        let k = urai_peristiwa(blok).expect("seharusnya terurai");
        assert_eq!(k.jenis, "plugin.added");
        assert_eq!(k.sesi_mesin_id, None);
    }

    #[test]
    fn data_bertingkat_digabung() {
        let blok = "data: {\"type\":\"x\",\ndata: \"data\":{\"sessionID\":\"ses_1\"}}\n\n";
        let k = urai_peristiwa(blok).expect("seharusnya terurai");
        assert_eq!(k.jenis, "x");
        assert_eq!(k.sesi_mesin_id.as_deref(), Some("ses_1"));
    }

    #[test]
    fn blok_tanpa_data_diabaikan() {
        assert!(urai_peristiwa(": ketukan hidup\n\n").is_none());
    }

    #[test]
    fn data_yang_bukan_json_diabaikan() {
        // Sebelumnya ia disimpan sebagai teks dan lolos ke antarmuka sebagai
        // peristiwa palsu tanpa jenis.
        assert!(urai_peristiwa("data: bukan json\n\n").is_none());
    }

    #[test]
    fn akhir_giliran_adalah_step_ended() {
        let blok = r#"data: {"type":"session.next.step.ended","data":{"sessionID":"ses_abc"}}

"#;
        let k = urai_peristiwa(blok).expect("seharusnya terurai");
        assert_eq!(k.jenis, AKHIR_GILIRAN);
    }
}
