// Where the shell's panes are, and how wide.
//
// A module-level store rather than a context: the header toggles the right pane,
// the rail toggles it too, and the drag handle writes the width — three writers
// far apart in the tree. `useSyncExternalStore` keeps them agreeing and gives
// the static export a server snapshot to prerender against.
//
// Widths come from the reference, which arrived at them by use.

"use client";

import { useSyncExternalStore } from "react";

export const LEFT_DEFAULT = 260;
export const LEFT_MIN = 220;
export const LEFT_MAX = 420;

export const RIGHT_DEFAULT = 520;
export const RIGHT_MIN = 320;
export const RIGHT_MAX = 960;

/** The icon rail on the far right edge, always visible on wide screens. */
export const RAIL_WIDTH = 36;

export type PanelTab = "library" | "notifications" | "session";

export type Layout = {
  leftWidth: number;
  leftCollapsed: boolean;
  rightWidth: number;
  /** `null` means the right pane is closed. */
  rightTab: PanelTab | null;
};

const STORAGE_KEY = "rantai.layout";

const INITIAL: Layout = {
  leftWidth: LEFT_DEFAULT,
  leftCollapsed: false,
  rightWidth: RIGHT_DEFAULT,
  rightTab: null,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

let current: Layout = INITIAL;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Reads what was saved last time. Called once, lazily, from the first
 * subscriber — never during render, because the server snapshot has to stay
 * stable or React will loop.
 */
function hydrate() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Layout>;
    current = {
      leftWidth: clamp(saved.leftWidth ?? LEFT_DEFAULT, LEFT_MIN, LEFT_MAX),
      leftCollapsed: saved.leftCollapsed === true,
      rightWidth: clamp(saved.rightWidth ?? RIGHT_DEFAULT, RIGHT_MIN, RIGHT_MAX),
      // The pane is deliberately not restored open. Reopening into a panel
      // nobody asked for costs half the window on every launch.
      rightTab: null,
    };
  } catch {
    // A corrupt entry is not worth a broken window.
  }
}

let hydrated = false;

function subscribe(listener: () => void) {
  if (!hydrated) {
    hydrated = true;
    hydrate();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function save() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Private browsing, a full quota — neither is a reason to stop working.
  }
}

function set(patch: Partial<Layout>) {
  const next = { ...current, ...patch };
  if (
    next.leftWidth === current.leftWidth &&
    next.leftCollapsed === current.leftCollapsed &&
    next.rightWidth === current.rightWidth &&
    next.rightTab === current.rightTab
  ) {
    return;
  }
  current = next;
  save();
  emit();
}

export const layout = {
  get: () => current,
  setLeftWidth: (width: number) => set({ leftWidth: clamp(width, LEFT_MIN, LEFT_MAX) }),
  setRightWidth: (width: number) => set({ rightWidth: clamp(width, RIGHT_MIN, RIGHT_MAX) }),
  toggleLeft: () => set({ leftCollapsed: !current.leftCollapsed }),
  openRight: (tab: PanelTab) => set({ rightTab: tab }),
  closeRight: () => set({ rightTab: null }),
  toggleRight: (tab: PanelTab) =>
    set({ rightTab: current.rightTab === tab ? null : tab }),
};

export function useLayout(): Layout {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => INITIAL,
  );
}
