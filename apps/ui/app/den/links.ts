// Parsers for Den sign-in links — carried over from OpenWork as they were.
//
// This is the part of the Den sign-in that is pure TypeScript and touches
// nothing Vite- or Electron-specific, so it really does move across with no
// change beyond style. In the reference it is split across `openwork-links.ts`
// and `manual-auth-input.ts`; here the two are joined, because they answer the
// same question — "what is in this link?" — and one screen uses both.
//
// Both are deliberately free of side effects and testable without a window,
// without Tauri, and without Den. That matters: the part of the sign-in that
// *cannot* be tested that way is its native half, and shrinking the untestable
// part as far as it will go is the whole strategy of this phase.

/// The default Den. In OpenWork this is injected at build time; here it is a
/// `NEXT_PUBLIC_*`, because `import.meta.env` is Vite's and does not exist in
/// Next.
export const DEFAULT_DEN =
  process.env.NEXT_PUBLIC_DEN_BASE_URL ?? "https://app.openworklabs.com";

export type DenAuthLink = {
  grant: string;
  denBaseUrl: string;
};

/// The schemes we accept. `openwork-dev:` is here so a development build does
/// not fight an installed application over the scheme registration; http and
/// https are here because Den can send an ordinary link.
const ACCEPTED_SCHEMES = new Set([
  "openwork:",
  "openwork-dev:",
  "https:",
  "http:",
]);

export function normalizeDenBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // No trailing slash, so joining paths does not produce a double slash.
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/// Does this link point at `den-auth`? Matched loosely — host, path, or last
/// segment — because the shape differs by scheme: on `openwork://den-auth` it is
/// the host, on `https://…/den-auth` it is the path.
function pointsAtDenAuth(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/^\/+/, "").toLowerCase();
  const segments = path.split("/").filter(Boolean);
  const tail = segments[segments.length - 1] ?? "";
  return host === "den-auth" || path === "den-auth" || tail === "den-auth";
}

/// Parses `openwork://den-auth?grant=…&denBaseUrl=…`.
export function parseAuthLink(raw: string): DenAuthLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (!ACCEPTED_SCHEMES.has(url.protocol.toLowerCase())) return null;
  if (!pointsAtDenAuth(url)) return null;

  const grant = url.searchParams.get("grant")?.trim() ?? "";
  if (!grant) return null;

  return {
    grant,
    denBaseUrl:
      normalizeDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ??
      DEFAULT_DEN,
  };
}

/// The fallback path: the user pastes it themselves, either the whole link or
/// just the code.
///
/// This is not a luxury. URL scheme registration behaves differently on every
/// operating system, is at its most fragile in development mode, and in Rantai
/// was never covered by CI at all. This path is pure TypeScript, zero native,
/// and therefore the only part of the sign-in guaranteed to work anywhere.
export function parseManualPaste(value: string): DenAuthLink | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const fromLink = parseAuthLink(trimmed);
  if (fromLink) return fromLink;

  // Not a link we recognise. If it is itself a URL, do not treat it as a code —
  // the user has almost certainly pasted the wrong thing.
  try {
    new URL(trimmed);
    return null;
  } catch {
    // Not a URL, so it is a raw code.
  }

  // The 12-character floor follows OpenWork: enough to reject an accidental
  // keystroke, loose enough not to reject a valid code.
  return trimmed.length >= 12 ? { grant: trimmed, denBaseUrl: DEFAULT_DEN } : null;
}
