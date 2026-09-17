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

/// Timestamps in the fixtures are offsets from now, in milliseconds, so the
/// screens always show plausible recent times rather than a frozen date.
function withTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withTimes);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        typeof inner === "number" && /At$/.test(key) ? Date.now() + inner : withTimes(inner);
    }
    return out;
  }
  return value;
}

type Row = Record<string, unknown>;

/// The rows the mock is standing over.
///
/// It has to keep them. A fixture alone cannot answer a write — `create_session`
/// must hand back the title just typed — and it cannot answer the read that
/// follows either: the state hook reloads the message list as soon as the new
/// session is selected, and a fixture that ignores the session id would replace
/// what was written with somebody else's conversation. Standing in for SQLite
/// means remembering like SQLite.
///
/// Nothing survives a reload, which is the point. This is a mock, not a store.
type Tables = {
  workspaces: Row[];
  sessions: Row[];
  messages: Row[];
};

let made = 0;

function nextId(prefix: string): string {
  made += 1;
  return `${prefix}-mock-${made}`;
}

function answer(
  answers: Answers,
  tables: Tables,
  command: string,
  args: Record<string, unknown>,
): unknown {
  const now = Date.now();
  switch (command) {
    case "list_workspaces":
      return tables.workspaces;

    case "create_workspace": {
      const row = { id: nextId("w"), name: args.name, path: args.path, createdAt: now };
      tables.workspaces = [...tables.workspaces, row];
      return row;
    }

    // Newest first, the order the real query returns.
    case "list_sessions":
      return tables.sessions
        .filter((row) => row.workspaceId === args.workspaceId)
        .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));

    case "create_session": {
      const row = {
        id: nextId("s"),
        workspaceId: args.workspaceId,
        title: args.title,
        createdAt: now,
        updatedAt: now,
      };
      tables.sessions = [...tables.sessions, row];
      return row;
    }

    case "list_messages":
      return tables.messages.filter((row) => row.sessionId === args.sessionId);

    case "add_message": {
      const row = {
        id: nextId("m"),
        sessionId: args.sessionId,
        role: args.role,
        content: args.content,
        createdAt: now,
      };
      tables.messages = [...tables.messages, row];
      // Rust bumps the session's `updatedAt` on every message, and the sidebar
      // sorts on it. Leaving it alone here would make a session you just used
      // stay where it was.
      tables.sessions = tables.sessions.map((session) =>
        session.id === args.sessionId ? { ...session, updatedAt: now } : session,
      );
      return row;
    }

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
  const tables: Tables = {
    workspaces: (answers.list_workspaces as Row[] | undefined) ?? [],
    sessions: (answers.list_sessions as Row[] | undefined) ?? [],
    messages: (answers.list_messages as Row[] | undefined) ?? [],
  };

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {
      transformCallback: (callback: unknown) => callback,
      invoke: (command: string, args?: Record<string, unknown>) =>
        Promise.resolve(answer(answers, tables, command, args ?? {})),
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
