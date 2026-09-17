"use client";

import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { shortTime, useAppState } from "./state";

/// The Release 1 backbone on screen: open a workspace, create a session inside
/// it, and reopen a saved conversation.
///
/// Not wired to the engine yet — the messages here are typed by hand, and that
/// is deliberate. What this screen proves is that data stored in SQLite really
/// can be reopened after the application closes. Connecting it to OpenCode is
/// the next step, not this one.
export function WorkspacePanel() {
  const state = useAppState();
  const [text, setText] = useState("");

  async function openFolder() {
    const path = await open({ directory: true, multiple: false });
    if (typeof path !== "string") return;
    // The default name comes from the last path segment — nearly always what is
    // wanted, and changeable later.
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
    <div className="workspace">
      <aside className="workspace-side">
        <div className="workspace-section">
          <div className="workspace-head">
            <p className="label">Workspaces</p>
            <button onClick={openFolder} disabled={state.busy}>
              Open folder
            </button>
          </div>

          {state.workspaces.length === 0 ? (
            <p className="workspace-empty">None yet. Open a folder to begin.</p>
          ) : (
            <ul className="workspace-list">
              {state.workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <button
                    className={
                      workspace.id === state.selectedWorkspace?.id ? "row selected" : "row"
                    }
                    onClick={() => state.selectWorkspace(workspace)}
                  >
                    <span className="row-title">{workspace.name}</span>
                    <span className="row-sub">{workspace.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {state.selectedWorkspace && (
          <div className="workspace-section">
            <div className="workspace-head">
              <p className="label">Sessions</p>
              <button
                onClick={() => state.createSession(`Session ${shortTime(Date.now())}`)}
                disabled={state.busy}
              >
                New session
              </button>
            </div>

            {state.sessions.length === 0 ? (
              <p className="workspace-empty">No sessions in this workspace yet.</p>
            ) : (
              <ul className="workspace-list">
                {state.sessions.map((session) => (
                  <li key={session.id}>
                    <button
                      className={
                        session.id === state.selectedSession?.id ? "row selected" : "row"
                      }
                      onClick={() => state.selectSession(session)}
                    >
                      <span className="row-title">{session.title}</span>
                      <span className="row-sub">{shortTime(session.updatedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </aside>

      <section className="workspace-main">
        {state.error && <pre className="error">{state.error}</pre>}

        {!state.selectedSession ? (
          <p className="workspace-empty">
            {state.selectedWorkspace
              ? "Pick a session, or create a new one."
              : "Pick a workspace to begin."}
          </p>
        ) : (
          <>
            <div className="conversation">
              {state.messages.length === 0 ? (
                <p className="workspace-empty">
                  This session is empty. Anything written here is saved and can be
                  reopened after the application closes.
                </p>
              ) : (
                state.messages.map((message) => (
                  <div key={message.id} className={`message message-${message.role}`}>
                    <span className="label">{message.role}</span>
                    <p>{message.content}</p>
                    <span className="row-sub">{shortTime(message.createdAt)}</span>
                  </div>
                ))
              )}
            </div>

            <div className="workspace-send">
              <textarea
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
                placeholder="Write a message… (Enter sends, Shift+Enter for a new line)"
                rows={3}
              />
              <button onClick={send} disabled={state.busy || !text.trim()}>
                Send
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
