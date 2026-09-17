// The state of the Release 1 backbone: the selected workspace, the open session,
// and the messages inside it.
//
// All the truth lives in SQLite behind Rust commands; this hook is only a mirror
// that refreshes itself. No copy outlives what the screen needs — two sources of
// truth for the same thing always end up disagreeing, and avoiding that is the
// whole point of the Phase 1 gate.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  commands,
  unwrap,
  type Message,
  type Session,
  type Workspace,
} from "../tauri";

export type AppState = {
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  sessions: Session[];
  selectedSession: Session | null;
  messages: Message[];
  error: string | null;
  busy: boolean;
  selectWorkspace: (workspace: Workspace | null) => void;
  selectSession: (session: Session | null) => void;
  createWorkspace: (name: string, path: string) => Promise<void>;
  createSession: (title: string) => Promise<void>;
  addMessage: (role: "user" | "assistant", content: string) => Promise<void>;
  /** Creates a session and writes the first message into it, in that order. */
  startTask: (prompt: string) => Promise<void>;
  refreshMessages: () => Promise<void>;
};

export function useAppState(): AppState {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const list = await run(() => unwrap(commands.listWorkspaces()));
    if (list) setWorkspaces(list);
  }, [run]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  // Sessions follow the selected workspace. An open session closes with it —
  // showing a session that belongs to another workspace is a quiet lie.
  useEffect(() => {
    if (!selectedWorkspace) {
      setSessions([]);
      setSelectedSession(null);
      return;
    }
    let cancelled = false;
    void run(() => unwrap(commands.listSessions(selectedWorkspace.id))).then((list) => {
      if (cancelled || !list) return;
      setSessions(list);
      setSelectedSession((current) =>
        current && list.some((s) => s.id === current.id) ? current : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace, run]);

  const refreshMessages = useCallback(async () => {
    if (!selectedSession) {
      setMessages([]);
      return;
    }
    const list = await run(() => unwrap(commands.listMessages(selectedSession.id)));
    if (list) setMessages(list);
  }, [selectedSession, run]);

  useEffect(() => {
    void refreshMessages();
  }, [refreshMessages]);

  /// Creates a session in the selected workspace and opens it. Returns the row
  /// so a caller that needs the new id does not have to wait for a render.
  const openSession = useCallback(
    async (title: string): Promise<Session | null> => {
      if (!selectedWorkspace) return null;
      const created = await run(() =>
        unwrap(commands.createSession(selectedWorkspace.id, title)),
      );
      if (!created) return null;
      setSessions((before) => [created, ...before]);
      setSelectedSession(created);
      return created;
    },
    [selectedWorkspace, run],
  );

  const writeMessage = useCallback(
    async (sessionId: string, role: "user" | "assistant", content: string) => {
      const created = await run(() =>
        unwrap(commands.addMessage(sessionId, role, content)),
      );
      if (!created) return;
      setMessages((before) => [...before, created]);
      // A session that was just used rises to the top — Rust has already updated
      // `updatedAt`, so the list has to reflect it.
      setSessions((before) =>
        [...before]
          .map((s) => (s.id === sessionId ? { ...s, updatedAt: created.createdAt } : s))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      );
    },
    [run],
  );

  return {
    workspaces,
    selectedWorkspace,
    sessions,
    selectedSession,
    messages,
    error,
    busy,
    selectWorkspace: setSelectedWorkspace,
    selectSession: setSelectedSession,

    async createWorkspace(name, path) {
      const created = await run(() => unwrap(commands.createWorkspace(name, path)));
      if (!created) return;
      await loadWorkspaces();
      setSelectedWorkspace(created);
    },

    async createSession(title) {
      await openSession(title);
    },

    async addMessage(role, content) {
      if (!selectedSession) return;
      await writeMessage(selectedSession.id, role, content);
    },

    // Two writes that have to happen in order, so they live here rather than at
    // the call site. A screen that did `await createSession(...)` and then
    // `addMessage(...)` would lose the message every time: the second call reads
    // the selected session out of a closure that React has not re-rendered yet,
    // so it still sees the session from before — or none at all.
    async startTask(prompt) {
      const created = await openSession(firstLine(prompt));
      if (!created) return;
      await writeMessage(created.id, "user", prompt);
    },

    refreshMessages,
  };
}

/// How long ago, in the shortest form that still says it: `now`, `4m`, `3h`,
/// `13d`, then a date. Sidebar rows have room for two characters at the end of a
/// title, and a full timestamp there would push the title out instead.
export function relativeAge(millis: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - millis) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(millis).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

/// A session title taken from the task that started it. The first line is what
/// the sidebar shows, and a whole paragraph there is unreadable.
function firstLine(prompt: string): string {
  const line = prompt.split("\n", 1)[0]?.trim() ?? prompt;
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
