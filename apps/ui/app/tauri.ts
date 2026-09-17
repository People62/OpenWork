// The only place that knows we are inside Tauri.
//
// In OpenWork this role is played by `window.__OPENWORK_ELECTRON__`, spread
// across 22 files. Here it is fenced in from the start so it never spreads again
// — and so `next dev` can still be opened in an ordinary browser tab.
//
// The commands and types themselves are not written here: they all come from
// `bindings.ts`, which is generated from Rust and must not be edited by hand.

export { commands, events } from "./bindings";
export type {
  Chunk,
  DatabaseCheck,
  DeepLink,
  DeepLinkStatus,
  EngineError,
  EngineStatus,
  Error as CommandFailure,
  Finished,
  Greeting,
  Message,
  Model,
  Role,
  Session,
  UpdateAvailable,
  Workspace,
} from "./bindings";

export function insideTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/// The shape tauri-specta returns for every command that returns a `Result` in
/// Rust. It does not throw — the error branch comes back as data, and TypeScript
/// refuses code that does not handle it. That is the right behaviour, but at an
/// ordinary call site `try/catch` reads better.
type CommandOutcome<T, E> =
  | { status: "ok"; data: T }
  | { status: "error"; error: E };

/// An error from Rust already shaped as a JavaScript `Error`, but still carrying
/// its typed original value on `.error` — so a caller that needs to tell
/// `notFound` from `database` still can.
export class CommandError<E> extends Error {
  readonly error: E;

  constructor(error: E) {
    super(describe(error));
    this.name = "CommandError";
    this.error = error;
  }
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }
    if ("kind" in error && "message" in error) {
      return `${String(error.kind)}: ${String(error.message)}`;
    }
  }
  return JSON.stringify(error);
}

/// Unwraps a command outcome, or throws an error that is still typed.
export async function unwrap<T, E>(
  promise: Promise<CommandOutcome<T, E>>,
): Promise<T> {
  const outcome = await promise;
  if (outcome.status === "error") throw new CommandError(outcome.error);
  return outcome.data;
}
