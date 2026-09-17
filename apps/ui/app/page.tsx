"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ActivityIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkspacePanel } from "./workspace/panel";
import { insideTauri } from "./tauri";

/// The workspace, and nothing else.
///
/// Everything that proves the application works — signals, the database check,
/// the engine and update panels — moved to /diagnostics. They were competing for
/// screen space with the actual work, and they are not the product.
export default function Home() {
  const [tauri, setTauri] = useState(false);
  useEffect(() => setTauri(insideTauri()), []);

  if (!tauri) {
    return (
      <main className="mx-auto flex max-w-lg flex-col gap-3 p-10">
        <h1 className="font-heading text-2xl font-semibold">Rantai</h1>
        <p className="text-muted-foreground text-sm">
          This page is open in an ordinary browser, so there is no Rust side to
          talk to. Run <code className="font-mono text-xs">bun run dev</code> from
          the repository root to open it inside a Tauri window.
        </p>
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="border-border flex h-11 shrink-0 items-center justify-between border-b px-4">
        <span className="font-heading text-sm font-semibold">Rantai</span>
        {/* Base UI composes through `render`, not Radix's `asChild`. */}
        <Button variant="ghost" size="sm" render={<Link href="/diagnostics" />}>
          <ActivityIcon />
          Diagnostics
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        <WorkspacePanel />
      </div>
    </div>
  );
}
