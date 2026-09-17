# Rantai

Aplikasi desktop dengan pendekatan OpenWork, tapi sisi kliennya diganti: **BE
lokal Rust di dalam Tauri, antarmuka Next.js, bun sebagai perkakas**. Den (server
pusat) dan OpenCode (mesin agen) dipertahankan apa adanya.

Keadaan saat ini: **Fase 3 — antarmuka dipindahkan**, dimulai dari alur masuk
Den. Dua sentuhan native-nya — menerima `openwork://den-auth` dan membuka
browser sistem — sudah berdiri dan **diuji di CI**, sesuatu yang tidak pernah
tercakup di Rantai.

## Bahasa

Seluruh kode — nama, komentar, dan doc-comment — berbahasa Inggris. Dokumen ini
dan pesan commit berbahasa Indonesia. Pemisahannya disengaja: doc-comment Rust
ikut terbawa ke `bindings.ts` yang dihasilkan, jadi bahasa campur di dalam kode
akan bocor ke berkas yang dihasilkan.

Satu pengecualian yang disengaja: migrasi pertama di `src/db.rs` tetap memakai
nama tabel dan kolom berbahasa Indonesia, karena ia sudah pernah dijalankan pada
basis data yang beredar. Migrasi kedualah yang menggantinya. Migrasi yang
disunting sesudah pernah berjalan di suatu tempat bukan lagi migrasi.

## Sistem desain

Token warna, tipografi, dan 42 komponen antarmuka dipindahkan dari OpenWork.
`colors.css` dan `tailwind-theme.css` disalin tanpa perubahan sama sekali — ia
lapisan token, dan menyuntingnya di sini berarti dua definisi untuk palet yang
sama.

Tidak satu pun dari 42 komponen itu menyentuh `fetch`, `/api/`, atau
`invokeDesktop`. Itulah sebabnya rupanya bisa pindah lebih dulu, jauh sebelum BE
Rust tumbuh cukup untuk layar-layar yang memakainya.

Yang belum ikut: 91 berkas antarmuka rujukan yang memanggil BE lokal lewat HTTP.
Menyalin layar yang memanggil perintah yang tidak ada hanya menghasilkan layar
yang rusak.

### Memeriksa tampilan

```bash
bun run audit    # kontras WCAG AA, tiap rute, kedua tema
bun run shot     # tangkapan layar ke .shots/
```

Perubahan tampilan adalah satu-satunya jenis perubahan yang tidak bisa diperiksa
suite tes. Audit dijalankan terhadap hasil export di Chrome headless — Tauri
memakai webview sistem dan tidak satu pun dari ketiganya berbicara CDP, tapi yang
diukur adalah lembar gayanya, dan itu sama saja.

Audit ini langsung menemukan dua pelanggaran nyata pada hari ia dipasang: teks
teredam pada baris terpilih jatuh ke 4,29:1, kurang dari 4,5:1 yang dituntut AA.
Tokennya benar; permukaannya yang salah — `--dls-active` adalah `tinted-5`,
langkah yang diperuntukkan sebagai latar komponen, bukan untuk dipasangi teks
langkah 11. Penanda terpilih kini garis di tepi kiri, bukan latar yang lebih
gelap.

## Susunan

```
apps/ui                    Next.js, App Router, output: 'export'
  app/bindings.ts          Dihasilkan dari Rust — jangan disunting tangan
  app/den/                 Alur masuk Den: pengurai tautan dan layarnya
  app/workspace/           Workspace, sesi, dan percakapan tersimpan
apps/desktop/src-tauri     Program Rust — cangkang Tauri sekaligus BE lokal
  src/domain.rs            Workspace, session, message
  src/db.rs                Koneksi SQLite dan migrasinya
  src/commands.rs          Perbatasan ke antarmuka — #[tauri::command]
  src/error.rs             Satu tipe galat untuk seluruh perbatasan
  src/engine/locate.rs     Mencari binary OpenCode, dan menyebut di mana saja sudah dicari
  src/engine/mod.rs        Menyalakan, mengawasi, mematikan proses mesin
  src/engine/client.rs     Bagian SDK yang dipakai, ditulis ulang terhadap HTTP API
  src/conversation.rs      Streaming token sebagai peristiwa, dan penghentiannya
  src/deeplink.rs          Deep link openwork:// dan membuka browser sistem
  src/smoke.rs             Mode pemeriksaan yang dipakai CI
.github/workflows          Matriks tiga platform
```

