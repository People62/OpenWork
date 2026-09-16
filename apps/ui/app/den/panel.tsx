"use client";

import { useCallback, useEffect, useState } from "react";
import { buka, commands, events, type StatusTautan } from "../tauri";
import {
  DEN_BAWAAN,
  uraiTautanMasuk,
  uraiTempelanManual,
  type TautanMasukDen,
} from "./tautan";

/// Alur masuk Den, digarap paling awal di Fase 3 dengan sengaja.
///
/// Dari seluruh alur masuk, hanya dua hal yang native: menerima
/// `openwork://den-auth` dari sistem, dan membuka browser sistem. Sisanya
/// TypeScript yang pindah apa adanya. Kedua hal native itulah yang paling
/// rapuh — registrasi skema URL berperilaku berbeda tiap OS, paling rapuh di
/// mode pengembangan, dan di Rantai tidak pernah tercakup uji CI sama sekali.
///
/// Karena itu layar ini menampilkan keadaan registrasinya apa adanya, dan
/// selalu menyediakan jalur tempel manual di sebelahnya. Jalur itu murni
/// TypeScript, nol native, dan bekerja bahkan ketika deep link tidak.
export function PanelDen() {
  const [status, setStatus] = useState<StatusTautan | null>(null);
  const [tempelan, setTempelan] = useState("");
  const [diterima, setDiterima] = useState<TautanMasukDen | null>(null);
  const [asal, setAsal] = useState<"deep-link" | "tempel" | null>(null);
  const [galat, setGalat] = useState<string | null>(null);

  const terima = useCallback((urls: string[]) => {
    for (const url of urls) {
      const terurai = uraiTautanMasuk(url);
      if (terurai) {
        setDiterima(terurai);
        setAsal("deep-link");
        setGalat(null);
        return;
      }
    }
    // Tautan yang tiba tapi tidak dikenali bukan hal yang boleh didiamkan —
    // ia berarti Den mengirim bentuk yang belum kita tangani.
    if (urls.length > 0) {
      setGalat(`tautan tiba tapi tidak dikenali: ${urls.join(", ")}`);
    }
  }, []);

  useEffect(() => {
    void commands.statusTautanDalam().then(setStatus);

    // Dibaca lebih dulu, baru mendengarkan. Tautan yang *meluncurkan* aplikasi
    // tiba sebelum halaman ini ada — dan itu justru kasus yang paling sering
    // pada alur masuk: pengguna mengklik tautan sementara aplikasi belum
    // berjalan. Ia dibaca, bukan dikuras, supaya pemeriksa smoke juga bisa
    // membacanya; versi pertamanya menguras dan keduanya saling mendahului.
    void commands.tautanPeluncuran().then(terima);

    const lepas = events.tautanDalam.listen((e) => terima(e.payload.urls));

    return () => {
      void lepas.then((l) => l());
    };
  }, [terima]);

  const daftarkan = useCallback(async () => {
    setGalat(null);
    try {
      setStatus(await buka(commands.daftarkanTautanDalam()));
    } catch (e) {
      setGalat(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const bukaBrowser = useCallback(async () => {
    setGalat(null);
    try {
      await buka(commands.bukaDiBrowser(`${DEN_BAWAAN}/desktop-auth`));
    } catch (e) {
      setGalat(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const tempel = useCallback(() => {
    const terurai = uraiTempelanManual(tempelan);
    if (!terurai) {
      setGalat(
        "tempelan tidak dikenali — tempelkan tautan openwork://den-auth… atau kodenya saja",
      );
      return;
    }
    setDiterima(terurai);
    setAsal("tempel");
    setGalat(null);
  }, [tempelan]);

  return (
    <div className="card">
      <p className="label">Masuk ke Den</p>

      <dl>
        <dt>Skema</dt>
        <dd>{status ? `${status.skema}://` : "…"}</dd>
        <dt>Terdaftar di sistem</dt>
        <dd>
          {status === null
            ? "…"
            : status.galat
              ? `tidak bisa ditanyakan — ${status.galat}`
              : status.terdaftar
                ? "ya"
                : "belum"}
        </dd>
        <dt>Den</dt>
        <dd>{DEN_BAWAAN}</dd>
      </dl>

      <div className="tombol-baris">
        <button onClick={daftarkan} disabled={status?.terdaftar === true}>
          Daftarkan skema
        </button>
        <button onClick={bukaBrowser}>Buka browser</button>
      </div>

      <p className="label" style={{ marginTop: 20 }}>
        Jalur cadangan — tempel sendiri
      </p>
      <textarea
        value={tempelan}
        onChange={(e) => setTempelan(e.target.value)}
        placeholder="openwork://den-auth?grant=… atau kodenya saja"
        rows={2}
      />
      <div className="tombol-baris">
        <button onClick={tempel} disabled={!tempelan.trim()}>
          Pakai tempelan
        </button>
      </div>

      {galat && <pre className="galat">{galat}</pre>}

      {diterima && (
        <>
          <p className="label" style={{ marginTop: 20 }}>
            Grant diterima lewat {asal === "deep-link" ? "deep link" : "tempelan"}
          </p>
          <dl>
            <dt>Grant</dt>
            {/* Hanya awalannya. Grant adalah kredensial, dan layar bisa terekam
                tangkapan layar atau bagikan-layar. */}
            <dd>{diterima.grant.slice(0, 8)}… ({diterima.grant.length} karakter)</dd>
            <dt>Den</dt>
            <dd>{diterima.denBaseUrl}</dd>
          </dl>
          <p className="label">
            Penukaran grant jadi sesi menyusul — itu klien Den, dan ia
            TypeScript yang pindah apa adanya.
          </p>
        </>
      )}
    </div>
  );
}
