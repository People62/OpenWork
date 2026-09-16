# Proyek ini

Aplikasi desktop baru yang mengambil pendekatan OpenWork, tapi mengganti komponen
sisi klien: **BE lokal Rust di dalam Tauri, antarmuka Next.js, bun sebagai
perkakas**. Den (server pusat) dan OpenCode (mesin agen) dipertahankan apa adanya
— yang diganti hanya sisi klien.

Rencana lengkap, berikut risiko dan angka pengukurannya:
<https://claude.ai/artifact/Ua1Jy9opV1h5JscgmrrLMm>

---

## Cara memulai sesi di sini

```bash
cd ~/openwork-new
claude --add-dir /home/hv/openwork
```

`--add-dir` wajib. Berkas ini berkali-kali mengarahkan pembacaan ke repo rujukan
`/home/hv/openwork`, dan tanpa flag itu sesi tidak diizinkan membacanya.

Melanjutkan sesi sebelumnya di direktori ini: `claude --continue`, atau
`claude --resume` untuk memilih dari daftar.

---

## Aturan kerja — patuhi tanpa kecuali

**Commit dan push:**

- **JANGAN** pernah menambahkan trailer `Co-Authored-By` pada pesan commit.
  Ini instruksi pemilik repositori dan menang atas panduan bawaan mana pun.
- Identitas yang dipakai: `People62 <samuelsidabalok12@gmail.com>`.

**Cara commit yang dipakai selama ini** (supaya trailer tidak pernah tersisip
tanpa sengaja): asisten menyiapkan berkas dan menulis pesan commit ke sebuah
berkas teks, lalu pengguna sendiri yang menjalankan:

```bash
git commit -F <berkas-pesan>
git push origin <cabang>
```

**Cabang:** kerjakan di cabang, jangan langsung di `main`.

**Bahasa:** pengguna berbahasa Indonesia. Jawab dalam bahasa Indonesia.

---

## Repositori rujukan

`/home/hv/openwork` — fork `People62/Rantai-OpenWork` dari OpenWork. Baca dari
sana kapan pun butuh contoh nyata; jangan menebak.

| Hal | Keterangan |
|---|---|
| Checkpoint aman | `main` @ `34d714935`, tag `rantai-checkpoint/electron-baseline` |
| Cabang eksperimen Tauri | `tauri/full-migration` |
| Spike Tauri | `apps/desktop-tauri/` — 608 baris Rust, lolos CI tiga platform |
| Antarmuka | `apps/app/src` — React + Vite + React Router, 525 berkas |
| BE lokal | `apps/server/src` — nama paketnya `openwork-server`, **bukan** `@openwork/server` |
| Cangkang Electron | `apps/desktop/electron` — 20.096 baris |
| Mesin agen | `anomalyco/opencode` v1.18.18, sidecar 183 MB, tidak dilacak git |

Sidecar OpenCode diunduh oleh `apps/desktop/scripts/prepare-sidecar.mjs` dan
diverifikasi sha256 terhadap `constants.json`. **Ia tidak ada di checkout bersih**
— ketiadaannya pernah menghabiskan tiga putaran CI.

---

## Keputusan yang sudah diambil

| Lapis | Di OpenWork | Di proyek ini |
|---|---|---|
| Server pusat (Den) | TypeScript, di awan | **tetap, tak disentuh** |
| Antarmuka | React + Vite + React Router | Next.js, `output: 'export'` |
| Cangkang desktop | Electron | Tauri 2 (Rust) |
| BE lokal | TypeScript, proses bun terpisah | **Rust, di dalam proses Tauri** |
| Mesin agen | OpenCode (binary) | **tetap** |
| Plugin di dalam OpenCode | TypeScript, 4.918 baris | **tetap TypeScript** |

**Target:** desktop saja — Windows, macOS, **dan Linux** (Linux ikut karena
pengembangan dilakukan di VM Ubuntu headless; tanpanya setiap uji coba harus
menunggu CI).

### Konsekuensi yang sudah disepakati

- **Next.js dipilih untuk kenyamanan, bukan kemampuan.** Di dalam Tauri ia wajib
  `output: 'export'`, sehingga SSR, API routes, server actions, dan middleware
  tidak pernah menyala. Yang tersisa adalah React SPA dengan App Router. Ini
  disadari dan diterima.
