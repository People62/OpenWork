# Rantai

Aplikasi desktop dengan pendekatan OpenWork, tapi sisi kliennya diganti: **BE
lokal Rust di dalam Tauri, antarmuka Next.js, bun sebagai perkakas**. Den (server
pusat) dan OpenCode (mesin agen) dipertahankan apa adanya.

Keadaan saat ini: **Fase 0 — kerangka yang berjalan.** Belum ada fitur, dan itu
disengaja. Yang dibuktikan di fase ini hanyalah rantai build dan IPC, di ketiga
webview, sebelum ada satu pun baris fitur yang bergantung padanya.

## Susunan

```
apps/ui                    Next.js, App Router, output: 'export'
apps/desktop/src-tauri     Program Rust — cangkang Tauri dan (mulai Fase 1) BE lokal
.github/workflows          Matriks tiga platform
```

Tauri *adalah* program Rust. BE lokal tidak disambungkan ke Tauri dari luar; ia
ditulis di dalamnya sebagai `#[tauri::command]` dan dipanggil dari antarmuka
lewat `invoke()`. Tidak ada HTTP loopback, port dinamis, CORS, atau token di
antara keduanya.

## Menjalankan

```bash
bun install
bun run dev              # jendela Tauri + next dev
bun run build            # next build --export, lalu installer
bun run typecheck        # tipe antarmuka
bun run rust:lint        # clippy, peringatan dianggap galat
```

Di Linux butuh `libwebkit2gtk-4.1-dev`, `libjavascriptcoregtk-4.1-dev`,
`libsoup-3.0-dev`, `librsvg2-dev`, dan `patchelf`. Di mesin tanpa layar,
jalankan lewat `xvfb-run -a`.

## Mode smoke

Aplikasi bisa dijalankan sebagai pemeriksaan yang mengakhiri dirinya sendiri.
Ia menunggu dua sinyal yang berurutan — yang kedua tidak mungkin tiba kalau
yang pertama tidak:

| Sinyal | Artinya kalau tiba |
|---|---|
| `webview-termuat` | Halaman termuat, bundel jalan, React ter-mount |
| `ipc-bulat` | Jawaban Rust sampai ke layar, lalu kembali lagi ke Rust |

```bash
RANTAI_SMOKE=1 \
RANTAI_SMOKE_REPORT=/tmp/rantai-smoke.json \
xvfb-run -a apps/desktop/src-tauri/target/release/rantai
```

Keduanya tiba: keluar 0. Lewat batas waktu (`RANTAI_SMOKE_TIMEOUT_MS`, bawaan
120000): keluar 1, dan laporannya menyebut sinyal mana yang tidak pernah datang.

**Pakai binary yang dihasilkan `tauri build`, bukan `cargo build`.** Yang
menentukan bukan profil debug atau release, melainkan siapa yang menjalankan
build: `cargo build --release` biasa tetap menghasilkan konteks dev, dan
aplikasinya akan memuat `devUrl` alih-alih hasil export yang tertanam.

Ini sudah menyesatkan dua kali di sini. Mode smoke gagal dengan nol sinyal dan
tampak seperti diam total — padahal aplikasinya hidup, hanya sedang menunggu
server `next dev` yang tidak ada. Jejak page-load yang dicetak mode smoke ada
justru untuk itu: ia menyebut alamat yang dimuat, sehingga `http://localhost:3000`
langsung membedakan "salah build" dari "benar-benar rusak". Yang benar terbaca
`tauri://localhost`.

## Yang berikutnya

| Fase | Isi | Gerbang |
|---|---|---|
| **0** ✅ | Kerangka, satu perintah, CI tiga platform | Installer terbangun dan jendelanya terbuka di CI |
| **1** | SQLite dan migrasi; model domain; tipe TS *dihasilkan* dari Rust | Mengubah bentuk data di Rust memunculkan galat tipe di Next.js |
| **2** | OpenCode dinyalakan/diawasi/dimatikan dari Rust; streaming token | Percakapan penuh bisa dihentikan tanpa proses yatim — termasuk saat binary mesinnya dihilangkan |
| **3** | Antarmuka dipindahkan; alur masuk Den diuji lebih dulu | Dipakai sendiri untuk pekerjaan nyata selama seminggu |
| **4** | Updater, deep link, penandatanganan, notarisasi | Installer terpasang lalu menerima pembaruan otomatis |

Rencana lengkap berikut angka dan risikonya ada di `CLAUDE.md`.
