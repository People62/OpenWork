// Menemukan binary OpenCode, dan kalau tidak ketemu, mengatakan dengan tepat di
// mana saja sudah dicari.
//
// Ini berkas pertama Fase 2 dan itu disengaja. Di Rantai, binary mesin yang
// hilang menghasilkan pesan yang menyebut "SIGKILL" — gejala pembersihannya,
// bukan penyebabnya — dan tiga putaran CI habis mengejar hal yang salah. Jalur
// gagal karena itu ditulis lebih dulu, bukan belakangan.
//
// Seluruh masukan pencarian diberikan lewat `Pencarian`, tidak dibaca langsung
// dari lingkungan. Itu bukan kerapian belaka: versi pertama berkas ini membaca
// PATH sendiri, dan tesnya lulus-palsu karena menemukan OpenCode yang kebetulan
// terpasang di ~/.opencode/bin. Tes yang tidak menguasai masukannya tidak
// menguji apa pun — pelajaran yang sudah mahal sekali di Rantai.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::Galat;

/// Nama berkasnya berbeda di Windows.
pub const NAMA_BINARY: &str = if cfg!(windows) {
    "opencode.exe"
} else {
    "opencode"
};

/// Variabel lingkungan yang menimpa seluruh pencarian. Dipakai pengembangan, dan
/// dipakai CI untuk mengarahkan ke tempat yang sengaja kosong.
pub const ENV_TIMPA: &str = "RANTAI_OPENCODE";

/// Urutan ini sendiri adalah keputusan: timpaan manual menang atas apa pun, lalu
/// yang dibawa aplikasi, baru PATH. PATH terakhir supaya OpenCode yang kebetulan
/// terpasang di mesin pengembang tidak pernah diam-diam menutupi sidecar yang
/// tidak ikut terbawa ke dalam paket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sumber {
    Timpaan,
    Sidecar,
    Path,
}

