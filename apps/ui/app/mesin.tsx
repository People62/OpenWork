"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buka,
  commands,
  events,
  type Kepingan,
  type Selesai,
  type StatusMesin,
} from "./tauri";

/// Satu percakapan dengan OpenCode: mesin dinyalakan dari Rust, token mengalir
/// sebagai peristiwa, dan tombol berhenti benar-benar menghentikannya.
///
/// Ini tulang punggung Rilis 1 dalam bentuk paling telanjang. Tampilannya akan
/// diganti di Fase 3; yang dibuktikan di sini adalah alirannya, bukan rupanya.
export function PanelMesin({ dirKerja }: { dirKerja: string }) {
  const [status, setStatus] = useState<StatusMesin | null>(null);
  const [sibuk, setSibuk] = useState<string | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [sesiMesinId, setSesiMesinId] = useState<string | null>(null);
  const [teks, setTeks] = useState("");
  const [mengalir, setMengalir] = useState(false);
  const [kepingan, setKepingan] = useState<Kepingan[]>([]);
  const [selesai, setSelesai] = useState<Selesai | null>(null);
  const akhir = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void commands.statusMesin().then((h) => {
      if (h.status === "ok") setStatus(h.data);
    });

    // Pendengar ini bertipe karena tipenya dihasilkan dari Rust — sama seperti
    // perintah. Peristiwa tidak dikecualikan dari aturan itu.
    const lepasKepingan = events.kepingan.listen((e) => {
      setKepingan((sebelum) => [...sebelum, e.payload]);
    });
    const lepasSelesai = events.selesai.listen((e) => {
      setMengalir(false);
      setSelesai(e.payload);
    });

    return () => {
      void lepasKepingan.then((lepas) => lepas());
      void lepasSelesai.then((lepas) => lepas());
    };
  }, []);

  useEffect(() => {
    akhir.current?.scrollIntoView({ block: "end" });
  }, [kepingan.length]);

  const jalankan = useCallback(
    async (nama: string, kerja: () => Promise<void>) => {
      setSibuk(nama);
      setGalat(null);
      try {
        await kerja();
      } catch (e) {
        setGalat(e instanceof Error ? e.message : String(e));
      } finally {
        setSibuk(null);
      }
    },
    [],
  );

  const nyalakan = () =>
    jalankan("menyalakan", async () => {
      setStatus(await buka(commands.nyalakanMesin(dirKerja)));
    });

  const matikan = () =>
    jalankan("mematikan", async () => {
      setStatus(await buka(commands.matikanMesin()));
      setSesiMesinId(null);
    });

  const buatSesi = () =>
    jalankan("membuat sesi", async () => {
      setSesiMesinId(await buka(commands.buatSesiMesin()));
      setKepingan([]);
      setSelesai(null);
    });

  const kirim = () =>
    jalankan("mengirim", async () => {
      if (!sesiMesinId) return;
      setKepingan([]);
      setSelesai(null);
      setMengalir(true);
      try {
        await buka(commands.kirimPrompt(sesiMesinId, teks));
      } catch (e) {
        setMengalir(false);
        throw e;
      }
    });

  const hentikan = () =>
    jalankan("menghentikan", async () => {
      if (!sesiMesinId) return;
      await buka(commands.hentikanPercakapan(sesiMesinId));
    });

  return (
    <div className="card">
      <p className="label">Mesin OpenCode</p>

      <dl>
        <dt>Keadaan</dt>
        <dd>{status?.menyala ? "menyala" : "mati"}</dd>
        {status?.alamat && (
          <>
            <dt>Alamat</dt>
            <dd>{status.alamat}</dd>
          </>
        )}
        {status?.jalurBinary && (
          <>
            <dt>Binary</dt>
            <dd>
              {status.jalurBinary} ({status.sumber})
            </dd>
          </>
        )}
        {sesiMesinId && (
          <>
            <dt>Sesi mesin</dt>
            <dd>{sesiMesinId}</dd>
          </>
        )}
      </dl>

      <div className="tombol-baris">
        <button onClick={nyalakan} disabled={!!sibuk || status?.menyala}>
          Nyalakan
        </button>
        <button onClick={matikan} disabled={!!sibuk || !status?.menyala}>
          Matikan
        </button>
        <button onClick={buatSesi} disabled={!!sibuk || !status?.menyala}>
          Sesi baru
        </button>
      </div>

      {sesiMesinId && (
        <>
          <textarea
            value={teks}
            onChange={(e) => setTeks(e.target.value)}
            placeholder="Tulis sesuatu untuk mesin…"
            rows={3}
          />
          <div className="tombol-baris">
            <button onClick={kirim} disabled={!!sibuk || mengalir || !teks.trim()}>
              Kirim
            </button>
            <button onClick={hentikan} disabled={!mengalir}>
              Berhenti
            </button>
            {mengalir && <span className="pip wait">mengalir</span>}
          </div>
        </>
      )}

      {galat && <pre className="galat">{galat}</pre>}

      {selesai && (
        <p className="label">
          {selesai.dibatalkan
            ? "aliran dihentikan"
            : selesai.galat
              ? `aliran berhenti: ${selesai.galat}`
              : "aliran selesai"}
        </p>
      )}

      {kepingan.length > 0 && (
        <div className="aliran">
          {kepingan.map((k, i) => (
            <div key={i} className="kepingan">
              <span className="pip ok">{k.jenis}</span>
              <pre>{ringkas(k.muatan)}</pre>
            </div>
          ))}
          <div ref={akhir} />
        </div>
      )}
    </div>
  );
}

/// Muatan peristiwa sengaja bertipe `unknown` — bentuknya ditentukan OpenCode,
/// bukan oleh kita. Penyempitannya dilakukan di sini, di satu tempat.
function ringkas(muatan: unknown): string {
  const teks = typeof muatan === "string" ? muatan : JSON.stringify(muatan);
  return teks.length > 400 ? `${teks.slice(0, 400)}…` : teks;
}
