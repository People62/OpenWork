// Pengurai tautan masuk Den — dipindahkan dari OpenWork apa adanya.
//
// Ini bagian alur masuk Den yang murni TypeScript dan tidak menyentuh apa pun
// yang khas Vite maupun Electron, jadi ia benar-benar pindah tanpa perubahan
// selain gaya. Di rujukan ia tersebar di `openwork-links.ts` dan
// `manual-auth-input.ts`; di sini keduanya disatukan karena keduanya menjawab
// pertanyaan yang sama — "apa isi tautan ini?" — dan dipakai oleh satu layar.
//
// Keduanya sengaja bebas dari efek samping dan bisa diuji tanpa jendela,
// tanpa Tauri, dan tanpa Den. Itu penting: bagian alur masuk yang *tidak* bisa
// diuji begitu adalah bagian native-nya, dan menyempitkan yang tidak terujikan
// sekecil mungkin adalah seluruh strategi fase ini.

/// Den bawaan. Di OpenWork nilainya disuntikkan saat build; di sini ia
/// `NEXT_PUBLIC_*`, karena `import.meta.env` khas Vite dan tidak ada di Next.
export const DEN_BAWAAN =
  process.env.NEXT_PUBLIC_DEN_BASE_URL ?? "https://app.openworklabs.com";

export type TautanMasukDen = {
  grant: string;
  denBaseUrl: string;
};

/// Skema yang diterima. `openwork-dev:` ada supaya build pengembangan tidak
/// berebut pendaftaran skema dengan aplikasi yang terpasang; http/https ada
/// karena Den bisa mengirim tautan biasa.
const SKEMA_DITERIMA = new Set([
  "openwork:",
  "openwork-dev:",
  "https:",
  "http:",
]);

export function rapikanDenBaseUrl(nilai: string): string | null {
  const bersih = nilai.trim();
  if (!bersih) return null;
  try {
    const url = new URL(bersih);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Tanpa garis miring di ujung, supaya penggabungan jalur tidak menghasilkan
    // garis miring ganda.
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/// Apakah tautan ini mengarah ke `den-auth`? Dicocokkan longgar — host, jalur,
/// atau segmen terakhir — karena bentuknya berbeda antar-skema: pada
/// `openwork://den-auth` ia host, pada `https://…/den-auth` ia jalur.
function menujuDenAuth(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const jalur = url.pathname.replace(/^\/+/, "").toLowerCase();
  const segmen = jalur.split("/").filter(Boolean);
  const ekor = segmen[segmen.length - 1] ?? "";
  return host === "den-auth" || jalur === "den-auth" || ekor === "den-auth";
}

/// Mengurai `openwork://den-auth?grant=…&denBaseUrl=…`.
export function uraiTautanMasuk(mentah: string): TautanMasukDen | null {
  let url: URL;
  try {
    url = new URL(mentah.trim());
  } catch {
    return null;
  }

  if (!SKEMA_DITERIMA.has(url.protocol.toLowerCase())) return null;
  if (!menujuDenAuth(url)) return null;

  const grant = url.searchParams.get("grant")?.trim() ?? "";
  if (!grant) return null;

  return {
    grant,
    denBaseUrl:
      rapikanDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ??
      DEN_BAWAAN,
  };
}

/// Jalur cadangan: pengguna menempel sendiri, entah seluruh tautan atau hanya
/// kodenya.
///
/// Ini bukan kemewahan. Registrasi skema URL berperilaku berbeda di tiap sistem
/// operasi dan paling rapuh di mode pengembangan, dan di Rantai ia tidak pernah
/// tercakup uji CI sama sekali. Jalur ini murni TypeScript, nol native, dan
/// karena itu satu-satunya bagian alur masuk yang pasti bekerja di mana pun.
export function uraiTempelanManual(nilai: string): TautanMasukDen | null {
  const bersih = nilai.trim();
  if (!bersih) return null;

  const dariTautan = uraiTautanMasuk(bersih);
  if (dariTautan) return dariTautan;

  // Bukan tautan yang dikenali. Kalau ia sendiri berupa URL, jangan
  // diperlakukan sebagai kode — pengguna hampir pasti salah tempel.
  try {
    new URL(bersih);
    return null;
  } catch {
    // Bukan URL, jadi ia kode mentah.
  }

  // Ambang 12 karakter mengikuti OpenWork: cukup untuk menolak ketikan tak
  // sengaja, cukup longgar untuk tidak menolak kode yang sah.
  return bersih.length >= 12 ? { grant: bersih, denBaseUrl: DEN_BAWAAN } : null;
}
