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
  providers: Row[];
  connected: string[];
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

/// Answers a prompt the way the engine would, in the engine's own event shapes:
/// a reasoning part and a text part announced by `message.part.updated`, then
/// their deltas, then `session.idle` — with the whole turn written into the
/// message list so the reload that follows finds it.
///
/// The reasoning part is there on purpose. Its deltas look exactly like the
/// answer's — `field` is `"text"` for both — and the screen has to tell them
/// apart by the kind it learned from `message.part.updated`. A mock that sent
/// only answer text would never catch that going wrong.
///
/// Slow on purpose too. An answer that appears instantly hides every bug that
/// only shows up while text is arriving — the composer's Stop state, the scroll
/// following the bottom, a turn switching session halfway through.
function answerPrompt(
  tables: Tables,
  listeners: Listeners,
  sessionId: string,
  prompt: string,
  model: Row | null,
): void {
  const reply = `Mock mode: no engine behind this. You said "${prompt.slice(0, 80)}".`;
  const thinking = "The user wants a reply; this is reasoning and must not appear as the answer.";
  const messageId = nextId("msg");
  const reasoningPart = nextId("prt");
  const textPart = nextId("prt");
  const script: Array<() => void> = [];

  const announce = (id: string, type: string) => () =>
    emit(listeners, "chunk", {
      engineSessionId: sessionId,
      kind: "message.part.updated",
      payload: { sessionID: sessionId, part: { id, messageID: messageId, type } },
    });
  const words = (partId: string, text: string) =>
    text.split(" ").map((word, index) => () =>
      emit(listeners, "chunk", {
        engineSessionId: sessionId,
        kind: "message.part.delta",
        payload: {
          sessionID: sessionId,
          messageID: messageId,
          partID: partId,
          field: "text",
          delta: (index === 0 ? "" : " ") + word,
        },
      }),
    );

  script.push(announce(reasoningPart, "reasoning"), ...words(reasoningPart, thinking));
  script.push(announce(textPart, "text"), ...words(textPart, reply));

  const finish = () => {
    const now = Date.now();
    const asModel = model
      ? { providerID: String(model.providerID), id: String(model.id) }
      : null;
    tables.messages[sessionId] = [
      ...(tables.messages[sessionId] ?? []),
      {
        id: nextId("msg"),
        type: "user",
        time: { created: now - 1000, completed: null },
        text: prompt,
        content: [{ type: "text", text: prompt }],
        model: asModel,
        finish: null,
        error: null,
      },
      {
        id: messageId,
        type: "assistant",
        time: { created: now, completed: now },
        text: null,
        content: [
          { type: "reasoning", text: thinking },
          { type: "text", text: reply },
        ],
        model: asModel,
        finish: "stop",
        error: null,
      },
    ];
    tables.sessions = tables.sessions.map((session) =>
      session.id === sessionId
        ? { ...session, model: asModel, time: { ...(session.time as Row), updated: now } }
        : session,
    );
    emit(listeners, "chunk", {
      engineSessionId: sessionId,
      kind: "session.idle",
      payload: { sessionID: sessionId },
    });
    emit(listeners, "finished", {
      engineSessionId: sessionId,
      cancelled: false,
      error: null,
    });
  };

  let index = 0;
  const step = () => {
    if (index < script.length) {
      script[index]();
      index += 1;
      setTimeout(step, 40);
      return;
    }
    finish();
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
        (args.model as Row | null | undefined) ?? null,
      );
      return null;

    // A fresh object every time, never the stored one.
    //
    // Returning the same reference twice made a real screen look broken: React
    // skips a re-render when `setState` is handed the value it already has, so
    // connecting a provider changed the data and changed nothing on screen. The
    // actual command returns a new object per call; a mock that does not is a
    // mock that invents bugs the application does not have.
    case "list_providers":
      return { all: [...tables.providers], connected: [...tables.connected] };

    // Credentials never reach a fixture: the mock takes the key, forgets it
    // instantly, and only moves the provider between the two lists. Keeping one
    // here would put a real credential in a file that exists to be looked at.
    case "connect_provider":
    case "disconnect_provider": {
      const id = String(args.providerId);
      tables.connected =
        command === "connect_provider"
          ? [...new Set([...tables.connected, id])]
          : tables.connected.filter((each) => each !== id);
      return answers.engine_status ?? null;
    }

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
  const catalogue = (answers.list_providers as
    | { all?: Row[]; connected?: string[] }
    | undefined) ?? {};
  const tables: Tables = {
    workspaces: (answers.list_workspaces as Row[] | undefined) ?? [],
    sessions,
    // The fixture conversation belongs to the first session; the rest start
    // empty, which is also what a real new session looks like.
    messages: sessions[0]
      ? { [String(sessions[0].id)]: (answers.list_engine_messages as Row[]) ?? [] }
      : {},
    providers: catalogue.all ?? [],
    connected: catalogue.connected ?? [],
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
