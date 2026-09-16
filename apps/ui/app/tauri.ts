// Satu-satunya tempat yang tahu bahwa kita sedang di dalam Tauri.
//
// Di OpenWork peran ini dipegang `window.__OPENWORK_ELECTRON__`, yang tersebar
// di 22 berkas. Di sini ia dikurung sejak awal supaya tidak pernah tersebar
// lagi — dan supaya `next dev` di tab browser biasa tetap bisa dibuka.
//
// Perintah dan tipenya sendiri tidak ditulis di sini: semuanya datang dari
// `bindings.ts`, yang dihasilkan dari Rust dan tidak boleh disunting tangan.

export { commands, events } from "./bindings";
export type {
  Galat,
  GalatMesin,
  Kepingan,
  Peran,
  PeriksaDb,
  Pesan,
  Sapaan,
  Selesai,
  Sesi,
  StatusMesin,
  StatusTautan,
  TautanDalam,
  Workspace,
} from "./bindings";

export function diDalamTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/// Bentuk yang dikembalikan tauri-specta untuk tiap perintah yang mengembalikan
/// `Result` di Rust. Ia tidak melempar — cabang galatnya dikembalikan sebagai
/// data, dan TypeScript menolak kode yang tidak menanganinya. Itu perilaku yang
/// benar, tapi di pemanggil biasa `try/catch` lebih enak dibaca.
type HasilPerintah<T, E> =
  | { status: "ok"; data: T }
  | { status: "error"; error: E };

/// Galat dari Rust yang sudah berbentuk `Error` JavaScript, tapi tetap membawa
/// nilai aslinya yang bertipe di `.galat` — jadi pemanggil yang perlu
/// membedakan `tidakDitemukan` dari `basisData` masih bisa.
export class GalatPerintah<E> extends Error {
  readonly galat: E;

  constructor(galat: E) {
    super(jelaskan(galat));
    this.name = "GalatPerintah";
    this.galat = galat;
  }
}

function jelaskan(galat: unknown): string {
  if (typeof galat === "string") return galat;
  if (
    typeof galat === "object" &&
    galat !== null &&
    "jenis" in galat &&
    "pesan" in galat
  ) {
    return `${String(galat.jenis)}: ${String(galat.pesan)}`;
  }
  return JSON.stringify(galat);
}

/// Membuka hasil perintah, atau melempar galat yang tetap bertipe.
export async function buka<T, E>(
  janji: Promise<HasilPerintah<T, E>>,
): Promise<T> {
  const hasil = await janji;
  if (hasil.status === "error") throw new GalatPerintah(hasil.error);
  return hasil.data;
}
