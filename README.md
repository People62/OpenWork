# Rantai

Aplikasi desktop dengan pendekatan OpenWork, tapi sisi kliennya diganti: **BE
lokal Rust di dalam Tauri, antarmuka Next.js, bun sebagai perkakas**. Den (server
pusat) dan OpenCode (mesin agen) dipertahankan apa adanya.

Keadaan saat ini: **Fase 2 — OpenCode dikelola dari Rust.** Mesin dinyalakan,
diawasi, dan dimatikan dari dalam proses Tauri; bagian `@opencode-ai/sdk` yang
dipakai ditulis ulang terhadap HTTP API-nya; token mengalir ke layar sebagai
peristiwa bertipe dan bisa dihentikan di tengah.

## Susunan

```
apps/ui                    Next.js, App Router, output: 'export'
  app/bindings.ts          Dihasilkan dari Rust — jangan disunting tangan
apps/desktop/src-tauri     Program Rust — cangkang Tauri sekaligus BE lokal
  src/domain.rs            Workspace, sesi, pesan
  src/db.rs                Koneksi SQLite dan migrasinya
  src/perintah.rs          Perbatasan ke antarmuka — #[tauri::command]
  src/galat.rs             Satu tipe galat untuk seluruh perbatasan
  src/mesin/temukan.rs     Mencari binary OpenCode, dan menyebut di mana saja sudah dicari
  src/mesin/mod.rs         Menyalakan, mengawasi, mematikan proses mesin
  src/mesin/klien.rs       Bagian SDK yang dipakai, ditulis ulang terhadap HTTP API
  src/percakapan.rs        Streaming token sebagai peristiwa, dan penghentiannya
  src/smoke.rs             Mode pemeriksaan yang dipakai CI
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
bun run rust:test        # tes Rust; ini juga yang menulis bindings.ts
```

## Tipe dihasilkan, tidak ditulis dua kali

`apps/ui/app/bindings.ts` dihasilkan dari daftar perintah di Rust oleh
`cargo test`, lewat `tauri-specta`. Ia tidak pernah disunting tangan, dan CI
menuntut `git diff` atasnya bersih.

Akibatnya, mengubah bentuk data di Rust memunculkan galat tipe di Next.js —
itulah gerbang Fase 1, dan sudah diuji dengan benar-benar mengganti nama satu
medan: `tulis_baca_utuh` jadi `tulis_baca_benar` membuat `tsc` menolak di dua
tempat, menyebut baris dan propertinya.

Perintah yang mengembalikan `Result` di Rust tidak melempar di TypeScript; ia
mengembalikan `{ status: "ok" | "error" }`, sehingga kode yang mengabaikan
cabang galatnya tidak lolos typecheck. Pembungkus `buka()` di `app/tauri.ts`
mengubahnya jadi `throw` bagi pemanggil yang lebih suka `try/catch`, tanpa
kehilangan tipe galatnya.

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
| `data-bulat` | SQLite ditulis lalu dibaca kembali utuh |
| `mesin-absen-benar` | Ketiadaan binary mesin menghasilkan pesan yang benar |

```bash
RANTAI_SMOKE=1 \
RANTAI_SMOKE_REPORT=/tmp/rantai-smoke.json \
xvfb-run -a apps/desktop/src-tauri/target/release/rantai
```

Semuanya tiba: keluar 0. Lewat batas waktu (`RANTAI_SMOKE_TIMEOUT_MS`, bawaan
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

## Mesin OpenCode

Binary-nya tidak ikut di dalam repo — 176 MB, dan diunduh terpisah. Untuk
menjalankannya dari sini, arahkan saja:

```bash
export RANTAI_OPENCODE=/jalur/ke/opencode
bun run dev
```

Urutan pencariannya: timpaan `RANTAI_OPENCODE`, lalu sidecar di sebelah
aplikasi, baru `PATH`. **PATH sengaja terakhir** supaya OpenCode yang kebetulan
terpasang di mesin pengembang tidak pernah diam-diam menutupi sidecar yang tidak
ikut terbawa ke dalam paket — kekeliruan itu sudah pernah membuat tiga percobaan
reproduksi di Rantai sia-sia.

Kalau binary-nya tidak ketemu, pesannya menyebut **tiap tempat yang sudah
diperiksa**. Itu bukan kemewahan: di Rantai, binary mesin yang hilang
menghasilkan pesan yang menyebut "SIGKILL" — gejala pembersihannya, bukan
penyebabnya — dan tiga putaran CI habis mengejar hal yang salah. Ada tes yang
secara khusus menuntut pesan itu **tidak** menyebut sinyal atau exit code.

### Tidak ada proses yatim

`kill_on_drop` saja tidak cukup: ia hanya berlaku pada jalur drop yang normal,
dan `std::process::exit` tidak menjalankan destructor. Mesin karena itu dimatikan
di dua jalan keluar yang pasti dilewati — `RunEvent::Exit` milik Tauri, dan
pengawas mode smoke. Ini ditemukan dengan mendaftar proses sesudah percobaan,
bukan dengan membaca kode: versi pertamanya meninggalkan OpenCode hidup dan
dipungut `init`.

## Yang berikutnya

| Fase | Isi | Gerbang |
|---|---|---|
| **0** ✅ | Kerangka, satu perintah, CI tiga platform | Installer terbangun dan jendelanya terbuka di CI |
| **1** ✅ | SQLite dan migrasi; model domain; tipe TS *dihasilkan* dari Rust | Mengubah bentuk data di Rust memunculkan galat tipe di Next.js |
| **2** ◐ | OpenCode dinyalakan/diawasi/dimatikan dari Rust; streaming token | Percakapan penuh bisa dihentikan tanpa proses yatim — termasuk saat binary mesinnya dihilangkan |
| **3** | Antarmuka dipindahkan; alur masuk Den diuji lebih dulu | Dipakai sendiri untuk pekerjaan nyata selama seminggu |
| **4** | Updater, deep link, penandatanganan, notarisasi | Installer terpasang lalu menerima pembaruan otomatis |

Rencana lengkap berikut angka dan risikonya ada di `CLAUDE.md`.