Tauri *adalah* program Rust. BE lokal tidak disambungkan ke Tauri dari luar; ia
ditulis di dalamnya sebagai `#[tauri::command]` dan dipanggil dari antarmuka
lewat `invoke()`. Tidak ada HTTP loopback, port dinamis, CORS, atau token di
antara keduanya.

## Menjalankan saat mengembangkan

Ada dua cara, dan mana yang benar tergantung apa yang sedang Anda ubah.

### Tampilan saja — di peramban, muat ulang seketika

```bash
cd apps/ui
bun run dev:mock          # http://localhost:3000
```

Ini menjalankan antarmukanya tanpa Tauri dan tanpa Rust, dengan data tiruan
supaya layarnya benar-benar terender. Perubahan pada komponen, gaya, dan tata
letak langsung terlihat tanpa membangun ulang apa pun.

Cocok untuk mesin pengembangan tanpa layar yang disunting lewat VS Code Remote:
VS Code meneruskan porta 3000 sendiri, jadi halamannya terbuka di peramban mesin
Anda.

Tiruannya menyala **hanya** kalau ketiga hal ini benar: berjalan di peramban,
tidak ada Tauri sungguhan, dan `NEXT_PUBLIC_RANTAI_MOCK=1`. Bendera itu wajib
dan tidak disimpulkan dari `NODE_ENV` — tiruan yang memutuskan sendiri kapan
menyala adalah tiruan yang suatu hari menyala di aplikasi terpasang. Ia juga
menulis peringatan ke konsol tiap kali aktif.

Fixture-nya, `apps/ui/app/dev-fixtures.json`, dipakai bersama oleh audit kontras.
Dua kumpulan data pura-pura akan melenceng satu sama lain, dan yang diaudit jadi
bukan yang dilihat.

**Batasnya:** tidak ada mesin OpenCode, tidak ada SQLite, tidak ada deep link.
Tombol yang memanggil perintah Rust akan menjawab dari data tiruan, bukan dari
apa pun yang nyata.

### Aplikasi utuh — jendela Tauri sungguhan

```bash
bun run dev               # dari akar repo
```

Ini membangun Rust, menyalakan `next dev`, dan membuka jendela Tauri. **Ia butuh
layar** — pada mesin tanpa layar, jendelanya tidak akan terlihat.

Untuk mesin dengan layar, siapkan mesinnya juga:

```bash
export RANTAI_OPENCODE=/jalur/ke/opencode   # atau jalankan `bun run sidecar`
```

Perubahan pada berkas TypeScript tetap muat ulang seketika. Perubahan pada Rust
menuntut jendelanya ditutup dan `bun run dev` dijalankan lagi.

## Menjalankan

```bash
bun install
bun run dev              # jendela Tauri + next dev
bun run build            # next build --export, lalu installer
bun run typecheck        # tipe antarmuka
bun run rust:lint        # clippy, peringatan dianggap galat
bun run rust:test        # tes Rust; ini juga yang menulis bindings.ts
bun run test             # tes antarmuka
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
| `webview-loaded` | Halaman termuat, bundel jalan, React ter-mount |
| `ipc-roundtrip` | Jawaban Rust sampai ke layar, lalu kembali lagi ke Rust |
| `data-roundtrip` | SQLite ditulis lalu dibaca kembali utuh |
| `engine-absent-correct` | Ketiadaan binary mesin menghasilkan pesan yang benar |
| `deep-link-received` | `openwork://den-auth` sampai ke layar dengan grant yang benar |
| `data-persisted` | Data ditulis, aplikasi ditutup, lalu dibaca kembali utuh |

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

Binary-nya diunduh oleh `apps/desktop/scripts/prepare-sidecar.mjs` dan
**diverifikasi terhadap sha256 yang dipatok** di `apps/desktop/opencode.json`.
Ketidakcocokan menghentikan build.

```bash
bun run sidecar     # unduh, verifikasi, taruh di src-tauri/binaries/
```

Implementasi rujukan menghitung hash lalu mencatatnya sesudahnya, tapi tidak
pernah membandingkannya dengan nilai yang diketahui — jadi unduhan 176 MB itu
terverifikasi terhadap tidak apa-apa selain URL asalnya. Lubang itu ditutup di
sini.

### Mesin dikirim sebagai resource, bukan externalBin

Keputusan ini diambil dengan mencoba keduanya. Sebagai `externalBin` ia mendarat
di `usr/bin` bersebelahan dengan aplikasi — dan `linuxdeploy`, saat membangun
AppImage, menjalankan `patchelf` pada tiap ELF yang ditemukannya di sana. Itu
**merusak** OpenCode: salinan di dalam AppDir menghasilkan core dump, dan
linuxdeploy berhenti dengan "Failed to run ldd".

