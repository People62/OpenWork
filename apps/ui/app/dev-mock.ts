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
type Row = Record<string, unknown>;

/// Timestamps in the fixtures are offsets from now, in milliseconds, so the
/// screens always show plausible recent times rather than a frozen date.
///
/// Matches `createdAt` and `updatedAt`, and `created`/`updated`/`completed`
/// inside the engine's nested `time` objects.
function withTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withTimes);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const isTime = /At$/.test(key) || /^(created|updated|completed)$/.test(key);
      out[key] = typeof inner === "number" && isTime ? Date.now() + inner : withTimes(inner);
    }
    return out;
  }
  return value;
}

/// The rows the mock is standing over.
///
/// It has to keep them. A fixture alone cannot answer a write — creating a
/// session must hand back something the very next read can find — and it cannot
/// answer that read either: the state hook reloads the message list as soon as
/// the new session is selected, and a fixture that ignores the session id would
/// replace what was just written with somebody else's conversation.
///
/// Both tables stand in for **OpenCode's** store, not ours. Only workspaces are
/// Rantai's own.
///
/// Nothing survives a reload, which is the point. This is a mock, not a store.
type Tables = {
  workspaces: Row[];
  sessions: Row[];
  /// Keyed by engine session id, oldest first — the order the command returns.
  messages: Record<string, Row[]>;
};

/// Handlers registered through `plugin:event|listen`, by the id handed back.
///
/// Without these the mock can show a saved conversation but never a live one:
/// tokens arrive as Tauri events, and a `send_prompt` that answers nothing
/// leaves the composer spinning forever. Faking the event channel is what makes
/// the main screen usable in a browser at all.
///
/// Keyed by id rather than by name so `plugin:event|unlisten` can actually
/// remove one. An earlier version ignored unlisten, and every token arrived
/// twice on screen — React mounts effects twice in development, so the listener
/// from the first mount was still subscribed alongside the second.
type Listeners = Map<number, { event: string; handler: (event: unknown) => void }>;

let made = 0;

function nextId(prefix: string): string {
  made += 1;
  return `${prefix}_mock_${made}`;
}

function emit(listeners: Listeners, name: string, payload: unknown): void {
  for (const [id, entry] of listeners) {
    if (entry.event === name) entry.handler({ event: name, id, payload });
  }
}

/// Answers a prompt the way the engine would: a few tokens spread over a second,
/// then the finished event, with the whole turn written into the message list so
/// the reload that follows finds it.
///
/// Slow on purpose. An answer that appears instantly hides every bug that only
/// shows up while text is arriving — the composer's Stop state, the scroll
/// following the bottom, a turn switching session halfway through.
function answerPrompt(
  tables: Tables,
  listeners: Listeners,
  sessionId: string,
  prompt: string,
): void {
  const reply = `Mock mode: no engine behind this. You said "${prompt.slice(0, 80)}".`;
  const words = reply.split(" ");
  let index = 0;

  const step = () => {
    if (index < words.length) {
      emit(listeners, "chunk", {
        engineSessionId: sessionId,
        kind: "session.next.text.delta",
        payload: { text: (index === 0 ? "" : " ") + words[index] },
      });
      index += 1;
      setTimeout(step, 60);
      return;
    }

    const now = Date.now();
    tables.messages[sessionId] = [
      ...(tables.messages[sessionId] ?? []),
      {
        id: nextId("msg"),
        type: "user",
        time: { created: now - 1000, completed: null },
        text: prompt,
        content: [],
        finish: null,
        error: null,
      },
      {
        id: nextId("msg"),
        type: "assistant",
        time: { created: now, completed: now },
        text: null,
        content: [{ type: "text", text: reply }],
        finish: "stop",
        error: null,
      },
    ];
    tables.sessions = tables.sessions.map((session) =>
      session.id === sessionId
        ? { ...session, time: { ...(session.time as Row), updated: now } }
        : session,
    );

    emit(listeners, "finished", {
      engineSessionId: sessionId,
      cancelled: false,
      error: null,
    });
  };

  setTimeout(step, 250);
}

function answer(
  answers: Answers,
  tables: Tables,
  listeners: Listeners,
  command: string,
  args: Record<string, unknown>,
): unknown {
  const now = Date.now();
  switch (command) {
    // ----------------------------------------------------------- events
    case "plugin:event|listen": {
      made += 1;
      listeners.set(made, {
        event: String(args.event),
        handler: args.handler as (event: unknown) => void,
      });
      return made;
    }
    case "plugin:event|unlisten":
      listeners.delete(Number(args.eventId));
      return null;

    // ------------------------------------------------------- workspaces
    case "list_workspaces":
      return tables.workspaces;

    case "create_workspace": {
      const row = { id: nextId("w"), name: args.name, path: args.path, createdAt: now };
      tables.workspaces = [...tables.workspaces, row];
      return row;
    }

    // ---------------------------------------------- sessions and turns
    case "list_engine_sessions":
      return tables.sessions
        .filter((row) => {
          if (typeof args.directory !== "string") return true;
          const location = row.location as { directory?: string } | undefined;
          return !location?.directory || location.directory === args.directory;
        })
        .sort(
          (a, b) =>
            Number((b.time as Row).updated) - Number((a.time as Row).updated),
        );

    case "create_engine_session": {
      const id = nextId("ses");
      tables.sessions = [
        ...tables.sessions,
        {
          id,
          title: "New session",
          model: args.model ?? null,
          time: { created: now, updated: now },
          location: { directory: null },
        },
      ];
      tables.messages[id] = [];
      return id;
    }

    case "list_engine_messages":
      return tables.messages[String(args.engineSessionId)] ?? [];

    case "send_prompt":
      answerPrompt(
        tables,
        listeners,
        String(args.engineSessionId),
        String(args.text),
      );
      return null;

    case "stop_conversation":
      emit(listeners, "finished", {
        engineSessionId: args.engineSessionId,
        cancelled: true,
        error: null,
      });
      return null;

    default:
      return Object.prototype.hasOwnProperty.call(answers, command)
        ? answers[command]
        : null;
  }
}

export function installDevMock(): void {
  if (typeof window === "undefined") return;
  if ("__TAURI_INTERNALS__" in window) return;
  if (process.env.NEXT_PUBLIC_RANTAI_MOCK !== "1") return;

  const answers = withTimes(fixtures) as Answers;
  const sessions = (answers.list_engine_sessions as Row[] | undefined) ?? [];
  const tables: Tables = {
    workspaces: (answers.list_workspaces as Row[] | undefined) ?? [],
    sessions,
    // The fixture conversation belongs to the first session; the rest start
    // empty, which is also what a real new session looks like.
    messages: sessions[0]
      ? { [String(sessions[0].id)]: (answers.list_engine_messages as Row[]) ?? [] }
      : {},
  };
  const listeners: Listeners = new Map();

  // Tauri's own `unlisten` reaches for this *before* it invokes the command, so
  // without it the call throws and the listener is never removed. That is what
  // made every token appear twice: the subscription from React's first
  // development mount stayed alive beside the second, and the unhandled
  // rejection it threw was the only sign.
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    value: { unregisterListener: () => {} },
    configurable: true,
  });

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {
      // The real one hands back a numeric id and keeps the function itself in a
      // registry. Returning the function is what lets `plugin:event|listen`
      // above find the handler to call.
      transformCallback: (callback: unknown) => callback,
      invoke: (command: string, args?: Record<string, unknown>) =>
        Promise.resolve(answer(answers, tables, listeners, command, args ?? {})),
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
