"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DenPanel } from "../den/panel";
import { EnginePanel } from "../engine";
import { UpdatePanel } from "../update";
import { Button } from "@/components/ui/button";
import {
  commands,
  insideTauri,
  unwrap,
  type DatabaseCheck,
  type Greeting,
} from "../tauri";

/// The proving tools, on a page of their own.
///
/// They used to sit under the workspace on the main screen, competing for room
/// with the actual work. They are not the product — they are how CI knows the
/// product runs — so they moved here, where they can be looked at deliberately.
///
/// The smoke checks still run from this page, because the smoke run opens it
/// directly.
export default function Diagnostics() {
  const [greeting, setGreeting] = useState<Greeting | null>(null);
  const [check, setCheck] = useState<DatabaseCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tauri, setTauri] = useState(false);
  const workingDir = ".";

  useEffect(() => {
    const present = insideTauri();
    setTauri(present);
    if (!present) return;

    // Display only. The checks themselves run from SmokeRunner in the root
    // layout, so they do not depend on anyone opening this page.
    let cancelled = false;
    void commands.hello("Rantai").then((g) => {
      if (!cancelled) setGreeting(g);
    });
    void unwrap(commands.checkDatabase())
      .then((c) => {
        if (!cancelled) setCheck(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Diagnostics
        </p>
        <h1 className="font-heading text-2xl font-semibold">Proving tools</h1>
        <p className="text-muted-foreground text-sm">
          How CI knows the application runs. Not part of the product.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          render={<Link href="/" />}
        >
          Back to the workspace
        </Button>
      </header>

      {!tauri && (
        <Panel title="Outside Tauri">
          <p className="text-muted-foreground text-sm">
            This page is open in an ordinary browser, so there is no Rust side to
            talk to.
          </p>
        </Panel>
      )}

      {error && (
        <Panel title="Error">
          <pre className="text-destructive text-xs whitespace-pre-wrap">{error}</pre>
        </Panel>
      )}

      {check && (
        <Panel title="Database">
          <Rows
            rows={[
              ["Write then read", check.writeReadIntact ? "intact" : "differed"],
              ["Workspaces", String(check.workspaceCount)],
            ]}
          />
        </Panel>
      )}

      {greeting && (
        <Panel title="Answer from Rust">
          <Rows
            rows={[
              ["Message", greeting.message],
              ["Platform", `${greeting.platform} · ${greeting.arch}`],
              ["Tauri", greeting.tauriVersion],
              ["Application", greeting.appVersion],
            ]}
          />
        </Panel>
      )}

      {tauri && <DenPanel />}
      {tauri && <EnginePanel workingDir={workingDir} />}
      {tauri && <UpdatePanel />}
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-lg border p-5">
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground text-sm">{label}</dt>
          <dd className="font-mono text-xs break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

