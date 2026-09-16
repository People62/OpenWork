// Keadaan tulang punggung Rilis 1: workspace yang dipilih, sesi yang dibuka,
// dan pesan di dalamnya.
//
// Semua kebenarannya ada di SQLite lewat perintah Rust; hook ini hanya cermin
// yang menyegarkan diri. Tidak ada salinan yang bertahan di memori lebih lama
// dari yang dibutuhkan layar — dua sumber kebenaran untuk hal yang sama selalu
// berakhir berbeda, dan itu justru yang dihindari sejak Fase 1.

"use client";

import { useCallback, useEffect, useState } from "react";
import { buka, commands, type Pesan, type Sesi, type Workspace } from "../tauri";

export type Keadaan = {
  workspace: Workspace[];
  workspaceTerpilih: Workspace | null;
  sesi: Sesi[];
  sesiTerpilih: Sesi | null;
  pesan: Pesan[];
  galat: string | null;
  sibuk: boolean;
  pilihWorkspace: (ws: Workspace | null) => void;
  pilihSesi: (s: Sesi | null) => void;
  buatWorkspace: (nama: string, jalur: string) => Promise<void>;
  buatSesi: (judul: string) => Promise<void>;
  tambahPesan: (peran: "pengguna" | "asisten", isi: string) => Promise<void>;
  segarkanPesan: () => Promise<void>;
};

export function useKeadaan(): Keadaan {
  const [workspace, setWorkspace] = useState<Workspace[]>([]);
  const [workspaceTerpilih, setWorkspaceTerpilih] = useState<Workspace | null>(null);
  const [sesi, setSesi] = useState<Sesi[]>([]);
  const [sesiTerpilih, setSesiTerpilih] = useState<Sesi | null>(null);
  const [pesan, setPesan] = useState<Pesan[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [sibuk, setSibuk] = useState(false);

  const jalankan = useCallback(async <T,>(kerja: () => Promise<T>): Promise<T | null> => {
    setSibuk(true);
    setGalat(null);
    try {
      return await kerja();
    } catch (e) {
      setGalat(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setSibuk(false);
    }
  }, []);

  const muatWorkspace = useCallback(async () => {
    const daftar = await jalankan(() => buka(commands.daftarWorkspace()));
    if (daftar) setWorkspace(daftar);
  }, [jalankan]);

  useEffect(() => {
    void muatWorkspace();
  }, [muatWorkspace]);

  // Sesi mengikuti workspace yang dipilih. Sesi yang terbuka ikut ditutup —
  // menampilkan sesi milik workspace lain adalah kebohongan yang halus.
  useEffect(() => {
    if (!workspaceTerpilih) {
      setSesi([]);
      setSesiTerpilih(null);
      return;
    }
    let batal = false;
    void jalankan(() => buka(commands.daftarSesi(workspaceTerpilih.id))).then((daftar) => {
      if (batal || !daftar) return;
      setSesi(daftar);
      setSesiTerpilih((sekarang) =>
        sekarang && daftar.some((s) => s.id === sekarang.id) ? sekarang : null,
      );
    });
    return () => {
      batal = true;
    };
  }, [workspaceTerpilih, jalankan]);

  const segarkanPesan = useCallback(async () => {
    if (!sesiTerpilih) {
      setPesan([]);
      return;
    }
    const daftar = await jalankan(() => buka(commands.daftarPesan(sesiTerpilih.id)));
    if (daftar) setPesan(daftar);
  }, [sesiTerpilih, jalankan]);

  useEffect(() => {
    void segarkanPesan();
  }, [segarkanPesan]);

  return {
    workspace,
    workspaceTerpilih,
    sesi,
    sesiTerpilih,
    pesan,
    galat,
    sibuk,
    pilihWorkspace: setWorkspaceTerpilih,
    pilihSesi: setSesiTerpilih,

    async buatWorkspace(nama, jalur) {
      const baru = await jalankan(() => buka(commands.buatWorkspace(nama, jalur)));
      if (!baru) return;
      await muatWorkspace();
      setWorkspaceTerpilih(baru);
    },

    async buatSesi(judul) {
      if (!workspaceTerpilih) return;
      const baru = await jalankan(() =>
        buka(commands.buatSesi(workspaceTerpilih.id, judul)),
      );
      if (!baru) return;
      setSesi((sebelum) => [baru, ...sebelum]);
      setSesiTerpilih(baru);
    },

    async tambahPesan(peran, isi) {
      if (!sesiTerpilih) return;
      const baru = await jalankan(() =>
        buka(commands.tambahPesan(sesiTerpilih.id, peran, isi)),
      );
      if (!baru) return;
      setPesan((sebelum) => [...sebelum, baru]);
      // Sesi yang baru dipakai naik ke atas daftar — Rust sudah memperbarui
      // `diperbaruiPada`, jadi daftarnya harus ikut mencerminkannya.
      setSesi((sebelum) =>
        [...sebelum]
          .map((s) =>
            s.id === sesiTerpilih.id ? { ...s, diperbaruiPada: baru.dibuatPada } : s,
          )
          .sort((a, b) => b.diperbaruiPada - a.diperbaruiPada),
      );
    },

    segarkanPesan,
  };
}

export function waktuSingkat(milidetik: number): string {
  return new Date(milidetik).toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
