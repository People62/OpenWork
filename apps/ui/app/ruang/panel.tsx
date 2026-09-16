"use client";

import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useKeadaan, waktuSingkat } from "./keadaan";

/// Tulang punggung Rilis 1 di layar: membuka workspace, membuat sesi di
/// dalamnya, dan membuka kembali percakapan yang tersimpan.
///
/// Belum tersambung ke mesin — pesan di sini ditulis tangan, dan itu disengaja.
/// Yang dibuktikan layar ini adalah bahwa data yang tersimpan di SQLite
/// benar-benar bisa dibuka kembali sesudah aplikasi ditutup. Menyambungkannya
/// ke OpenCode adalah langkah berikutnya, bukan langkah ini.
export function PanelRuang() {
  const k = useKeadaan();
  const [teks, setTeks] = useState("");

  async function bukaFolder() {
    const jalur = await open({ directory: true, multiple: false });
    if (typeof jalur !== "string") return;
    // Nama bawaan dari segmen terakhir jalur — hampir selalu yang diinginkan,
    // dan bisa diubah belakangan.
    const nama = jalur.split(/[/\\]/).filter(Boolean).pop() ?? jalur;
    await k.buatWorkspace(nama, jalur);
  }

  async function kirim() {
    const isi = teks.trim();
    if (!isi) return;
    setTeks("");
    await k.tambahPesan("pengguna", isi);
  }

  return (
    <div className="ruang">
      <aside className="ruang-sisi">
        <div className="ruang-bagian">
          <div className="ruang-kepala">
            <p className="label">Workspace</p>
            <button onClick={bukaFolder} disabled={k.sibuk}>
              Buka folder
            </button>
          </div>

          {k.workspace.length === 0 ? (
            <p className="ruang-kosong">
              Belum ada. Buka sebuah folder untuk memulai.
            </p>
          ) : (
            <ul className="ruang-daftar">
              {k.workspace.map((w) => (
                <li key={w.id}>
                  <button
                    className={
                      w.id === k.workspaceTerpilih?.id ? "baris terpilih" : "baris"
                    }
                    onClick={() => k.pilihWorkspace(w)}
                  >
                    <span className="baris-judul">{w.nama}</span>
                    <span className="baris-sub">{w.jalur}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {k.workspaceTerpilih && (
          <div className="ruang-bagian">
            <div className="ruang-kepala">
              <p className="label">Sesi</p>
              <button
                onClick={() =>
                  k.buatSesi(`Sesi ${waktuSingkat(Date.now())}`)
                }
                disabled={k.sibuk}
              >
                Sesi baru
              </button>
            </div>

            {k.sesi.length === 0 ? (
              <p className="ruang-kosong">Belum ada sesi di workspace ini.</p>
            ) : (
              <ul className="ruang-daftar">
                {k.sesi.map((s) => (
                  <li key={s.id}>
                    <button
                      className={
                        s.id === k.sesiTerpilih?.id ? "baris terpilih" : "baris"
                      }
                      onClick={() => k.pilihSesi(s)}
                    >
                      <span className="baris-judul">{s.judul}</span>
                      <span className="baris-sub">
                        {waktuSingkat(s.diperbaruiPada)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </aside>

      <section className="ruang-utama">
        {k.galat && <pre className="galat">{k.galat}</pre>}

        {!k.sesiTerpilih ? (
          <p className="ruang-kosong">
            {k.workspaceTerpilih
              ? "Pilih sesi, atau buat yang baru."
              : "Pilih workspace untuk mulai."}
          </p>
        ) : (
          <>
            <div className="percakapan">
              {k.pesan.length === 0 ? (
                <p className="ruang-kosong">
                  Sesi ini masih kosong. Apa pun yang ditulis di sini tersimpan
                  dan bisa dibuka kembali setelah aplikasi ditutup.
                </p>
              ) : (
                k.pesan.map((p) => (
                  <div key={p.id} className={`pesan pesan-${p.peran}`}>
                    <span className="label">{p.peran}</span>
                    <p>{p.isi}</p>
                    <span className="baris-sub">{waktuSingkat(p.dibuatPada)}</span>
                  </div>
                ))
              )}
            </div>

            <div className="ruang-kirim">
              <textarea
                value={teks}
                onChange={(e) => setTeks(e.target.value)}
                onKeyDown={(e) => {
                  // Enter mengirim, Shift+Enter baris baru — kebiasaan yang
                  // sudah dipegang setiap orang yang akan memakai ini.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void kirim();
                  }
                }}
                placeholder="Tulis pesan… (Enter mengirim, Shift+Enter baris baru)"
                rows={3}
              />
              <button onClick={kirim} disabled={k.sibuk || !teks.trim()}>
                Kirim
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
