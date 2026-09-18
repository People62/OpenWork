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
import { models as remembered } from "../session/model";
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

/// The engine's events, matched here rather than in Rust because Rust passes
/// every event through untranslated on purpose — translating means guessing,
/// and OpenCode's event names move between versions.
///
/// A delta does not say what kind of part it belongs to. Its `field` is `"text"`
/// for reasoning as much as for the answer — the first delta of a real turn was
/// the model's reasoning, not its reply. So the kind of every part is learned
/// from `message.part.updated`, which the engine sends before a part's first
/// delta (measured: not one delta arrived for a part whose kind was unknown),
/// and only deltas of `text` parts reach the screen.
const PART_UPDATED = "message.part.updated";
const PART_DELTA = "message.part.delta";

export type AppState = {
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  engine: EngineStatus | null;
  sessions: EngineSession[];
  selectedSession: EngineSession | null;
  messages: Message[];
  /** Every model the engine offers in the selected workspace. */
  models: Model[];
  /** What the open session runs on, or what the next one will. */
  model: Model | null;
  /** Chooses the model the next session is created with. */
  chooseModel: (model: Model) => void;
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
  const [available, setAvailable] = useState<Model[]>([]);
  const [preferred, setPreferred] = useState<Model | null>(null);
  /// What the next turn of the open conversation runs on. A conversation is not
  /// fixed to one model — every prompt names its own — so this starts at
  /// whatever the conversation last used and changes when someone picks.
  const [sessionModel, setSessionModel] = useState<Model | null>(null);
  const preferredNow = useRef<Model | null>(null);
  preferredNow.current = preferred;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Which session the listeners should accept events for. A ref, not state: the
  // listeners are installed once and would otherwise close over whichever
  // session happened to be open when they were.
  const listening = useRef<string | null>(null);
  /// Part id to part kind, for the turn in flight. See `PART_DELTA`.
  const partKinds = useRef(new Map<string, string>());
  /// The text part the last delta belonged to, so a second text part in the
  /// same turn — after a tool call, say — starts a new paragraph instead of
  /// running on from the first.
  const lastTextPart = useRef<string | null>(null);

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

      if (chunk.kind === PART_UPDATED) {
        const part = (chunk.payload as { part?: { id?: unknown; type?: unknown } } | null)?.part;
        if (typeof part?.id === "string" && typeof part.type === "string") {
          partKinds.current.set(part.id, part.type);
        }
        return;
      }

      if (chunk.kind !== PART_DELTA) return;
      const { partID, delta } = (chunk.payload ?? {}) as { partID?: unknown; delta?: unknown };
      if (typeof partID !== "string" || typeof delta !== "string") return;
      if (partKinds.current.get(partID) !== "text") return;

      const newPart = lastTextPart.current !== null && lastTextPart.current !== partID;
      lastTextPart.current = partID;
      setStreaming((before) => (before ?? "") + (newPart ? "\n\n" : "") + delta);
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

    void run(async () => {
      const status = await unwrap(commands.startEngine(path));
      if (cancelled) return;
      setEngine(status);

      // Asked of the engine, never guessed. Provider availability depends on the
      // working directory — the same folder can offer dozens of models or none,
      // depending on whether OpenCode recognises it as a project.
      const offered = await unwrap(commands.listModels());
      if (cancelled) return;
      setAvailable(offered);
      // A remembered preference the engine no longer offers is not usable here.
      // Falling back to the first is better than creating a session on a model
      // that will fail with nothing on the event stream to say why.
      const saved = remembered.preferred();
      const usable = saved && offered.some((m) => m.providerID === saved.providerID && m.id === saved.id);
      setPreferred(usable ? saved : (offered[0] ?? null));

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
    resetTurn();
    setStreaming(null);
    setPending(null);
    setRunning(false);
    if (!selectedSession) {
      setMessages([]);
      setSessionModel(null);
      return;
    }
    // The engine's record of what this conversation last ran on wins: it is a
    // fact. Our own note and the global preference are only fallbacks.
    setSessionModel(
      selectedSession.model ??
        remembered.forSession(selectedSession.id) ??
        preferredNow.current,
    );
    void loadMessages(selectedSession.id);
  }, [selectedSession, loadMessages]);

  /// Forgets the part kinds of the previous turn before a new one streams.
  function resetTurn() {
    partKinds.current.clear();
    lastTextPart.current = null;
  }

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
    models: available,
    model: selectedSession ? sessionModel : preferred,
    streaming,
    pending,
    running,
    error,
    busy,
    selectWorkspace: setSelectedWorkspace,
    selectSession: setSelectedSession,

    // Picking in an open conversation changes its next turn, and also becomes
    // the default for new ones — the same as the reference, which treats a
    // choice made anywhere as the person's current preference.
    chooseModel(model) {
      remembered.prefer(model);
      setPreferred(model);
      if (selectedSession) {
        remembered.remember(selectedSession.id, model);
        setSessionModel(model);
      }
    },

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

        // Always with a model. Without one the engine falls back to its own
        // default, which on the test machine is OpenCode's free tier — and that
        // refuses to answer outside the OpenCode application.
        const chosen = preferred;
        const id = await unwrap(commands.createEngineSession(chosen));
        if (chosen) remembered.remember(id, chosen);
        listening.current = id;
        resetTurn();
        setMessages([]);
        setPending(prompt);
        setStreaming(null);
        setRunning(true);

        await unwrap(commands.sendPrompt(id, prompt, chosen));

        // Read back rather than invented: the engine names the session itself,
        // and a row made up here would show a title it is about to replace.
        const list = await refreshSessions(workspace.path);
        setSelectedSession(list.find((s) => s.id === id) ?? null);
      });
    },

    async send(text) {
      const session = selectedSession;
      if (!session) return;
      const model = sessionModel;
      await run(async () => {
        resetTurn();
        setPending(text);
        setStreaming(null);
        setRunning(true);
        if (model) remembered.remember(session.id, model);
        await unwrap(commands.sendPrompt(session.id, text, model));
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
