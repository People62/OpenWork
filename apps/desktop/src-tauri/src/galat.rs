// Satu tipe galat untuk seluruh perbatasan perintah.
//
// Galat yang dilaporkan sering galat pembersihan, bukan penyebabnya — jadi
// varian di sini menyimpan pesan asli dari lapisan bawah, bukan menggantinya
// dengan kalimat yang lebih rapi tapi kehilangan isi.

use serde::Serialize;
use specta::Type;

#[derive(Debug, Serialize, Type)]
#[serde(tag = "jenis", content = "pesan", rename_all = "camelCase")]
pub enum Galat {
    /// Basis data menolak, gagal dibuka, atau migrasinya tidak jalan.
    BasisData(String),
    /// Yang diminta tidak ada. Dipisahkan dari BasisData karena antarmuka
    /// biasanya ingin memperlakukannya lain — bukan kegagalan, hanya kosong.
    TidakDitemukan(String),
    /// Masukan dari antarmuka tidak masuk akal sebelum menyentuh basis data.
    MasukanTakSah(String),
}

impl std::fmt::Display for Galat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Galat::BasisData(p) => write!(f, "basis data: {p}"),
            Galat::TidakDitemukan(p) => write!(f, "tidak ditemukan: {p}"),
            Galat::MasukanTakSah(p) => write!(f, "masukan tak sah: {p}"),
        }
    }
}

impl std::error::Error for Galat {}

impl From<rusqlite::Error> for Galat {
    fn from(e: rusqlite::Error) -> Self {
        Galat::BasisData(e.to_string())
    }
}

impl From<rusqlite_migration::Error> for Galat {
    fn from(e: rusqlite_migration::Error) -> Self {
        Galat::BasisData(format!("migrasi: {e}"))
    }
}
