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
      if (!selectedWorkspace) return;
      const created = await run(() =>
        unwrap(commands.createSession(selectedWorkspace.id, title)),
      );
      if (!created) return;
      setSessions((before) => [created, ...before]);
      setSelectedSession(created);
    },

    async addMessage(role, content) {
      if (!selectedSession) return;
      const created = await run(() =>
        unwrap(commands.addMessage(selectedSession.id, role, content)),
      );
      if (!created) return;
      setMessages((before) => [...before, created]);
      // A session that was just used rises to the top — Rust has already updated
      // `updatedAt`, so the list has to reflect it.
      setSessions((before) =>
        [...before]
          .map((s) =>
            s.id === selectedSession.id ? { ...s, updatedAt: created.createdAt } : s,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt),
      );
    },

    refreshMessages,
  };
}

export function shortTime(millis: number): string {
  return new Date(millis).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
