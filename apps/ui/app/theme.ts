export type ThemeMode = "light" | "dark" | "system";
export type ResolvedThemeMode = "light" | "dark";

const THEME_PREF_KEY = "openwork.react.settings.theme-mode";
const LEGACY_THEME_PREF_KEYS = ["openwork.themePref"];

const mediaQuery = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();
let currentMode: ThemeMode | null = null;
let systemThemeCleanup: (() => void) | null = null;

const getMediaQueryList = () =>
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia(mediaQuery);

const isThemeMode = (value: string | null): value is ThemeMode =>
  value === "light" || value === "dark" || value === "system";

const readStoredMode = (): ThemeMode => {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_PREF_KEY);
    if (isThemeMode(stored)) {
      return stored;
    }

    for (const key of LEGACY_THEME_PREF_KEYS) {
      const legacyStored = window.localStorage.getItem(key);
      if (isThemeMode(legacyStored)) {
        window.localStorage.setItem(THEME_PREF_KEY, legacyStored);
        return legacyStored;
      }
    }
  } catch {
    // ignore
  }
  return "system";
};

const resolveMode = (mode: ThemeMode): ResolvedThemeMode => {
  if (mode !== "system") return mode;
  return getMediaQueryList()?.matches ? "dark" : "light";
};

const applyTheme = (mode: ThemeMode) => {
  if (typeof document === "undefined") return;
  const resolved = resolveMode(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
};

const emitThemeChange = () => {
  for (const listener of listeners) {
    listener();
  }
};

/// One of the 22 files bound to `window.__OPENWORK_ELECTRON__` in OpenWork.
///
/// It told Electron which native theme to paint the window chrome with. Tauri
/// has the same idea under a different name, and it is reached through the
/// window API rather than a bridge of our own.
///
/// Imported lazily so this module still loads in an ordinary browser tab, where
/// `next dev` runs and no Tauri exists.
const syncNativeTheme = (mode: ThemeMode) => {
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;

  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) =>
      getCurrentWindow().setTheme(mode === "system" ? null : mode),
    )
    .catch((error) => {
      // Not worth interrupting anything over: the interface is already themed,
      // and only the native chrome would lag behind.
      console.warn("could not set the native theme:", error);
    });
};

const getCurrentMode = () => {
  if (currentMode === null) {
    currentMode = readStoredMode();
  }
  return currentMode;
};

const handleSystemThemeChange = () => {
  if (getCurrentMode() !== "system") return;
  applyTheme("system");
  syncNativeTheme("system");
  emitThemeChange();
};

const ensureSystemThemeSubscription = () => {
  if (systemThemeCleanup || typeof window === "undefined") return;

  const list = getMediaQueryList();
  if (!list) return;

  list.addEventListener("change", handleSystemThemeChange);
  systemThemeCleanup = () => list.removeEventListener("change", handleSystemThemeChange);
};

export const bootstrapTheme = () => {
  const mode = getCurrentMode();
  applyTheme(mode);
  syncNativeTheme(mode);
  ensureSystemThemeSubscription();
};

export const getInitialThemeMode = () => getCurrentMode();

export const getResolvedThemeMode = () => resolveMode(getCurrentMode());

const persistThemeMode = (mode: ThemeMode) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_PREF_KEY, mode);
  } catch {
    // ignore
  }
};

export const subscribeToTheme = (onChange: () => void) => {
  ensureSystemThemeSubscription();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
};

export const setThemeMode = (mode: ThemeMode) => {
  currentMode = mode;
  persistThemeMode(mode);
  applyTheme(mode);
  syncNativeTheme(mode);
  ensureSystemThemeSubscription();
  emitThemeChange();
};
