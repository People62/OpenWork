"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  commands,
  events,
  unwrap,
  type Chunk,
  type EngineStatus,
  type Finished,
  type Model,
} from "./tauri";

/// One conversation with OpenCode: the engine is started from Rust, tokens
/// arrive as events, and the stop button really does stop it.
///
/// This is the Release 1 backbone in its barest form. Its appearance will be
/// replaced later; what it proves is the flow, not the look.
export function EnginePanel({ workingDir }: { workingDir: string }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [finished, setFinished] = useState<Finished | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void commands.engineStatus().then((outcome) => {
      if (outcome.status === "ok") setStatus(outcome.data);
    });

    // These listeners are typed because their types are generated from Rust,
    // exactly like the commands. Events are not exempt from that rule.
    const dropChunk = events.chunk.listen((e) => {
      setChunks((before) => [...before, e.payload]);
    });
    const dropFinished = events.finished.listen((e) => {
      setStreaming(false);
      setFinished(e.payload);
    });

    return () => {
      void dropChunk.then((drop) => drop());
      void dropFinished.then((drop) => drop());
    };
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [chunks.length]);

  const run = useCallback(async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const start = () =>
    run("starting", async () => {
      setStatus(await unwrap(commands.startEngine(workingDir)));
      // Models are asked of the engine, never guessed: provider availability
      // depends on the engine's working directory. The same folder can offer
      // dozens of models or none, depending on whether OpenCode recognises it as
      // a project.
      const list = await unwrap(commands.listModels());
      setModels(list);
      setSelectedModel((current) =>
        current || (list[0] ? `${list[0].providerID}/${list[0].id}` : ""),
      );
    });

  const stop = () =>
    run("stopping", async () => {
      setStatus(await unwrap(commands.stopEngine()));
      setSessionId(null);
    });

  const newSession = () =>
    run("creating a session", async () => {
      const [providerID, ...rest] = selectedModel.split("/");
      const id = rest.join("/");
      if (!providerID || !id) {
        throw new Error("pick a model first");
      }
      // The session starts on this model, and every prompt names it again —
      // a conversation can change model between turns.
      setSessionId(await unwrap(commands.createEngineSession({ providerID, id })));
      setChunks([]);
      setFinished(null);
    });

  const send = () =>
    run("sending", async () => {
      if (!sessionId) return;
      setChunks([]);
      setFinished(null);
      setStreaming(true);
      const [providerID, ...rest] = selectedModel.split("/");
      const model = providerID && rest.length ? { providerID, id: rest.join("/") } : null;
      try {
        await unwrap(commands.sendPrompt(sessionId, text, model));
      } catch (e) {
        setStreaming(false);
        throw e;
      }
    });

  const interrupt = () =>
    run("stopping the conversation", async () => {
      if (!sessionId) return;
      await unwrap(commands.stopConversation(sessionId));
    });

  return (
    <div className="card">
      <p className="label">OpenCode engine</p>

      <dl>
        <dt>State</dt>
        <dd>{status?.running ? "running" : "stopped"}</dd>
        {status?.address && (
          <>
            <dt>Address</dt>
            <dd>{status.address}</dd>
          </>
        )}
        {status?.binaryPath && (
          <>
            <dt>Binary</dt>
            <dd>
              {status.binaryPath} ({status.source})
            </dd>
          </>
        )}
        {sessionId && (
          <>
            <dt>Engine session</dt>
            <dd>{sessionId}</dd>
          </>
        )}
      </dl>

      <div className="button-row">
        <button onClick={start} disabled={!!busy || status?.running}>
          Start
        </button>
        <button onClick={stop} disabled={!!busy || !status?.running}>
          Stop
        </button>
        <button
          onClick={newSession}
          disabled={!!busy || !status?.running || !selectedModel}
        >
          New session
        </button>
      </div>

      {status?.running && (
        <>
          <p className="label" style={{ marginTop: 16 }}>
            Model ({models.length} available)
          </p>
          {models.length === 0 ? (
            <p className="workspace-empty">
              The engine sees no models in this folder. Provider availability
              depends on the working directory — make sure the folder you opened
              is recognised by OpenCode as a project, and that provider
              credentials are present in its environment.
            </p>
          ) : (
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
            >
              {models.map((model) => {
                const value = `${model.providerID}/${model.id}`;
                return (
                  <option key={value} value={value}>
                    {value}
                  </option>
                );
              })}
            </select>
          )}
        </>
      )}

      {sessionId && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write something for the engine…"
            rows={3}
          />
          <div className="button-row">
            <button onClick={send} disabled={!!busy || streaming || !text.trim()}>
              Send
            </button>
            <button onClick={interrupt} disabled={!streaming}>
              Stop
            </button>
            {streaming && <span className="pip wait">streaming</span>}
          </div>
        </>
      )}

      {error && <pre className="error">{error}</pre>}

      {finished && (
        <p className="label">
          {finished.cancelled
            ? "the stream was stopped"
            : finished.error
              ? `the stream stopped: ${finished.error}`
              : "the stream finished"}
        </p>
      )}

      {chunks.length > 0 && (
        <div className="stream">
          {chunks.map((chunk, index) => (
            <div key={index} className="chunk">
              <span className="pip ok">{chunk.kind}</span>
              <pre>{summarize(chunk.payload)}</pre>
            </div>
          ))}
          <div ref={end} />
        </div>
      )}
    </div>
  );
}

/// Event payloads are deliberately typed `unknown` — their shape is decided by
/// OpenCode, not by us. Narrowing happens here, in one place.
function summarize(payload: unknown): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
