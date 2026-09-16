"use client";

import { useEffect, useState } from "react";
import { PanelMesin } from "./mesin";
import { buka, commands, diDalamTauri, type PeriksaDb, type Sapaan } from "./tauri";

// Tiga sinyal yang menutup gerbang, dan urutannya berarti: yang berikutnya tidak
// mungkin tiba kalau yang sebelumnya tidak. Rust menunggu ketiganya saat
// dijalankan dalam mode smoke di CI.
const SINYAL = [
  "webview-termuat",
  "ipc-bulat",
  "data-bulat",
  "mesin-absen-benar",
] as const;
type Sinyal = (typeof SINYAL)[number];

export default function Beranda() {
  const [sapaan, setSapaan] = useState<Sapaan | null>(null);
  const [periksa, setPeriksa] = useState<PeriksaDb | null>(null);
  const [terkirim, setTerkirim] = useState<Sinyal[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [tauri, setTauri] = useState(false);
  // Workspace sungguhan menyusul di Fase 3; untuk sekarang mesin dijalankan di
  // direktori kerja proses, yang cukup untuk membuktikan alirannya.
  const dirKerja = ".";

  useEffect(() => {
    const ada = diDalamTauri();
    setTauri(ada);
    if (!ada) return;

    let batal = false;
    const tandai = (s: Sinyal) => {
      if (!batal) setTerkirim((sebelum) => [...sebelum, s]);
    };

    (async () => {
      try {
        // Sinyal 1 — halaman termuat, bundel jalan, React ter-mount.
        await buka(commands.laporSinyal("webview-termuat"));
        if (batal) return;
        tandai("webview-termuat");

        const hasil = await commands.halo("Rantai");
        if (batal) return;
        setSapaan(hasil);

        // Sinyal 2 — jawaban Rust sampai kembali ke layar, lalu kembali lagi ke
        // Rust. IPC bulat dua arah, bukan sekadar panggilan yang tidak melempar.
        await buka(commands.laporSinyal("ipc-bulat"));
        if (batal) return;
        tandai("ipc-bulat");

        // Sinyal 3 — SQLite ditulis dan dibaca kembali. Rust melakukannya di
        // dalam transaksi yang dibatalkan, jadi tidak ada baris yang tersisa.
        const db = await buka(commands.periksaBasisData());
        if (batal) return;
        if (!db.tulisBacaUtuh) {
          throw new Error("basis data menulis, tapi yang dibaca kembali berbeda");
        }
        setPeriksa(db);

        await buka(commands.laporSinyal("data-bulat"));
        if (batal) return;
        tandai("data-bulat");

        // Sinyal 4 — hanya diminta kalau CI sengaja menjalankan aplikasi tanpa
        // binary mesin. Gerbang Fase 2 menuntut jalur gagalnya diuji lebih dulu:
        // pesannya harus menyebut penyebabnya, bukan gejala pembersihannya.
        const harapan = await commands.harapanSmoke();
        if (batal) return;
        if (harapan.mesinAbsen) {
          await buktikanMesinAbsen();
          if (batal) return;
          await buka(commands.laporSinyal("mesin-absen-benar"));
          if (batal) return;
          tandai("mesin-absen-benar");
        }
      } catch (e) {
        if (batal) return;
        // Cetak seluruh rantainya, bukan hanya `message` — galat yang
        // dilaporkan sering galat pembersihan, bukan penyebabnya.
        setGalat(rantaiGalat(e));
      }
    })();

    return () => {
      batal = true;
    };
  }, []);

  return (
    <main>
      <header>
        <p className="label">Fase 2 · OpenCode dikelola dari Rust</p>
        <h1>Rantai</h1>
        <p className="lede">
          Tampilannya belum digarap — itu Fase 3. Yang dibuktikan di sini
          alirannya: Next.js ter-export statis termuat di jendela Tauri, IPC ke
          Rust bulat dua arah, SQLite ditulis lalu dibaca kembali utuh, dan
          OpenCode dinyalakan, dialirkan, serta dihentikan dari Rust.
        </p>
      </header>

      {!tauri && (
        <div className="card">
          <p className="label">Di luar Tauri</p>
          <p style={{ margin: 0, color: "var(--muted)" }}>
            Halaman ini dibuka di browser biasa, jadi tidak ada sisi Rust untuk
            diajak bicara. Jalankan <code>bun run dev</code> dari akar repo untuk
            membukanya di dalam jendela Tauri.
          </p>
        </div>
      )}

      {galat && (
        <div className="card">
          <p className="label">Galat</p>
          <pre className="galat">{galat}</pre>
        </div>
      )}

      {tauri && (
        <div className="card">
          <p className="label">Sinyal</p>
          <ul className="sinyal">
            {SINYAL.map((nama) => {
              const sudah = terkirim.includes(nama);
              return (
                <li key={nama}>
                  <span className={sudah ? "pip ok" : "pip wait"}>
                    {sudah ? "tiba" : "menunggu"}
                  </span>
                  {nama}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {periksa && (
        <div className="card">
          <p className="label">Basis data</p>
          <dl>
            <dt>Tulis lalu baca</dt>
            <dd>{periksa.tulisBacaUtuh ? "utuh" : "berbeda"}</dd>
            <dt>Workspace</dt>
            <dd>{periksa.jumlahWorkspace}</dd>
            <dt>Sesi</dt>
            <dd>{periksa.jumlahSesi}</dd>
            <dt>Pesan</dt>
            <dd>{periksa.jumlahPesan}</dd>
          </dl>
        </div>
      )}

      {tauri && <PanelMesin dirKerja={dirKerja} />}

      {sapaan && (
        <div className="card">
          <p className="label">Jawaban dari Rust</p>
          <dl>
            <dt>Pesan</dt>
            <dd>{sapaan.pesan}</dd>
            <dt>Platform</dt>
            <dd>
              {sapaan.platform} · {sapaan.arsitektur}
            </dd>
            <dt>Tauri</dt>
            <dd>{sapaan.versiTauri}</dd>
            <dt>Aplikasi</dt>
            <dd>{sapaan.versiAplikasi}</dd>
          </dl>
        </div>
      )}
    </main>
  );
}

/// Menyalakan mesin ketika binary-nya sengaja tidak ada, dan menuntut pesannya
/// benar. Kalau ia justru berhasil menyala, itu berarti pengujiannya cacat —
/// aplikasi menemukan OpenCode lain — dan itu harus menggagalkan smoke, bukan
/// diam-diam lolos.
async function buktikanMesinAbsen(): Promise<void> {
  const hasil = await commands.nyalakanMesin(".");

  if (hasil.status === "ok") {
    throw new Error(
      "mesin justru menyala padahal binary-nya sengaja dihilangkan — " +
        `ia menemukan ${hasil.data.jalurBinary} lewat ${hasil.data.sumber}. ` +
        "Pengujiannya yang cacat, bukan aplikasinya.",
    );
  }

  const pesan = hasil.error.pesan;

  if (!pesan.includes("tidak ditemukan")) {
    throw new Error(`pesan tidak menyebut inti persoalannya: ${pesan}`);
  }
  if (!pesan.includes("PATH")) {
    throw new Error(`pesan tidak menyebut tempat yang sudah diperiksa: ${pesan}`);
  }

  // Yang paling mahal di Rantai: pesan yang berbicara tentang lapisan
  // pembersihan sementara penyebabnya binary yang tidak ada.
  for (const menyesatkan of ["SIGKILL", "signal", "exit code", "terminated"]) {
    if (pesan.includes(menyesatkan)) {
      throw new Error(
        `pesan menyebut "${menyesatkan}" padahal penyebabnya binary yang tidak ada: ${pesan}`,
      );
    }
  }
}

function rantaiGalat(e: unknown): string {
  const baris: string[] = [];
  let kini: unknown = e;
  let dalam = 0;

  while (kini != null && dalam < 8) {
    if (kini instanceof Error) {
      baris.push(kini.stack ?? `${kini.name}: ${kini.message}`);
      if (kini instanceof AggregateError) {
        for (const sub of kini.errors) baris.push(`  · ${rantaiGalat(sub)}`);
      }
      kini = (kini as { cause?: unknown }).cause;
    } else {
      baris.push(typeof kini === "string" ? kini : JSON.stringify(kini));
      kini = null;
    }
    dalam += 1;
  }

  return baris.join("\n\ndisebabkan oleh:\n");
}
