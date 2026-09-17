"use client";

import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpenIcon, MessageSquarePlusIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { shortTime, useAppState } from "./state";

/// The Release 1 backbone on screen: open a workspace, create a session inside
/// it, and reopen a saved conversation.
///
/// Laid out the way OpenWork lays it out — a quiet sidebar on the left, the
/// conversation taking everything else. The earlier version stacked four cards
/// down a 980px column, which put the most important thing in a third of the
/// screen and pushed the rest below the fold.
export function WorkspacePanel() {
  const state = useAppState();
  const [text, setText] = useState("");

  async function openFolder() {
    const path = await open({ directory: true, multiple: false });
    if (typeof path !== "string") return;
    // The last path segment is nearly always the name that was wanted, and it
    // can be changed later.
    const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
    await state.createWorkspace(name, path);
  }

  async function send() {
    const content = text.trim();
    if (!content) return;
    setText("");
    await state.addMessage("user", content);
  }

  return (
    <div className="flex h-full min-h-0">
      {/* The sidebar keeps the page background rather than the tinted
          `bg-dls-sidebar`. The contrast audit measured muted text at 4.29:1 on
          that tint, short of the 4.5:1 AA needs — the token was right, the
          surface under it was not. Separation comes from the border. */}
      {/* Selected rows are marked with a left rule and the hover tint rather
          than `bg-dls-active`. The contrast audit caught muted text at 4.29:1 on
          that surface, short of the 4.5:1 AA asks for — `--dls-active` is
          `tinted-5`, a step meant to sit behind components, not behind
          step-11 text. The rule reads as "selected" without darkening what the
          text has to stand on. */}
      <aside className="border-border flex w-72 shrink-0 flex-col border-r">
        <div className="flex flex-col gap-1 p-3">
          <div className="flex items-center justify-between px-1 py-1">
            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Workspaces
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={openFolder}
              disabled={state.busy}
            >
              <FolderOpenIcon />
              Open
            </Button>
          </div>

          {state.workspaces.length === 0 ? (
            <p className="text-muted-foreground px-1 py-2 text-sm">
              None yet. Open a folder to begin.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {state.workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <button
                    onClick={() => state.selectWorkspace(workspace)}
                    className={cn(
                      "hover:bg-dls-hover flex w-full flex-col gap-0.5 rounded-md border-l-2 border-transparent px-2 py-1.5 text-left transition-colors",
                      workspace.id === state.selectedWorkspace?.id &&
                        "bg-dls-hover border-l-primary",
                    )}
                  >
                    <span className="truncate text-sm font-medium">{workspace.name}</span>
                    <span className="text-muted-foreground truncate text-xs" dir="rtl">
                      {workspace.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {state.selectedWorkspace && (
          <>
            <div className="border-border mx-3 border-t" />
            <div className="flex min-h-0 flex-1 flex-col gap-1 p-3">
              <div className="flex items-center justify-between px-1 py-1">
                <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Sessions
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => state.createSession(`Session ${shortTime(Date.now())}`)}
                  disabled={state.busy}
                >
                  <MessageSquarePlusIcon />
                  New
                </Button>
              </div>

              {state.sessions.length === 0 ? (
                <p className="text-muted-foreground px-1 py-2 text-sm">
                  No sessions in this workspace yet.
                </p>
              ) : (
                <ScrollArea className="min-h-0 flex-1">
                  <ul className="flex flex-col gap-0.5 pr-2">
                    {state.sessions.map((session) => (
                      <li key={session.id}>
                        <button
                          onClick={() => state.selectSession(session)}
                          className={cn(
                            "hover:bg-dls-hover flex w-full flex-col gap-0.5 rounded-md border-l-2 border-transparent px-2 py-1.5 text-left transition-colors",
                            session.id === state.selectedSession?.id &&
                              "bg-dls-hover border-l-primary",
                          )}
                        >
                          <span className="truncate text-sm">{session.title}</span>
                          <span className="text-muted-foreground text-xs">
                            {shortTime(session.updatedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </div>
          </>
        )}
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {state.error && (
          <pre className="text-destructive border-border m-4 rounded-md border p-3 text-xs whitespace-pre-wrap">
            {state.error}
          </pre>
        )}

        {!state.selectedSession ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
            {state.selectedWorkspace
              ? "Pick a session, or create a new one."
              : "Pick a workspace to begin."}
          </div>
        ) : (
          <>
            <header className="border-border flex h-12 shrink-0 items-center border-b px-5">
              <h1 className="font-heading truncate text-base font-semibold">
                {state.selectedSession.title}
              </h1>
            </header>

            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-6">
                {state.messages.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    This session is empty. Anything written here is saved and can
                    be reopened after the application closes.
                  </p>
                ) : (
                  state.messages.map((message) => (
                    <article key={message.id} className="flex flex-col gap-1.5">
                      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        {message.role}
                      </span>
                      <p
                        className={cn(
                          "rounded-lg px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
                          message.role === "user"
                            ? "bg-dls-surface-muted"
                            : "border-border border",
                        )}
                      >
                        {message.content}
                      </p>
                      <span className="text-muted-foreground text-xs">
                        {shortTime(message.createdAt)}
                      </span>
                    </article>
                  ))
                )}
              </div>
            </ScrollArea>

            <div className="border-border shrink-0 border-t p-4">
              <div className="mx-auto flex max-w-3xl items-end gap-2">
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter sends, Shift+Enter makes a new line — the habit
                    // everyone who will use this already has.
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Write a message…"
                  rows={2}
                  className="min-h-0 resize-none"
                />
                <Button onClick={send} disabled={state.busy || !text.trim()}>
                  <SendIcon />
                  Send
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
