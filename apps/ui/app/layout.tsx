import type { Metadata } from "next";
import { SmokeRunner } from "./smoke-runner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rantai",
  description: "A desktop application with a Rust local backend inside Tauri.",
};

/// Applies the stored theme before the first paint.
///
/// A standalone snippet rather than a serialised `bootstrapTheme`: that function
/// calls helpers in its own module scope, which do not exist inside an inline
/// script. It would have thrown on every load.
///
/// OpenWork runs the same few lines from its index.html. Without them the class
/// arrives after hydration, and a dark window flashes white on every launch —
/// the first thing anyone sees.
const themeScript = `
try {
  var key = "openwork.react.settings.theme-mode";
  var mode = localStorage.getItem(key) || localStorage.getItem("openwork.themePref") || "system";
  var resolved = mode === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
} catch (e) {
  document.documentElement.dataset.theme = "light";
  document.documentElement.style.colorScheme = "light";
}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="bg-background text-foreground font-sans antialiased">
        {children}
        <SmokeRunner />
      </body>
    </html>
  );
}
