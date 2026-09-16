import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rantai",
  description: "Fase 0 — kerangka yang berjalan.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