Sebagai resource ia mendarat di direktori resource, yang tidak diperlakukan
begitu, dan bit eksekusinya tetap utuh. Diukur pada `.deb`: salinannya
byte-identik dengan aslinya dan menjawab `--version` dengan benar.


### Model harus ditanyakan, tidak pernah ditebak

Ketersediaan provider di OpenCode **bergantung pada direktori kerja mesin**.
Folder yang sama bisa punya puluhan model atau nol, tergantung apakah OpenCode
mengenalinya sebagai proyek. Diukur di mesin pengembangan: akar repo ini
memberi 31 model, `~` memberi nol.

Model juga harus ditetapkan pada **sesinya**, bukan pada prompt — skema
`/prompt` tidak punya medan model sama sekali, dan menyelipkannya di sana
diabaikan diam-diam. Sesi tanpa model jatuh ke bawaan mesin, dan kalau bawaan
itu tidak bisa dipakai, **kegagalannya tidak muncul di aliran peristiwa sama
sekali** — hanya di log mesin. Antarmuka akan tampak menggantung tanpa sebab.

Kredensial provider dibaca dari lingkungan proses mesin, misalnya
`MINIMAX_API_KEY`. Karena mesin adalah proses anak, ia mewarisi lingkungan
aplikasi.

### Token mengalir dari `/api/event`, bukan dari aliran sesi

OpenCode punya dua aliran, dan perbedaannya baru terlihat saat dijalankan:

| Aliran | Isi |
|---|---|
| `/api/session/{id}/event` | durable dan kasar — `text.started` lalu `text.ended`, tanpa token |
| `/api/event` | membawa `session.next.text.delta` dan `reasoning.delta` |

Satu percakapan yang sama menghasilkan **8 peristiwa** di aliran per-sesi dan
**63** di aliran global. Karena itu klien memakai aliran global dan menyaring
berdasarkan `sessionID`.

Aliran ini juga **tidak mengirim baris `event:` sama sekali** — hanya `data:`,
dengan jenis peristiwa di dalam JSON-nya sebagai medan `type`.

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

## Bentuk CI

Satu perubahan yang di-merge memicu **dua** putaran tiga platform, bukan tiga:

| Kapan | Apa |
|---|---|
| Pull request | matriks tiga platform + typecheck, clippy, tes |
| Merge ke main | workflow rilis: bangun, jalankan, terbitkan installer |

Matriks tidak lagi berjalan sesudah merge. Proteksi cabang menuntut PR hijau
*dan* mutakhir terhadap main, jadi hasil merge-nya adalah commit yang sudah
diuji — menjalankannya lagi tidak memberi tahu siapa pun apa pun.

Tiap job platform menjalankan aplikasi **tiga kali**, bukan tujuh. Tiap
peluncuran memancarkan tiga sinyal inti, jadi peluncuran yang hanya memeriksa
itu adalah pengulangan belaka. Dan harapannya menumpuk: satu proses bisa diminta
membuktikan mesin menyala dari bundel, tautan dalam sampai, dan data tertulis —
sekaligus. Hanya dua hal yang benar-benar butuh prosesnya sendiri: membaca data
kembali sesudah yang pertama mati, dan berjalan tanpa mesinnya.

## Tersimpan dan bisa dibuka kembali

Rilis 1 menjanjikan percakapan "tersimpan di SQLite dan bisa dibuka kembali".
Itu hanya terbukti dengan menjalankan aplikasi **dua kali**: sekali menulis,
sekali membaca sesudah prosesnya benar-benar mati. Tes dalam satu proses bisa
lulus sepenuhnya dari cache di memori tanpa satu byte pun menyentuh disk.

CI melakukan persis itu di ketiga platform, dan tanda yang tidak pernah ditulis
sudah dibuktikan benar-benar menggagalkannya.

## Alur masuk Den

Dari seluruh alur masuk, hanya dua hal yang native: menerima
`openwork://den-auth` dari sistem, dan membuka browser sistem. Sisanya
TypeScript yang pindah apa adanya.

Kedua hal native itu digarap paling awal di Fase 3 dengan sengaja. Registrasi
skema URL berperilaku berbeda tiap sistem operasi, paling rapuh justru di mode
pengembangan, dan **di Rantai ia tidak pernah tercakup uji CI sama sekali**.

Sekarang ia diuji. CI meluncurkan aplikasi dengan `openwork://den-auth?grant=…`
dan menuntut grant yang benar sampai ke layar. Tautan yang tidak sampai, atau
sampai dengan grant lain, menggagalkan CI — keduanya sudah dibuktikan bisa
gagal, bukan hanya diasumsikan.

