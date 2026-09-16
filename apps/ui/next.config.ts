import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Di dalam Tauri tidak ada server Node: halaman dilayani sebagai berkas dari
  // bundel aplikasi. SSR, API routes, server actions, dan middleware karena itu
  // tidak pernah menyala — yang tersisa adalah React SPA dengan App Router.
  // Ini keputusan yang sudah diambil, bukan kekurangan yang perlu diperbaiki.
  output: "export",

  // Pengoptimal gambar Next menuntut server. Tanpa baris ini `next build` gagal
  // begitu ada satu <Image> di pohon komponen.
  images: { unoptimized: true },

  // Menghasilkan `out/rute/index.html`, bukan `out/rute.html`. Protokol aset
  // Tauri melayani berkas apa adanya dan tidak punya rewrite, jadi bentuk
  // direktori inilah yang membuat tautan ke /rute bisa dibuka.
  trailingSlash: true,
};

export default nextConfig;
