// Tes ditulis bersama fiturnya, bukan sesudahnya.
//
// Pengurai ini adalah bagian alur masuk Den yang bisa diuji tanpa jendela,
// tanpa Tauri, dan tanpa Den. Menyempitkan yang *tidak* terujikan sekecil
// mungkin adalah seluruh strategi fase ini — sisanya hanya dua sentuhan native.

import { describe, expect, test } from "bun:test";
import {
  DEN_BAWAAN,
  rapikanDenBaseUrl,
  uraiTautanMasuk,
  uraiTempelanManual,
} from "./tautan";

describe("uraiTautanMasuk", () => {
  test("mengurai deep link openwork://den-auth", () => {
    const hasil = uraiTautanMasuk(
      "openwork://den-auth?grant=abc123def456&denBaseUrl=https://den.contoh.id",
    );
    expect(hasil).toEqual({
      grant: "abc123def456",
      denBaseUrl: "https://den.contoh.id",
    });
  });

  test("skema pengembangan diterima, supaya build dev tidak berebut pendaftaran", () => {
    expect(uraiTautanMasuk("openwork-dev://den-auth?grant=abc123def456")).toEqual({
      grant: "abc123def456",
      denBaseUrl: DEN_BAWAAN,
    });
  });

  test("den-auth sebagai jalur, bukan host, juga dikenali", () => {
    // Bentuknya berbeda antar-skema: pada openwork:// ia host, pada https:// ia jalur.
    expect(uraiTautanMasuk("https://app.contoh.id/den-auth?grant=abc123def456")).toEqual({
      grant: "abc123def456",
      denBaseUrl: DEN_BAWAAN,
    });
  });

  test("tanpa grant, tautannya tidak berguna", () => {
    expect(uraiTautanMasuk("openwork://den-auth")).toBeNull();
    expect(uraiTautanMasuk("openwork://den-auth?grant=")).toBeNull();
  });

  test("rute lain diabaikan", () => {
    expect(uraiTautanMasuk("openwork://connect-remote?grant=abc123def456")).toBeNull();
  });

  test("skema asing ditolak", () => {
    expect(uraiTautanMasuk("javascript://den-auth?grant=abc123def456")).toBeNull();
    expect(uraiTautanMasuk("file://den-auth?grant=abc123def456")).toBeNull();
  });

  test("masukan yang bukan URL tidak melempar", () => {
    expect(uraiTautanMasuk("bukan url sama sekali")).toBeNull();
    expect(uraiTautanMasuk("")).toBeNull();
  });

  test("denBaseUrl yang tidak masuk akal jatuh ke bawaan, bukan diteruskan", () => {
    // Kalau ini diteruskan apa adanya, aplikasi akan mengirim grant ke tempat
    // yang ditentukan penyerang.
    expect(
      uraiTautanMasuk("openwork://den-auth?grant=abc123def456&denBaseUrl=javascript:alert(1)")
        ?.denBaseUrl,
    ).toBe(DEN_BAWAAN);
  });
});

describe("uraiTempelanManual", () => {
  test("menerima tautan utuh yang ditempel", () => {
    expect(uraiTempelanManual("  openwork://den-auth?grant=abc123def456  ")).toEqual({
      grant: "abc123def456",
      denBaseUrl: DEN_BAWAAN,
    });
  });

  test("menerima kode mentah", () => {
    expect(uraiTempelanManual("kode-yang-cukup-panjang")).toEqual({
      grant: "kode-yang-cukup-panjang",
      denBaseUrl: DEN_BAWAAN,
    });
  });

  test("menolak ketikan tak sengaja yang terlalu pendek", () => {
    expect(uraiTempelanManual("pendek")).toBeNull();
    expect(uraiTempelanManual("   ")).toBeNull();
  });

  test("URL yang tidak dikenali ditolak, bukan dianggap kode", () => {
    // Pengguna yang menempel URL salah sebaiknya diberi tahu, bukan dikirimi
    // grant palsu sepanjang URL itu.
    expect(uraiTempelanManual("https://contoh.id/halaman-yang-salah")).toBeNull();
  });
});

describe("rapikanDenBaseUrl", () => {
  test("membuang garis miring di ujung", () => {
    expect(rapikanDenBaseUrl("https://den.contoh.id/")).toBe("https://den.contoh.id");
    expect(rapikanDenBaseUrl("https://den.contoh.id/basis/")).toBe("https://den.contoh.id/basis");
  });

  test("menolak skema selain http dan https", () => {
    expect(rapikanDenBaseUrl("javascript:alert(1)")).toBeNull();
    expect(rapikanDenBaseUrl("file:///etc/passwd")).toBeNull();
  });

  test("menolak yang bukan URL", () => {
    expect(rapikanDenBaseUrl("bukan url")).toBeNull();
    expect(rapikanDenBaseUrl("")).toBeNull();
  });
});