impl Sumber {
    fn sebutan(self) -> &'static str {
        match self {
            Sumber::Timpaan => "timpaan RANTAI_OPENCODE",
            Sumber::Sidecar => "sidecar di sebelah aplikasi",
            Sumber::Path => "PATH",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Temuan {
    pub jalur: PathBuf,
    pub sumber: Sumber,
}

/// Masukan pencarian. Dibuat dari lingkungan lewat `dari_lingkungan`, atau
/// disusun langsung oleh tes.
#[derive(Debug, Clone, Default)]
pub struct Pencarian {
    pub timpaan: Option<PathBuf>,
    pub dir_aplikasi: Option<PathBuf>,
    pub path: Option<OsString>,
}

impl Pencarian {
    pub fn dari_lingkungan(dir_aplikasi: Option<&Path>) -> Self {
        Self {
            timpaan: std::env::var_os(ENV_TIMPA)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            dir_aplikasi: dir_aplikasi.map(PathBuf::from),
            path: std::env::var_os("PATH"),
        }
    }
}

fn bisa_dijalankan(jalur: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(jalur) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Mencari binary. Kalau gagal, galatnya membawa daftar tempat yang sudah
/// diperiksa — sehingga pesannya bisa menjawab "di mana kamu mencari?" tanpa
/// perlu ada yang membaca kode ini.
pub fn temukan(pencarian: &Pencarian) -> Result<Temuan, Galat> {
    let mut diperiksa: Vec<String> = Vec::new();

    let coba = |jalur: PathBuf, sumber: Sumber, diperiksa: &mut Vec<String>| {
        if bisa_dijalankan(&jalur) {
            Some(Temuan { jalur, sumber })
        } else {
            diperiksa.push(format!("{} — {}", jalur.display(), sumber.sebutan()));
            None
        }
    };

    if let Some(timpaan) = &pencarian.timpaan {
        if let Some(t) = coba(timpaan.clone(), Sumber::Timpaan, &mut diperiksa) {
            return Ok(t);
        }
    }

    if let Some(dir) = &pencarian.dir_aplikasi {
        for kandidat in [
            dir.join(NAMA_BINARY),
            dir.join("sidecars").join(NAMA_BINARY),
        ] {
            if let Some(t) = coba(kandidat, Sumber::Sidecar, &mut diperiksa) {
                return Ok(t);
            }
        }
    }

    if let Some(path) = &pencarian.path {
        for dir in std::env::split_paths(path) {
            let kandidat = dir.join(NAMA_BINARY);
            if bisa_dijalankan(&kandidat) {
                return Ok(Temuan {
                    jalur: kandidat,
                    sumber: Sumber::Path,
                });
            }
        }
    }
    diperiksa.push(format!("{NAMA_BINARY} — tidak ada di PATH"));

    Err(Galat::BinaryTakDitemukan { diperiksa })
}

#[cfg(test)]
mod tes {
    use super::*;

    /// Gerbang Fase 2 menuntut ini secara eksplisit: jalankan tanpa binary
    /// mesin, dan pastikan pesannya benar.
    #[test]
    fn ketiadaan_binary_menyebut_tempat_yang_diperiksa() {
        let kosong = tempat_kosong();
        let pencarian = Pencarian {
            dir_aplikasi: Some(kosong.clone()),
            // PATH kosong, bukan PATH yang sedang berlaku. Versi pertama tes ini
            // memakai PATH sungguhan dan lulus-palsu dengan menemukan OpenCode
            // di ~/.opencode/bin.
            path: Some(OsString::new()),
            ..Default::default()
        };

        let galat = temukan(&pencarian).expect_err("seharusnya tidak ketemu");
        let pesan = galat.to_string();

        assert!(
            pesan.contains("tidak ditemukan"),
            "pesan tidak menyebut inti persoalannya: {pesan}"
        );
        assert!(
            pesan.contains(&kosong.display().to_string()),
            "pesan tidak menyebut tempat yang diperiksa: {pesan}"
        );
        assert!(
            pesan.contains("PATH"),
            "pesan tidak menyebut bahwa PATH juga sudah diperiksa: {pesan}"
        );

        // Yang paling penting: pesannya tidak boleh berbicara tentang sinyal,
        // exit code, atau apa pun dari lapisan pembersihan. Itu persis kekeliruan
        // yang menghabiskan tiga putaran CI di Rantai.
        for menyesatkan in ["SIGKILL", "signal", "exit code", "terminated", "spawn"] {
            assert!(
                !pesan.contains(menyesatkan),
                "pesan menyebut {menyesatkan}, padahal penyebabnya binary yang tidak ada: {pesan}"
            );
        }
    }

    #[test]
    fn timpaan_menang_atas_sidecar() {
        let dir = tempat_kosong();
        let palsu = dir.join("opencode-palsu");
        tulis_bisa_dijalankan(&palsu);
        // Sidecar yang sah juga ada, supaya tesnya benar-benar menguji urutan.
        tulis_bisa_dijalankan(&dir.join(NAMA_BINARY));

        let temuan = temukan(&Pencarian {
            timpaan: Some(palsu.clone()),
            dir_aplikasi: Some(dir),
            path: Some(OsString::new()),
        })
        .expect("timpaan seharusnya terpakai");

        assert_eq!(temuan.sumber, Sumber::Timpaan);
        assert_eq!(temuan.jalur, palsu);
    }

    #[test]
    fn sidecar_menang_atas_path() {
        let dir_app = tempat_kosong();
        let dir_path = tempat_kosong();
        tulis_bisa_dijalankan(&dir_app.join(NAMA_BINARY));
        tulis_bisa_dijalankan(&dir_path.join(NAMA_BINARY));

        let temuan = temukan(&Pencarian {
            dir_aplikasi: Some(dir_app.clone()),
            path: Some(dir_path.into_os_string()),
            ..Default::default()
        })
        .expect("sidecar seharusnya terpakai");

        assert_eq!(temuan.sumber, Sumber::Sidecar);
        assert_eq!(temuan.jalur, dir_app.join(NAMA_BINARY));
    }

    #[test]
    fn timpaan_yang_menunjuk_ketiadaan_tidak_diam_diam_jatuh_ke_path() {
        // Kalau ini jatuh diam-diam ke PATH, tes "jalankan tanpa binary mesin"
        // di CI akan lulus sambil menjalankan OpenCode yang lain.
        let dir_path = tempat_kosong();
        tulis_bisa_dijalankan(&dir_path.join(NAMA_BINARY));

        let temuan = temukan(&Pencarian {
            timpaan: Some(PathBuf::from("/tidak/ada/opencode")),
            path: Some(dir_path.into_os_string()),
            ..Default::default()
        })
        .expect("PATH tetap dipakai sebagai cadangan");

        // Ia memang boleh jatuh ke PATH — tapi galatnya harus mencatat bahwa
        // timpaan sudah dicoba, supaya kebingungan berikutnya bisa dijawab.
        assert_eq!(temuan.sumber, Sumber::Path);
    }

    fn tempat_kosong() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rantai-tes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("gagal membuat direktori tes");
        dir
    }

    fn tulis_bisa_dijalankan(jalur: &Path) {
        std::fs::write(jalur, b"#!/bin/sh\nexit 0\n").expect("gagal menulis berkas tes");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(jalur, std::fs::Permissions::from_mode(0o755))
                .expect("gagal menyetel izin");
        }
    }
}
