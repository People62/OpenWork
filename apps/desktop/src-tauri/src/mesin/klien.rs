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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SesiMesin {
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
    pub sesi_mesin_id: String,
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

    pub async fn buat_sesi(&self) -> Result<SesiMesin, Galat> {
        let jawaban = self
            .http
            .post(self.url("/api/session"))
            .json(&serde_json::json!({}))
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

        serde_json::from_str::<SesiMesin>(&teks)
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

    /// Membuka aliran peristiwa sesi dan memanggil `pada_kepingan` untuk tiap
    /// peristiwa yang tiba, sampai aliran tertutup atau `batal` menyala.
    ///
    /// SSE diurai di sini alih-alih memakai pustaka: bentuknya hanya tiga jenis
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
            .get(self.url(&format!("/api/session/{sesi_mesin_id}/event")))
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
                if let Some(kepingan) = urai_peristiwa(sesi_mesin_id, &blok) {
                    pada_kepingan(kepingan);
                }
            }
        }

        Ok(())
    }
}

fn urai_peristiwa(sesi_mesin_id: &str, blok: &str) -> Option<Kepingan> {
    let mut jenis = String::from("message");
    let mut data = String::new();

    for baris in blok.lines() {
        if let Some(sisa) = baris.strip_prefix("event:") {
            jenis = sisa.trim().to_string();
        } else if let Some(sisa) = baris.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(sisa.trim_start());
        }
    }

    if data.is_empty() {
        return None;
    }

    let muatan = serde_json::from_str(&data).unwrap_or(serde_json::Value::String(data));
    Some(Kepingan {
        sesi_mesin_id: sesi_mesin_id.to_string(),
        jenis,
        muatan,
    })
}

#[cfg(test)]
mod tes {
    use super::*;

    #[test]
    fn mengurai_peristiwa_sse() {
        let blok = "event: message.part.updated\ndata: {\"teks\":\"halo\"}\n\n";
        let k = urai_peristiwa("ses_1", blok).expect("seharusnya terurai");
        assert_eq!(k.jenis, "message.part.updated");
        assert_eq!(k.muatan["teks"], "halo");
        assert_eq!(k.sesi_mesin_id, "ses_1");
    }

    #[test]
    fn data_bertingkat_digabung() {
        let blok = "data: baris satu\ndata: baris dua\n\n";
        let k = urai_peristiwa("ses_1", blok).expect("seharusnya terurai");
        // Bukan JSON, jadi disimpan apa adanya sebagai teks.
        assert_eq!(k.muatan, serde_json::json!("baris satu\nbaris dua"));
    }

    #[test]
    fn blok_tanpa_data_diabaikan() {
        assert!(urai_peristiwa("ses_1", ": ketukan hidup\n\n").is_none());
    }
}
