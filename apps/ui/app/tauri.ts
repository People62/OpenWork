// Satu-satunya tempat yang tahu bahwa kita sedang di dalam Tauri.
//
// Di OpenWork peran ini dipegang `window.__OPENWORK_ELECTRON__`, yang tersebar
// di 22 berkas. Di sini ia dikurung sejak awal supaya tidak pernah tersebar
// lagi — dan supaya `next dev` di tab browser biasa tetap bisa dibuka.

import { invoke as invokeTauri } from "@tauri-apps/api/core";

export function diDalamTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type Sapaan = {
  pesan: string;
  platform: string;
  arsitektur: string;
  versiTauri: string;
  versiAplikasi: string;
};

export function halo(nama: string): Promise<Sapaan> {
  return invokeTauri<Sapaan>("halo", { nama });
}

export function laporSinyal(nama: string): Promise<void> {
  return invokeTauri<void>("lapor_sinyal", { nama });
}
