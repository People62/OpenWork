// Dua sentuhan native yang dibutuhkan alur masuk Den, dan tidak lebih.
//
// Seluruh sisa alur masuk Den adalah TypeScript yang pindah apa adanya. Yang
// tidak bisa pindah hanya dua hal ini: menerima `openwork://den-auth` dari
// sistem, dan membuka browser sistem.
//
// Ia digarap paling awal di Fase 3 dengan sengaja. Registrasi skema URL
// berperilaku berbeda di tiap sistem operasi, paling rapuh justru di mode
// pengembangan, dan **tidak pernah tercakup uji CI di Rantai** — tiga sinyal
// yang hijau di sana hanya menguji webview, React, bridge, dan IPC. Jadi ini
// bagian dengan ketidakpastian tertinggi di seluruh fase, dan yang paling tidak
// boleh ditemukan rusak di akhir.
//
// Ada jalur cadangan tempel-kode manual — murni TypeScript, nol native — kalau
// deep link bermasalah di suatu platform.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;

/// Skema yang didaftarkan. Sama dengan yang dipakai OpenWork, supaya tautan yang
/// sudah beredar tetap berfungsi.
pub const SKEMA: &str = "openwork";

/// Tiba saat sistem menyerahkan `openwork://…` kepada aplikasi.
///
/// Dikirim sebagai peristiwa bertipe, bukan `CustomEvent` lewat `webview.eval`
/// seperti di spike Rantai. Spike itu harus meniru bentuk peristiwa Electron
/// karena antarmukanya belum berubah; di sini tidak ada yang perlu ditiru, dan
/// peristiwa bertipe ikut terbawa ke `bindings.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TautanDalam {
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusTautan {
    pub skema: String,
    /// Apakah sistem benar-benar menyerahkan skema ini kepada kita. Ditanyakan
    /// ke sistem, bukan diasumsikan dari keberhasilan pendaftaran.
    pub terdaftar: bool,
    /// Terisi kalau sistem menolak menjawab — di beberapa lingkungan (mis. CI
    /// headless) pertanyaannya sendiri gagal, dan itu bukan hal yang sama
    /// dengan "tidak terdaftar".
    pub galat: Option<String>,
}

/// Tautan yang *meluncurkan* aplikasi.
///
/// Ia tiba di `setup`, jauh sebelum halaman termuat dan pendengar React
/// terpasang — jadi kalau ia hanya dikirim sebagai peristiwa, ia hilang tanpa
/// jejak. Justru kasus inilah yang paling sering terjadi pada alur masuk:
/// pengguna mengklik tautan di browser sementara aplikasi belum berjalan.
///
/// Ditemukan dengan menjalankan aplikasi dengan tautan sebagai argumen dan
/// membaca urutan jejaknya: "tautan dalam diterima" tercetak sebelum "halaman
/// Finished".
///
/// **Dibaca, bukan dikuras.** Versi pertamanya menguras, dan dua pembaca —
/// panel Den dan pemeriksa smoke — saling mendahului sehingga salah satunya
/// selalu mendapat daftar kosong. Tautan peluncuran adalah fakta tetap tentang
/// jalannya aplikasi ini, jadi membacanya berulang kali memang benar. Tautan
/// yang datang sesudahnya dikirim sebagai peristiwa saja.
#[derive(Default)]
pub struct Peluncuran {
    urls: Mutex<Vec<String>>,
}

#[tauri::command]
#[specta::specta]
pub fn tautan_peluncuran(peluncuran: State<'_, Peluncuran>) -> Vec<String> {
    peluncuran
        .urls
        .lock()
        .expect("tautan peluncuran teracuni")
        .clone()
}

#[tauri::command]
#[specta::specta]
pub fn status_tautan_dalam(app: AppHandle) -> StatusTautan {
    use tauri_plugin_deep_link::DeepLinkExt;

    match app.deep_link().is_registered(SKEMA) {
        Ok(terdaftar) => StatusTautan {
            skema: SKEMA.to_string(),
            terdaftar,
            galat: None,
        },
        Err(e) => StatusTautan {
            skema: SKEMA.to_string(),
            terdaftar: false,
            galat: Some(e.to_string()),
        },
    }
}

#[tauri::command]
#[specta::specta]
pub fn daftarkan_tautan_dalam(app: AppHandle) -> Result<StatusTautan, String> {
    use tauri_plugin_deep_link::DeepLinkExt;

    app.deep_link()
        .register(SKEMA)
        .map_err(|e| format!("gagal mendaftarkan skema {SKEMA}://: {e}"))?;
    Ok(status_tautan_dalam(app))
}

/// Membuka browser sistem. Sentuhan native kedua, dan satu-satunya yang lain.
///
/// Alur masuk Den mengirim pengguna ke halaman web, lalu menunggu kembali lewat
/// deep link. Membukanya di dalam webview aplikasi tidak bisa: sesi dan cookie
/// di sana bukan sesi browser pengguna.
#[tauri::command]
#[specta::specta]
pub fn buka_di_browser(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    // Hanya http/https. Tanpa penjagaan ini, sebuah URL yang datang dari Den
    // bisa menyuruh sistem membuka apa saja.
    let terurai = url::Url::parse(&url).map_err(|e| format!("URL tak sah: {e}"))?;
    if !matches!(terurai.scheme(), "http" | "https") {
        return Err(format!(
            "menolak membuka skema {}; hanya http dan https",
            terurai.scheme()
        ));
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("gagal membuka browser: {e}"))
}

/// Menyambungkan penerimaan deep link ke peristiwa bertipe.
pub fn pasang(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // Tautan yang memicu peluncuran dicatat sebagai fakta, lalu tetap dikirim
    // sebagai peristiwa untuk antarmuka yang kebetulan sudah siap.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        let urls: Vec<String> = urls.into_iter().map(|u| u.to_string()).collect();
        if !urls.is_empty() {
            app.state::<Peluncuran>()
                .urls
                .lock()
                .expect("tautan peluncuran teracuni")
                .extend(urls.iter().cloned());
        }
        kirim(app, urls);
    }

    let penerima = app.clone();
    app.deep_link().on_open_url(move |peristiwa| {
        let urls: Vec<String> = peristiwa.urls().iter().map(|u| u.to_string()).collect();
        kirim(&penerima, urls);
    });
}

fn kirim(app: &AppHandle, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    if crate::smoke::aktif() {
        // Deep link adalah bagian paling rapuh dan paling tidak terpantau dari
        // alur masuk. Kalau ia tidak sampai, jejak inilah yang membedakan
        // "tidak pernah diserahkan sistem" dari "sampai tapi tidak dikenali".
        eprintln!("smoke: tautan dalam diterima: {urls:?}");
    }
    if app.get_webview_window("utama").is_none() {
        eprintln!("tautan dalam tiba sebelum jendela ada: {urls:?}");
    }
    if let Err(e) = (TautanDalam { urls }).emit(app) {
        eprintln!("gagal mengirim peristiwa tautan dalam: {e}");
    }
}