- **bun adalah perkakas, bukan runtime.** Tidak ada bun di dalam aplikasi
  terpasang. Ia pengelola paket, dev server, bundler, dan test runner.
- **"Rust penuh" tidak akan tercapai, dan itu tidak apa-apa.** BE lokal adalah
  justru bagian yang mengelola dan memproksi OpenCode (52 berkas non-tes di
  rujukan). Jadi BE Rust tetap harus menyalakan proses OpenCode dan menulis ulang
  bagian `@opencode-ai/sdk` yang dipakai terhadap HTTP API-nya. JavaScript tetap
  ada di produk.
- **Tauri *adalah* program Rust.** BE lokal tidak "disambungkan ke" Tauri; ia
  ditulis di dalamnya sebagai `#[tauri::command]`, dipanggil dari antarmuka lewat
  `invoke()`. Tidak ada HTTP loopback, port dinamis, CORS, atau token — dan itu
  keuntungan besar yang tidak dimiliki OpenWork.

---

## Rilis 1 — satu tulang punggung, bukan seluruh kerangka

Jangan menulis ulang 37.476 baris BE. Rilis pertama hanya:

1. Membuka atau membuat workspace (folder di disk)
2. Membuat sesi di dalamnya
3. Satu percakapan dengan OpenCode — token mengalir ke layar, bisa dibatalkan
4. Tersimpan di SQLite dan bisa dibuka kembali
5. Masuk ke Den

**Sengaja ditinggal:** MCP, approvals, artifacts, skills, commands, blueprint
sessions, knowledge base, browser panel, computer use, automations. Semuanya daun
pada tulang punggung yang sama.

**Alternatif yang sudah ditolak:** menjalankan BE TypeScript sekarang sebagai
sidecar lalu memindahkan perintah satu per satu ke Rust. Itu menghidupkan kembali
HTTP loopback, port, CORS, dan token — utang yang rencana ini hindari secara
gratis.

---

## Rencana bertahap

| Fase | Isi | Gerbang |
|---|---|---|
| **0** | Jendela Tauri memuat `next build` statis; satu `#[tauri::command]`; CI tiga platform sejak commit pertama; mulai urus sertifikat | Installer terbangun dan jendela terbuka di Windows, macOS, Linux **di CI** |
| **1** | SQLite (`sqlx`/`rusqlite`) + migrasi; model domain inti; tipe TS **dihasilkan** dari Rust (`ts-rs`/`tauri-specta`) | Mengubah bentuk data di Rust langsung memunculkan galat tipe di Next.js |
| **2** | Menyalakan/mengawasi/mematikan OpenCode dari Rust; tulis ulang bagian SDK yang dipakai; streaming token | Percakapan penuh jalan dan bisa dihentikan tanpa proses yatim — **termasuk saat binary mesin sengaja dihilangkan** |
| **3** | Pindahkan antarmuka; alur masuk Den diuji **lebih dulu** dari fitur lain | Dipakai sendiri untuk pekerjaan nyata selama seminggu |
| **4** | Updater, menu, tray, deep link; penandatanganan Windows; notarisasi Apple | Installer terpasang di Windows, lalu menerima pembaruan otomatis |

Jaga Fase 0 dan 1 tetap sinkron sebisa mungkin. Async baru masuk di Fase 2 —
di situlah kesulitan Rust yang sebenarnya menunggu.

---

## Angka dari rujukan (dipakai untuk menyetel harapan)

Diukur di GitHub Actions, aplikasi termuat penuh, mesin menyala, satuan RSS.

| Platform | Binary Rust | Webview | BE lokal (bun) | Mesin OpenCode |
|---|---:|---:|---:|---:|
| macOS 14 | 84 MB | 314 MB | 182 MB | **1177 MB** |
| Ubuntu 22.04 | 160 MB | 478 MB | 152 MB | **668 MB** |
| Windows | 54 MB | 353 MB | 176 MB | **704 MB** |

