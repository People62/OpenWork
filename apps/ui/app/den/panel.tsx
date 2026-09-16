"use client";

import { useCallback, useEffect, useState } from "react";
import { commands, events, unwrap, type DeepLinkStatus } from "../tauri";
import {
  DEFAULT_DEN,
  parseAuthLink,
  parseManualPaste,
  type DenAuthLink,
} from "./links";

/// The Den sign-in, built first in Phase 3 on purpose.
///
/// Of the whole sign-in, only two things are native: receiving
/// `openwork://den-auth` from the system, and opening the system browser. The
/// rest is TypeScript that moves across unchanged. Those two are the fragile
/// part — URL scheme registration behaves differently on every OS, is at its most
/// fragile in development mode, and in Rantai was never covered by CI at all.
///
/// So this screen shows the registration state exactly as it is, and always
/// keeps a manual paste path beside it. That path is pure TypeScript, zero
/// native, and works even when deep links do not.
export function DenPanel() {
  const [status, setStatus] = useState<DeepLinkStatus | null>(null);
  const [pasted, setPasted] = useState("");
  const [received, setReceived] = useState<DenAuthLink | null>(null);
  const [origin, setOrigin] = useState<"deep-link" | "paste" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback((urls: string[]) => {
    for (const url of urls) {
      const parsed = parseAuthLink(url);
      if (parsed) {
        setReceived(parsed);
        setOrigin("deep-link");
        setError(null);
        return;
      }
    }
    // A link that arrives but is not recognised is not something to pass over in
    // silence — it means Den is sending a shape we do not handle yet.
    if (urls.length > 0) {
      setError(`a link arrived but was not recognised: ${urls.join(", ")}`);
    }
  }, []);

  useEffect(() => {
    void commands.deepLinkStatus().then(setStatus);

    // Read first, then listen. The link that *launched* the application arrives
    // before this page exists — and that is the commonest case of all for a
    // sign-in: the user clicks a link while the application is not running. It is
    // read, not drained, so the smoke check can read it too; the first version
    // drained it and the two raced.
    void commands.launchLinks().then(accept);

    const drop = events.deepLink.listen((e) => accept(e.payload.urls));

    return () => {
      void drop.then((stop) => stop());
    };
  }, [accept]);

  const register = useCallback(async () => {
    setError(null);
    try {
      setStatus(await unwrap(commands.registerDeepLink()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const openBrowser = useCallback(async () => {
    setError(null);
    try {
      await unwrap(commands.openInBrowser(`${DEFAULT_DEN}/desktop-auth`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const usePaste = useCallback(() => {
    const parsed = parseManualPaste(pasted);
    if (!parsed) {
      setError(
        "the paste was not recognised — paste an openwork://den-auth… link, or just the code",
      );
      return;
    }
    setReceived(parsed);
    setOrigin("paste");
    setError(null);
  }, [pasted]);

  return (
    <div className="card">
      <p className="label">Sign in to Den</p>

      <dl>
        <dt>Scheme</dt>
        <dd>{status ? `${status.scheme}://` : "…"}</dd>
        <dt>Registered with the system</dt>
        <dd>
          {status === null
            ? "…"
            : status.error
              ? `could not be asked — ${status.error}`
              : status.registered
                ? "yes"
                : "not yet"}
        </dd>
        <dt>Den</dt>
        <dd>{DEFAULT_DEN}</dd>
      </dl>

      <div className="button-row">
        <button onClick={register} disabled={status?.registered === true}>
          Register the scheme
        </button>
        <button onClick={openBrowser}>Open the browser</button>
      </div>

      <p className="label" style={{ marginTop: 20 }}>
        Fallback — paste it yourself
      </p>
      <textarea
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        placeholder="openwork://den-auth?grant=… or just the code"
        rows={2}
      />
      <div className="button-row">
        <button onClick={usePaste} disabled={!pasted.trim()}>
          Use the paste
        </button>
      </div>

      {error && <pre className="error">{error}</pre>}

      {received && (
        <>
          <p className="label" style={{ marginTop: 20 }}>
            Grant received by {origin === "deep-link" ? "deep link" : "paste"}
          </p>
          <dl>
            <dt>Grant</dt>
            {/* Only the prefix. A grant is a credential, and a screen can end up
                in a screenshot or a shared display. */}
            <dd>
              {received.grant.slice(0, 8)}… ({received.grant.length} characters)
            </dd>
            <dt>Den</dt>
            <dd>{received.denBaseUrl}</dd>
          </dl>
          <p className="label">
            Exchanging the grant for a session comes next — that is the Den
            client, and it is TypeScript that moves across unchanged.
          </p>
        </>
      )}
    </div>
  );
}
