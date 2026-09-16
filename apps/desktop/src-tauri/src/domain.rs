// Model domain inti — padanan workspace, sesi, dan pesan.
//
// Ini tulang punggung Rilis 1 dan tidak lebih: membuka workspace, membuat sesi
// di dalamnya, lalu satu percakapan yang tersimpan dan bisa dibuka kembali. MCP,
// approvals, artifacts, skills, dan sisanya adalah daun pada tulang punggung
// yang sama, dan tak satu pun menahannya.
//
// Setiap tipe di sini menurunkan `specta::Type`, dan dari situlah padanan
// TypeScript-nya dihasilkan. Tidak ada tipe yang ditulis dua kali.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Waktu disimpan sebagai milidetik Unix. SQLite tidak punya tipe waktu asli,
/// dan integer menghindari seluruh urusan parsing zona waktu di perbatasan.
pub type Milidetik = i64;

/// Specta menolak mengekspor i64 ke TypeScript karena `number` kehilangan
/// presisi di atas 2^53, dan penolakan itu benar sebagai aturan umum. Milidetik
/// Unix adalah pengecualiannya: sekitar 1,7 x 10^12, empat ribu kali di bawah
/// batas itu, dan baru menyentuhnya pada tahun 287396. Jadi tiap medan waktu
/// menyatakan sendiri bahwa ia aman sebagai `number` — bukan lewat saklar global
/// yang diam-diam ikut melonggarkan i64 lain yang kelak ditambahkan.

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub nama: String,
    /// Folder sungguhan di disk. Inilah yang membuat workspace bukan sekadar
    /// baris basis data.
    pub jalur: String,
    #[specta(type = f64)]
    pub dibuat_pada: Milidetik,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Sesi {
    pub id: String,
    pub workspace_id: String,
    pub judul: String,
    #[specta(type = f64)]
    pub dibuat_pada: Milidetik,
    #[specta(type = f64)]
    pub diperbarui_pada: Milidetik,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Peran {
    Pengguna,
    Asisten,
}

impl Peran {
    pub fn sebagai_teks(self) -> &'static str {
        match self {
            Peran::Pengguna => "pengguna",
            Peran::Asisten => "asisten",
        }
    }

    pub fn dari_teks(teks: &str) -> Option<Self> {
        match teks {
            "pengguna" => Some(Peran::Pengguna),
            "asisten" => Some(Peran::Asisten),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Pesan {
    pub id: String,
    pub sesi_id: String,
    pub peran: Peran,
    pub isi: String,
    #[specta(type = f64)]
    pub dibuat_pada: Milidetik,
}
