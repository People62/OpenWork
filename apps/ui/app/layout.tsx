import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rantai",
  description: "A desktop application with a Rust local backend inside Tauri.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
