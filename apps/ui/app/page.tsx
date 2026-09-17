"use client";

import { useEffect, useState } from "react";
import { DenPanel } from "./den/panel";
import { parseAuthLink } from "./den/links";
import { EnginePanel } from "./engine";
import { WorkspacePanel } from "./workspace/panel";
import {
  commands,
  insideTauri,
  unwrap,
  type DatabaseCheck,
  type Greeting,
} from "./tauri";

// The signals that close the gate, and their order means something: a later one
// cannot arrive unless the one before it did. Rust waits for whichever of them
// CI has asked for.
const SIGNALS = [
  "webview-loaded",
  "ipc-roundtrip",
  "data-roundtrip",
  "deep-link-received",
  "engine-absent-correct",
  "data-persisted",
] as const;
type Signal = (typeof SIGNALS)[number];

export default function Home() {
  const [greeting, setGreeting] = useState<Greeting | null>(null);
  const [check, setCheck] = useState<DatabaseCheck | null>(null);
  const [sent, setSent] = useState<Signal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tauri, setTauri] = useState(false);
  // A real workspace directory follows; for now the engine runs in the process's
  // working directory, which is enough to prove the flow.
  const workingDir = ".";

  useEffect(() => {
    const present = insideTauri();
    setTauri(present);
    if (!present) return;

    let cancelled = false;
    const mark = (signal: Signal) => {
      if (!cancelled) setSent((before) => [...before, signal]);
    };

    (async () => {
      try {
        // Signal 1 — the page loaded, the bundle ran, React mounted.
        await unwrap(commands.reportSignal("webview-loaded"));
        if (cancelled) return;
        mark("webview-loaded");

        const hello = await commands.hello("Rantai");
        if (cancelled) return;
        setGreeting(hello);

        // Signal 2 — Rust's answer reached the screen, then went back to Rust.
        // A round trip in both directions, not merely a call that did not throw.
        await unwrap(commands.reportSignal("ipc-roundtrip"));
        if (cancelled) return;
        mark("ipc-roundtrip");

        // Signal 3 — SQLite written and read back. Rust does it inside a
        // transaction that is rolled back, so no rows are left behind.
        const database = await unwrap(commands.checkDatabase());
        if (cancelled) return;
        if (!database.writeReadIntact) {
          throw new Error("the database wrote, but what came back differed");
        }
        setCheck(database);

        await unwrap(commands.reportSignal("data-roundtrip"));
        if (cancelled) return;
        mark("data-roundtrip");

        const expectations = await commands.smokeExpectations();
        if (cancelled) return;

        // Signal 4 — only asked for when CI launches the application with a deep
        // link. URL scheme registration was never covered by CI in Rantai at all.
        if (expectations.deepLink) {
          await proveDeepLinkArrived(expectations.deepLink);
          if (cancelled) return;
          await unwrap(commands.reportSignal("deep-link-received"));
          if (cancelled) return;
          mark("deep-link-received");
        }

        // Signal 5 — Release 1 promises a conversation is saved and can be
        // reopened. That is only provable across two runs of the application.
        if (expectations.persistence) {
          await provePersistence(
            expectations.persistence.mode,
            expectations.persistence.marker,
          );
          if (cancelled) return;
          await unwrap(commands.reportSignal("data-persisted"));
          if (cancelled) return;
          mark("data-persisted");
        }

        // Signal 6 — only asked for when CI deliberately runs without an engine
        // binary. The Phase 2 gate wants the failure path tested first: the
        // message must name the cause, not the cleanup symptom.
        if (expectations.engineAbsent) {
          await proveEngineAbsent();
          if (cancelled) return;
          await unwrap(commands.reportSignal("engine-absent-correct"));
          if (cancelled) return;
          mark("engine-absent-correct");
        }
      } catch (e) {
        if (cancelled) return;
        // Print the whole chain, not just `message` — a reported error is often
        // the cleanup error rather than its cause.
        setError(errorChain(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <header>
        <p className="label">Phase 3 · the interface is moving</p>
        <h1>Rantai</h1>
        <p className="lede">
          The Release 1 backbone: open a workspace, create a session inside it,
          and reopen a saved conversation. The panels below it are still proving
          tools, not the finished interface.
        </p>
      </header>

      {!tauri && (
        <div className="card">
          <p className="label">Outside Tauri</p>
          <p style={{ margin: 0, color: "var(--muted)" }}>
            This page is open in an ordinary browser, so there is no Rust side to
            talk to. Run <code>bun run dev</code> from the repository root to open
            it inside a Tauri window.
          </p>
        </div>
      )}

      {error && (
        <div className="card">
          <p className="label">Error</p>
          <pre className="error">{error}</pre>
        </div>
      )}

      {tauri && <WorkspacePanel />}

      {tauri && <DenPanel />}

      {tauri && <EnginePanel workingDir={workingDir} />}

      {tauri && (
        <div className="card">
          <p className="label">Signals</p>
          <ul className="signals">
            {SIGNALS.map((signal) => {
              const done = sent.includes(signal);
              return (
                <li key={signal}>
                  <span className={done ? "pip ok" : "pip wait"}>
                    {done ? "arrived" : "waiting"}
                  </span>
                  {signal}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {check && (
        <div className="card">
          <p className="label">Database</p>
          <dl>
            <dt>Write then read</dt>
            <dd>{check.writeReadIntact ? "intact" : "differed"}</dd>
            <dt>Workspaces</dt>
            <dd>{check.workspaceCount}</dd>
            <dt>Sessions</dt>
            <dd>{check.sessionCount}</dd>
            <dt>Messages</dt>
            <dd>{check.messageCount}</dd>
          </dl>
        </div>
      )}

      {greeting && (
        <div className="card">
          <p className="label">Answer from Rust</p>
          <dl>
            <dt>Message</dt>
            <dd>{greeting.message}</dd>
            <dt>Platform</dt>
            <dd>
              {greeting.platform} · {greeting.arch}
            </dd>
            <dt>Tauri</dt>
            <dd>{greeting.tauriVersion}</dd>
            <dt>Application</dt>
            <dd>{greeting.appVersion}</dd>
          </dl>
        </div>
      )}
    </main>
  );
}

/// Writes marked data, or reads it back and demands it is intact.
///
/// Run across two different processes. A test inside one process can pass
/// entirely from an in-memory cache without a single byte touching disk — and
/// "can be reopened after the application closes" is exactly what Release 1
/// promises.
async function provePersistence(mode: string, marker: string): Promise<void> {
  const content = `content-${marker}`;

  if (mode === "write") {
    const workspace = await unwrap(commands.createWorkspace(marker, `/smoke/${marker}`));
    const session = await unwrap(commands.createSession(workspace.id, marker));
    await unwrap(commands.addMessage(session.id, "user", content));
    return;
  }

  const workspace = (await unwrap(commands.listWorkspaces())).find(
    (w) => w.name === marker,
  );
  if (!workspace) {
    throw new Error(
      `no workspace marked ${marker} after the application was restarted — the data did not survive`,
    );
  }

  const session = (await unwrap(commands.listSessions(workspace.id))).find(
    (s) => s.title === marker,
  );
  if (!session) {
    throw new Error(`the workspace survived but its session is gone: ${marker}`);
  }

  const messages = await unwrap(commands.listMessages(session.id));
  const match = messages.find((m) => m.content === content);
  if (!match) {
    throw new Error(
      `the session survived but its message is gone; what is there: ${
        messages.map((m) => m.content).join(", ") || "(empty)"
      }`,
    );
  }
  if (match.role !== "user") {
    throw new Error(`the message role changed to ${match.role}`);
  }
}

/// Proves a deep link really reached the interface, carrying the right grant.
///
/// It reads the launch links rather than waiting for an event: the link that
/// *launched* the application arrives before this page exists. The first version
/// of this code lost it entirely; the second drained it and raced with the Den
/// panel. Both were found by running, not by reading.
async function proveDeepLinkArrived(expectedGrant: string): Promise<void> {
  const urls = await commands.launchLinks();

  if (urls.length === 0) {
    throw new Error(
      "no deep link arrived — the system never handed one over, or it was lost before the interface was ready",
    );
  }

  const parsed = urls.map(parseAuthLink).find((p) => p !== null);
  if (!parsed) {
    throw new Error(`a link arrived but did not parse: ${urls.join(", ")}`);
  }
  if (parsed.grant !== expectedGrant) {
    throw new Error(
      `the grant that arrived differs: ${parsed.grant}, not ${expectedGrant}`,
    );
  }
}

/// Starts the engine when its binary is deliberately absent, and demands the
/// message is right. If it starts anyway, the check itself is flawed — the
/// application found some other OpenCode — and that must fail the smoke run
/// rather than quietly pass.
async function proveEngineAbsent(): Promise<void> {
  const outcome = await commands.startEngine(".");

  if (outcome.status === "ok") {
    throw new Error(
      "the engine started even though its binary was deliberately removed — " +
        `it found ${outcome.data.binaryPath} via ${outcome.data.source}. ` +
        "The check is flawed, not the application.",
    );
  }

  const message = outcome.error.message;

  if (!message.includes("not found")) {
    throw new Error(`the message does not name the problem: ${message}`);
  }
  if (!message.includes("PATH")) {
    throw new Error(`the message does not say where it looked: ${message}`);
  }

  // The costliest mistake in Rantai: a message talking about the cleanup layer
  // when the cause was a missing binary.
  for (const misleading of ["SIGKILL", "signal", "exit code", "terminated"]) {
    if (message.includes(misleading)) {
      throw new Error(
        `the message names "${misleading}" when the cause is a missing binary: ${message}`,
      );
    }
  }
}

function errorChain(e: unknown): string {
  const lines: string[] = [];
  let current: unknown = e;
  let depth = 0;

  while (current != null && depth < 8) {
    if (current instanceof Error) {
      lines.push(current.stack ?? `${current.name}: ${current.message}`);
      if (current instanceof AggregateError) {
        for (const inner of current.errors) lines.push(`  · ${errorChain(inner)}`);
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      lines.push(typeof current === "string" ? current : JSON.stringify(current));
      current = null;
    }
    depth += 1;
  }

  return lines.join("\n\ncaused by:\n");
}
