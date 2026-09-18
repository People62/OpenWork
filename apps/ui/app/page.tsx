"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ActivityIcon, FileTextIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AppShell } from "./shell/app-shell";
import { layout, useLayout } from "./shell/layout";
import { SidePanel } from "./shell/panel";
import { Composer } from "./session/composer";
import { Conversation } from "./session/conversation";
import { EmptyHero } from "./session/empty-hero";
import { ModelPicker } from "./session/model-picker";
import { insideTauri } from "./tauri";
import { WorkspaceSidebar } from "./workspace/sidebar";
import { useAppState } from "./workspace/state";

/// The workspace, and nothing else.
///
/// Everything that proves the application works — signals, the database check,
/// the engine and update panels — lives at /diagnostics. They were competing for
/// screen space with the actual work, and they are not the product.
export default function Home() {
  const [tauri, setTauri] = useState(false);
  useEffect(() => setTauri(insideTauri()), []);

  if (!tauri) return <OutsideTauri />;
  return <Workspace />;
}

function Workspace() {
  const state = useAppState();
  const panel = useLayout().rightTab;
  const [draft, setDraft] = useState("");

  const session = state.selectedSession;

  // One picker, rendered in whichever composer is on screen. While a
  // conversation is open it is locked: the engine fixes a session's model at
  // creation and offers no way to change it, so a choice made here applies to
  // the next task rather than pretending to change this one.
  const picker = (
    <ModelPicker
      models={state.models}
      value={state.model}
      onChange={state.chooseModel}
      locked={session !== null}
      disabled={state.models.length === 0}
    />
  );

  async function send() {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    await state.send(content);
  }

  return (
    <AppShell
      title={session ? session.title : "New session"}
      sidebar={
        <WorkspaceSidebar
          state={state}
          onNewTask={() => state.selectSession(null)}
        />
      }
      headerActions={
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground hidden lg:inline-flex"
          render={<Link href="/diagnostics" />}
        >
          <ActivityIcon />
          Diagnostics
        </Button>
      }
      panel={panel ? <SidePanel tab={panel} /> : undefined}
      rail={
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "hover:bg-muted hover:text-foreground rounded-xl transition-colors",
            panel === "library" &&
              "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
          )}
          aria-label="Library"
          aria-pressed={panel === "library"}
          onClick={() => layout.toggleRight("library")}
        >
          <FileTextIcon size={15} />
        </Button>
      }
    >
      {state.error ? (
        <div className="border-destructive/40 bg-destructive/10 text-destructive mx-auto mt-4 w-full max-w-3xl rounded-lg border px-3 py-2 text-[13px]">
          {state.error}
        </div>
      ) : null}

      {session ? (
        <>
          <Conversation
            messages={state.messages}
            streaming={state.streaming}
            pending={state.pending}
          />
          <div className="shrink-0 px-2 pb-4 md:px-10">
            <div className="mx-auto w-full max-w-3xl">
              <Composer
                value={draft}
                onChange={setDraft}
                onSend={() => void send()}
                onStop={() => void state.stop()}
                busy={state.running}
                disabled={state.busy && !state.running}
                placeholder="Reply…"
                modelPicker={picker}
              />
            </div>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto py-10">
          {state.selectedWorkspace ? (
            <EmptyHero
              onRunTask={(p) => void state.startTask(p)}
              busy={state.busy}
              modelPicker={picker}
            />
          ) : (
            <NoWorkspace />
          )}
        </div>
      )}
    </AppShell>
  );
}

function NoWorkspace() {
  return (
    <div className="mx-auto max-w-[420px] space-y-1.5 px-6 text-center">
      <h2 className="font-heading text-foreground text-[20px] leading-[26px] font-semibold tracking-[-0.02em]">
        Pick a workspace to start
      </h2>
      <p className="text-muted-foreground text-[13px]">
        A workspace is a folder on this machine. Add one from the sidebar and
        every session you open will run inside it.
      </p>
    </div>
  );
}

function OutsideTauri() {
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
