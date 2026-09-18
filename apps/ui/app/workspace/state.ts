// What the screen knows, and where each part of it comes from.
//
// Two stores, and the split is deliberate:
//
//   SQLite (ours)   workspaces — a folder someone chose, under a name they chose
//   OpenCode        sessions, messages, models — everything about a conversation
//
// It was one store until we looked. OpenCode had been writing every session and
// message to its own SQLite all along, with the title, the model, the cost, the
// token counts, the reasoning and the tool calls — and that copy is the one the
// engine reads as context for the next turn. A second copy on our side would be
// the one on screen while the model answered from the other, and nothing would
// say which was right.
//
// Reading history works for any folder through `?directory=`. Creating a session
// and running a turn do not: they land in the engine's own working directory. So
// choosing a workspace restarts the engine there, and that is the one slow step
// in the whole flow.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  commands,
  events,
  unwrap,
  type EngineSession,
  type EngineStatus,
  type Message,
  type Model,
  type Workspace,
} from "../tauri";

/// The event carrying one piece of text as it is generated. Matched here rather
/// than in Rust because Rust passes every event through untranslated on purpose
/// — translating means guessing, and OpenCode's event names move between
/// versions.
const TEXT_DELTA = "session.next.text.delta";

export type AppState = {
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  engine: EngineStatus | null;
  sessions: EngineSession[];
  selectedSession: EngineSession | null;
  messages: Message[];
  /** Text arriving for a turn the engine has not finished writing down yet. */
  streaming: string | null;
  /** What you just sent, until the engine's own copy of it comes back. */
  pending: string | null;
  /** A turn is running and can be stopped. */
  running: boolean;
  error: string | null;
  busy: boolean;
  selectWorkspace: (workspace: Workspace | null) => void;
  selectSession: (session: EngineSession | null) => void;
  createWorkspace: (name: string, path: string) => Promise<void>;
  /** Opens a new session and sends the first prompt into it. */
  startTask: (prompt: string) => Promise<void>;
  /** Sends a prompt into the open session. */
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
};

export function useAppState(): AppState {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [sessions, setSessions] = useState<EngineSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<EngineSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Which session the listeners should accept events for. A ref, not state: the
  // listeners are installed once and would otherwise close over whichever
  // session happened to be open when they were.
  const listening = useRef<string | null>(null);
  // Asked of the engine once per working directory. Provider availability
  // depends on that directory — the same folder can offer dozens of models or
  // none, depending on whether OpenCode recognises it as a project.
  const model = useRef<Model | null>(null);

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

  const loadMessages = useCallback(
    async (engineSessionId: string) => {
      const list = await run(() =>
        unwrap(commands.listEngineMessages(engineSessionId)),
      );
      if (!list) return;
      // Only for the session still open. A slow read that lands after you have
      // moved on would otherwise paste one conversation under another's title.
      if (listening.current !== engineSessionId) return;
      setMessages(list);
      setPending(null);
    },
    [run],
  );

  // One set of listeners for the life of the hook. Re-subscribing on every
  // session change would drop whatever arrived in the gap between the two.
  useEffect(() => {
    const dropChunk = events.chunk.listen((e) => {
      const chunk = e.payload;
      if (chunk.engineSessionId !== listening.current) return;
      if (chunk.kind !== TEXT_DELTA) return;
      const text = (chunk.payload as { text?: unknown } | null)?.text;
      if (typeof text !== "string") return;
      setStreaming((before) => (before ?? "") + text);
    });

    const dropFinished = events.finished.listen((e) => {
      if (e.payload.engineSessionId !== listening.current) return;
      setRunning(false);
      setStreaming(null);
      if (e.payload.error) setError(e.payload.error);
      // The engine's copy replaces what was streamed. It is the richer one —
      // reasoning, tool calls and the turn's own error state are all in it, and
      // none of those arrive as text deltas.
      void loadMessages(e.payload.engineSessionId);
    });

    return () => {
      void dropChunk.then((drop) => drop());
      void dropFinished.then((drop) => drop());
    };
  }, [loadMessages]);

  // Choosing a workspace moves the engine into it. Sessions can only be read
  // once something is running, so the two happen in order rather than at once.
  useEffect(() => {
    if (!selectedWorkspace) {
      setEngine(null);
      setSessions([]);
      setSelectedSession(null);
      listening.current = null;
      return;
    }

    let cancelled = false;
    const path = selectedWorkspace.path;
    model.current = null;

    void run(async () => {
      const status = await unwrap(commands.startEngine(path));
      if (cancelled) return;
      setEngine(status);

      const list = await unwrap(commands.listEngineSessions(path));
      if (cancelled) return;
      setSessions(list);
      // An open session that does not belong to this workspace is closed.
      // Keeping one that does not is a quiet lie about where the work happens.
      setSelectedSession((current) =>
        current && list.some((s) => s.id === current.id) ? current : null,
      );
    });

    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace, run]);

  useEffect(() => {
    listening.current = selectedSession?.id ?? null;
    setStreaming(null);
    setPending(null);
    setRunning(false);
    if (!selectedSession) {
      setMessages([]);
      return;
    }
    void loadMessages(selectedSession.id);
  }, [selectedSession, loadMessages]);

  /// The model to fix on a new session.
  ///
  /// It must be set, not left out. The `/prompt` schema has no model field, so a
  /// session without one falls back to the engine's default — and when that
  /// default cannot be used, the failure never reaches the event stream at all.
  /// The screen would simply hang.
  const chooseModel = useCallback(async (): Promise<Model | null> => {
    if (model.current) return model.current;
    const list = await unwrap(commands.listModels());
    model.current = list[0] ?? null;
    return model.current;
  }, []);

  const refreshSessions = useCallback(async (path: string) => {
    const list = await unwrap(commands.listEngineSessions(path));
    setSessions(list);
    return list;
  }, []);

  return {
    workspaces,
    selectedWorkspace,
    engine,
    sessions,
    selectedSession,
    messages,
    streaming,
    pending,
    running,
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

    async startTask(prompt) {
      const workspace = selectedWorkspace;
      if (!workspace) return;

      await run(async () => {
        // Idempotent when the engine is already in this folder, and the one
        // thing that guarantees the session lands in the right workspace when
        // it is not.
        await unwrap(commands.startEngine(workspace.path));

        const id = await unwrap(commands.createEngineSession(await chooseModel()));
        listening.current = id;
        setMessages([]);
        setPending(prompt);
        setStreaming(null);
        setRunning(true);

        await unwrap(commands.sendPrompt(id, prompt));

        // Read back rather than invented: the engine names the session itself,
        // and a row made up here would show a title it is about to replace.
        const list = await refreshSessions(workspace.path);
        setSelectedSession(list.find((s) => s.id === id) ?? null);
      });
    },

    async send(text) {
      const session = selectedSession;
      if (!session) return;
      await run(async () => {
        setPending(text);
        setStreaming(null);
        setRunning(true);
        await unwrap(commands.sendPrompt(session.id, text));
      });
    },

    async stop() {
      const session = selectedSession;
      if (!session) return;
      await run(async () => {
        await unwrap(commands.stopConversation(session.id));
        setRunning(false);
      });
    },
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
