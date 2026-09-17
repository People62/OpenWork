// A stand-in for Tauri, so the interface can be worked on in a browser.
//
// Development happens on a headless VM reached over VS Code Remote, which means
// the Tauri window cannot be seen from there at all. Running only `next dev` and
// opening it in a browser on the other machine gives instant feedback — but
// without this, every screen falls back to "This page is open in an ordinary
// browser" and there is nothing to look at.
//
// It installs itself on import, and only when all three of these hold:
//
//   - the code is running in a browser
//   - there is no real Tauri (never shadow the genuine article)
//   - NEXT_PUBLIC_RANTAI_MOCK is "1"
//
// The flag is required rather than inferred from NODE_ENV. A mock that decides
// for itself when to switch on is a mock that will one day switch on in
// somebody's installed application.
//
// The same fixtures feed the contrast audit, from the same file — two sets of
// pretend data drift apart, and then the thing being audited is not the thing
// being looked at.

import fixtures from "./dev-fixtures.json";

type Answers = Record<string, unknown>;

/// Timestamps in the fixtures are offsets from now, in milliseconds, so the
/// screens always show plausible recent times rather than a frozen date.
function withTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withTimes);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        typeof inner === "number" && /At$/.test(key) ? Date.now() + inner : withTimes(inner);
    }
    return out;
  }
  return value;
}

export function installDevMock(): void {
  if (typeof window === "undefined") return;
  if ("__TAURI_INTERNALS__" in window) return;
  if (process.env.NEXT_PUBLIC_RANTAI_MOCK !== "1") return;

  const answers = withTimes(fixtures) as Answers;

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {
      transformCallback: (callback: unknown) => callback,
      invoke: (command: string) =>
        Promise.resolve(
          Object.prototype.hasOwnProperty.call(answers, command) ? answers[command] : null,
        ),
    },
    configurable: true,
  });

  // Said out loud, every time. A mock that runs quietly is a mock that gets
  // mistaken for the real application.
  console.info(
    "%cRantai: mock mode — no Rust behind this. Data on screen is invented.",
    "color:#d97706;font-weight:600",
  );
}
