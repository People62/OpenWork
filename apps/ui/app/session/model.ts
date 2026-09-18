// Which model a conversation runs on, and which one the next will.
//
// The choice lives here, in the browser, not in Rust and not in a config file.
// That follows the reference, and the reason is the engine: a session's model is
// fixed when the session is created and cannot be changed afterwards. Measured
// against OpenCode v1.18.18, on a session deliberately created with no model at
// all:
//
//   POST /session/{id}/prompt  {prompt, model}  -> 200, and the model ignored;
//                                                  the turn ran on the engine's
//                                                  free-tier default and failed
//   POST /session/{id}/prompt  {parts, model}   -> 400, "Missing key at [prompt]"
//   POST /session/{id}/prompt_async             -> no such route
//   PATCH/PUT/POST /session/{id}                -> no such route
//
// So there is nothing for a backend to store. What an open conversation runs on
// is a fact the engine already reports; what a *new* one will run on is a
// preference, and a preference belongs where the person expressing it is.
//
// Two levels, both remembered: a global default, and a per-session note of what
// each conversation was started with. The per-session note is what makes
// reopening a conversation show its own model rather than whatever was picked
// last.
//
// Deliberately not a subscribable store. One place reads it — the state hook,
// which already holds the choice in React state and re-renders on its own — and
// a `useSyncExternalStore` nobody subscribes to is machinery standing in for a
// need that does not exist.

"use client";

import type { Model } from "../tauri";

const STORAGE_KEY = "rantai.models.v1";

/// Old sessions are forgotten rather than kept forever. Someone who has held a
/// thousand conversations does not need the model of the first one, and
/// localStorage is a small, shared budget.
const REMEMBER_AT_MOST = 200;

type Remembered = {
  /// What a new session is created with.
  preferred: Model | null;
  /// What each session was created with, by engine session id.
  bySession: Record<string, Model>;
};

const EMPTY: Remembered = { preferred: null, bySession: {} };

let current: Remembered = EMPTY;
let hydrated = false;

export function sameModel(a: Model | null, b: Model | null): boolean {
  if (!a || !b) return a === b;
  return a.providerID === b.providerID && a.id === b.id;
}

function isModel(value: unknown): value is Model {
  if (!value || typeof value !== "object") return false;
  const { providerID, id } = value as Record<string, unknown>;
  return typeof providerID === "string" && typeof id === "string" && !!providerID && !!id;
}

/// Reads what was saved last time. Called once, on the first read of any kind —
/// not only from `subscribe`.
///
/// Tying it to `subscribe` alone was a real bug: the state hook reads
/// `preferred()` directly and nothing rendered `useRememberedModels`, so
/// hydration never ran and a saved choice was silently forgotten on every
/// reload. It stays out of render either way, so the server snapshot is still
/// stable.
function hydrate() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Remembered>;
    const bySession: Record<string, Model> = {};
    for (const [id, model] of Object.entries(saved.bySession ?? {})) {
      if (isModel(model)) bySession[id] = model;
    }
    current = {
      preferred: isModel(saved.preferred) ? saved.preferred : null,
      bySession,
    };
  } catch {
    // A corrupt entry is not worth a broken window.
  }
}

function ensureHydrated() {
  if (hydrated) return;
  hydrated = true;
  hydrate();
}

function save() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Private browsing, a full quota — neither is a reason to stop working.
  }
}

function set(next: Remembered) {
  current = next;
  save();
}

export const models = {
  /// The model a new session should be created with.
  preferred: () => {
    ensureHydrated();
    return current.preferred;
  },

  prefer(model: Model) {
    ensureHydrated();
    set({ ...current, preferred: model });
  },

  /// Notes what a session was actually created with, so reopening it shows its
  /// own model rather than whatever was chosen since.
  remember(sessionId: string, model: Model) {
    ensureHydrated();
    const bySession = { ...current.bySession, [sessionId]: model };
    const ids = Object.keys(bySession);
    if (ids.length > REMEMBER_AT_MOST) {
      // Oldest entries first: insertion order is the order they were started in.
      for (const id of ids.slice(0, ids.length - REMEMBER_AT_MOST)) {
        delete bySession[id];
      }
    }
    set({ ...current, bySession });
  },

  forSession: (sessionId: string): Model | null => {
    ensureHydrated();
    return current.bySession[sessionId] ?? null;
  },
};

/// What to show on the composer's picker.
///
/// The engine's own record wins when there is one: it is what the conversation
/// actually ran on, and our note is only a note. `providerID/id` reads oddly at
/// first but it is what OpenCode calls a model everywhere, including in its
/// errors — inventing prettier names here would make a failure harder to match
/// up with the log that reports it.
export function modelLabel(model: Model | null): string {
  return model ? model.id : "No model";
}