Di Linux dan Windows sistem menyerahkan tautan lewat argumen baris perintah.
macOS memakai Apple Events, jadi di sana ia berjalan sebagai penyelidikan yang
tidak memblokir sampai jalurnya diketahui.

### Tautan peluncuran dibaca, bukan dikuras

Tautan yang *meluncurkan* aplikasi tiba jauh sebelum halaman termuat — dan itu
justru kasus yang paling sering: pengguna mengklik tautan sementara aplikasi
belum berjalan. Ia karena itu dicatat sebagai fakta yang bisa dibaca berulang,
bukan sebagai antrean yang dikuras. Versi pertama kehilangannya sama sekali;
versi kedua mengurasnya dan dua pembaca saling mendahului. Keduanya ketahuan
dengan menjalankan, bukan dengan membaca.

### Pendaftaran skema saat aplikasi dijalankan

Aplikasi mendaftarkan `openwork://` saat start, dan hanya kalau ia belum
terdaftar. Installer menanganinya di Windows dan macOS; Linux yang membutuhkannya
saat runtime, dan build pengembangan membutuhkannya di mana pun karena tidak ada
yang memasangnya.

Kegagalannya tidak fatal — justru itu alasan jalur tempel manual ada.

Di VM pengembangan yang minimal, pendaftarannya **gagal sebagian**: berkas
`.desktop`-nya tertulis dengan benar, tapi `update-desktop-database` tidak
terpasang sehingga basis data MIME tidak disegarkan. Galat aslinya hanya berbunyi
"No such file or directory (os error 2)" — tidak menyebut berkas maupun
perbaikannya. Pesannya kini menambahkan keduanya.

### Jalur cadangan

Selalu ada kotak tempel manual di sebelahnya: pengguna menempel tautan utuh atau
kodenya saja. Murni TypeScript, nol native, dan karena itu satu-satunya bagian
alur masuk yang pasti bekerja di mana pun deep link bermasalah.

## Pembaruan otomatis

Updater punya kunci penandatangannya sendiri, dibuat lokal dengan
`tauri signer generate`. Ia **bukan** sertifikat penandatanganan sistem operasi —
keduanya hal berbeda. Kunci ini membuktikan sebuah pembaruan datang dari
repositori ini, dan gratis. Penandatanganan OS-lah yang membungkam SmartScreen
dan Gatekeeper, dan proyek ini sengaja berjalan tanpanya.

Kunci privatnya ada di GitHub Secrets repositori ini. **Kalau ia hilang, tidak
ada pembaruan yang bisa mencapai aplikasi yang sudah terpasang di mana pun.**

### Pembaruan digerakkan tag, bukan build bergulir

`main-terbaru` selalu membawa versi yang tertulis di `tauri.conf.json`, dan
updater hanya menawarkan versi yang *lebih tinggi* dari yang terpasang. Manifest
dari build bergulir karena itu tidak akan pernah memicu pembaruan — ia hanya akan
diambil lalu ditolak, setiap kali.

Untuk mengirim pembaruan: naikkan versi di `tauri.conf.json`, lalu dorong tag
`v*`.

### Pemeriksaan tidak pernah otomatis

Antarmuka yang bertanya, dan antarmuka yang memutuskan. Pembaruan yang memasang
dirinya sendiri saat seseorang sedang di tengah percakapan dengan mesin adalah
hasil yang lebih buruk daripada yang menunggu. Mesin dimatikan lebih dulu sebelum
berkas aplikasi diganti — di Windows, proses anak yang masih hidup bisa mengunci
berkas dan membuat penggantian gagal sama sekali.

## Yang berikutnya

| Fase | Isi | Gerbang |
|---|---|---|
| **0** ✅ | Kerangka, satu perintah, CI tiga platform | Installer terbangun dan jendelanya terbuka di CI |
| **1** ✅ | SQLite dan migrasi; model domain; tipe TS *dihasilkan* dari Rust | Mengubah bentuk data di Rust memunculkan galat tipe di Next.js |
| **2** ◐ | OpenCode dinyalakan/diawasi/dimatikan dari Rust; streaming token | Percakapan penuh bisa dihentikan tanpa proses yatim — termasuk saat binary mesinnya dihilangkan |
| **3** | Antarmuka dipindahkan; alur masuk Den diuji lebih dulu | Dipakai sendiri untuk pekerjaan nyata selama seminggu |
| **4** | Updater, deep link, penandatanganan, notarisasi | Installer terpasang lalu menerima pembaruan otomatis |

Rencana lengkap berikut angka dan risikonya ada di `CLAUDE.md`.
