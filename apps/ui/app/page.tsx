"use client";

import { useEffect, useState } from "react";
import { diDalamTauri, halo, laporSinyal, type Sapaan } from "./tauri";

// Dua sinyal yang menutup gerbang Fase 0, dan urutannya berarti: yang kedua
// tidak mungkin terjadi kalau yang pertama tidak. Rust menunggu keduanya saat
// dijalankan dalam mode smoke di CI.
const SINYAL = ["webview-termuat", "ipc-bulat"] as const;
type Sinyal = (typeof SINYAL)[number];

export default function Beranda() {
  const [sapaan, setSapaan] = useState<Sapaan | null>(null);
  const [terkirim, setTerkirim] = useState<Sinyal[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [tauri, setTauri] = useState(false);

  useEffect(() => {
    const ada = diDalamTauri();
    setTauri(ada);
    if (!ada) return;

    let batal = false;

    (async () => {
      try {
        // Sinyal 1 — halaman termuat, bundel jalan, React ter-mount.
        await laporSinyal("webview-termuat");
        if (batal) return;
        setTerkirim((s) => [...s, "webview-termuat"]);

        const hasil = await halo("Rantai");
        if (batal) return;
        setSapaan(hasil);

        // Sinyal 2 — jawaban Rust sampai kembali ke layar, lalu kembali lagi ke
        // Rust. IPC bulat dua arah, bukan sekadar satu panggilan yang tidak
        // melempar galat.
        await laporSinyal("ipc-bulat");
        if (batal) return;
        setTerkirim((s) => [...s, "ipc-bulat"]);
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
        <p className="label">Fase 0 · kerangka yang berjalan</p>
        <h1>Rantai</h1>
        <p className="lede">
          Belum ada fitur di sini. Halaman ini hanya membuktikan satu hal: Next.js
          ter-export statis termuat di dalam jendela Tauri, dan IPC ke Rust bulat
          dua arah.
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