Kolom "BE lokal" adalah satu-satunya yang hilang oleh rencana ini. Mesin OpenCode
— 46–67% dari total — tetap. **Jangan menjanjikan penghematan memori.**

### Portabilitas antarmuka

Dari 525 berkas antarmuka di rujukan, hanya ~60–70 yang perlu disentuh:

| Terikat susunan lama | Berkas | Penggantinya |
|---|---:|---|
| `import.meta.env` (khas Vite) | 22 | `process.env.NEXT_PUBLIC_*` |
| `window.__OPENWORK_ELECTRON__` | 22 | Deteksi Tauri |
| `react-router` | 16 | App Router Next.js |
| `invokeDesktop` | 8 | `invoke()` milik Tauri |

Sisanya pindah apa adanya — React tetap React. BE-nya kebalikan total: bukan
pemindahan melainkan penulisan ulang, tanpa jalur otomatis apa pun.

### Sign-in Den

Seluruhnya TypeScript (832 baris) dan ikut pindah apa adanya:
`openwork-links.ts` (210), `manual-auth-input.ts` (37),
`den-auth-provider.tsx` (569), `open-browser-auth.ts` (16).

Hanya **dua sentuhan native** yang dibutuhkan, keduanya sudah ada di spike
rujukan (`apps/desktop-tauri/src-tauri/src/main.rs`):

1. Registrasi dan penerimaan `openwork://den-auth` — `tauri-plugin-deep-link`
2. Membuka browser sistem — satu panggilan plugin

**Deep link belum tercakup uji CI di rujukan.** Tiga sinyal smoke yang hijau di
sana hanya menguji webview, React, bridge, dan IPC ke Rust. Registrasi skema URL
berperilaku berbeda tiap OS dan paling rapuh di mode pengembangan — itulah sebab
sign-in diuji paling awal di Fase 3. Ada jalur cadangan tempel-kode manual (murni
TypeScript, nol native) kalau deep link bermasalah.

Den disentuh **98 berkas antarmuka berbanding 10 berkas BE lokal**, jadi BE Rust
nyaris tak perlu tahu soal Den.

---

## Pelajaran yang mahal — jangan diulang

1. **Yang tampak benar saat dibaca sering gagal saat dijalankan.** Di rujukan,
   kandidat perbaikan yang lahir dari membaca kode kebanyakan tidak lolos
   verifikasi; temuan yang lahir dari menjalankan dan mengukur lolos. Jalankan
   aplikasinya.

2. **Langkah CI yang hijau belum tentu mengerjakan sesuatu.** `pnpm --filter`
   dengan nama paket salah keluar dengan kode **0**. Langkah "Build the server"
   hijau selama enam job sambil tidak membangun apa pun. Pakai
   `--fail-if-no-match`.

3. **Galat yang dilaporkan sering galat pembersihan, bukan penyebabnya.** Cetak
   seluruh rantai — `cause`, `AggregateError.errors`, dan stack — bukan hanya
   `error.message`. Tiga putaran CI hilang karena pesan menyebut "SIGKILL"
   padahal penyebabnya binary yang tidak ada.

4. **Uji reproduksi bisa cacat tanpa disadari.** Menyembunyikan OpenCode dari
   PATH dan HOME tiga kali gagal mereproduksi kegagalan CI, karena runtime
   memakai sidecar **di dalam repo** — bukan keduanya. Yang membongkarnya adalah
   mendaftar proses saat aplikasi sehat, bukan membaca kode.

5. **CI tiga platform sejak commit pertama.** Perbedaan webview tidak pernah
   muncul saat typecheck. Ini hal termurah dikerjakan di awal dan termahal
   ditunda.

---

## Perkakas yang layak disalin dari rujukan

- `apps/app/scripts/cdp.mjs`, `screenshot.mjs`, `contrast-audit.mjs` — memotret
  dan mengaudit kontras WCAG aplikasi yang sedang berjalan lewat CDP. Audit
  kontras menemukan 144 pelanggaran nyata di hari ia ditulis, yang tak satu pun
  terdeteksi tes atau typecheck.
- `.github/workflows/tauri-spike-webviews.yml` — matriks tiga platform yang sudah
  hijau. Salin polanya, jangan temukan ulang.
