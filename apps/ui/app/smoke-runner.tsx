"use client";

import { useEffect } from "react";
import { commands, insideTauri, unwrap } from "./tauri";
import { installDevMock } from "./dev-mock";

// At module scope, not in an effect: every screen checks whether it is inside
// Tauri while it mounts, and an effect would run too late.
installDevMock();
import { parseAuthLink } from "./den/links";

/// Runs the smoke checks, and renders nothing.
///
/// It lives in the root layout rather than on a page, because the signals are
/// about the application, not about a screen. When the proving tools moved to
/// /diagnostics the checks went with them — and the application opens at /, so
/// CI would have waited for signals that never came. Mounting it here makes the
/// route irrelevant.
export function SmokeRunner() {
  useEffect(() => {
    if (!insideTauri()) return;

    let cancelled = false;

    (async () => {
      try {
        // Signal 1 — the page loaded, the bundle ran, React mounted.
        await unwrap(commands.reportSignal("webview-loaded"));
        if (cancelled) return;

        await commands.hello("Rantai");
        if (cancelled) return;

        // Signal 2 — Rust's answer reached the screen, then went back to Rust.
        await unwrap(commands.reportSignal("ipc-roundtrip"));
        if (cancelled) return;

        // Signal 3 — SQLite written and read back, inside a transaction that is
        // rolled back, so no rows are left behind.
        const database = await unwrap(commands.checkDatabase());
        if (cancelled) return;
        if (!database.writeReadIntact) {
          throw new Error("the database wrote, but what came back differed");
        }

        await unwrap(commands.reportSignal("data-roundtrip"));
        if (cancelled) return;

        const expectations = await commands.smokeExpectations();
        if (cancelled) return;

        if (expectations.deepLink) {
          await proveDeepLinkArrived(expectations.deepLink);
          if (cancelled) return;
          await unwrap(commands.reportSignal("deep-link-received"));
          if (cancelled) return;
        }

        if (expectations.persistence) {
          await provePersistence(
            expectations.persistence.mode,
            expectations.persistence.marker,
          );
          if (cancelled) return;
          await unwrap(commands.reportSignal("data-persisted"));
          if (cancelled) return;
        }

        if (expectations.engine) {
          await proveEngine(expectations.engine);
          if (cancelled) return;
          await unwrap(commands.reportSignal("engine-as-expected"));
          if (cancelled) return;
        }
      } catch (e) {
        if (cancelled) return;
        // Printed rather than shown: nobody is watching this screen during a
        // smoke run, and the watchdog's report is what CI reads. The whole chain
        // goes out, not just `message` — a reported error is often the cleanup
        // error rather than its cause.
        console.error("smoke:", errorChain(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
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

/// Checks the engine against what CI expects of it.
///
/// "present" is the Phase 4 gate: an installer that carries an engine it cannot
/// actually run is worse than one that carries none, because the failure only
/// shows up on a user's machine. It is not enough that the engine starts — it
/// has to start from the bundle, not from some OpenCode that happens to be on
/// the runner.
async function proveEngine(expectation: string): Promise<void> {
  if (expectation === "present") {
    const status = await unwrap(commands.startEngine("."));
    if (!status.running) {
      throw new Error("the engine reported itself not running after being started");
    }
    if (status.source !== "Sidecar") {
      throw new Error(
        `the engine started from ${status.source} (${status.binaryPath}), not from the bundled sidecar — ` +
          "the installer would ship an engine it never uses",
      );
    }
    // Leave nothing running behind the check.
    await unwrap(commands.stopEngine());
    return;
  }

  await proveEngineAbsent();
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
