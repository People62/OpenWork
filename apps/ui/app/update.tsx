"use client";

import { useCallback, useState } from "react";
import { commands, unwrap, type UpdateAvailable } from "./tauri";

/// Checking for updates, and installing one.
///
/// Neither happens on its own. An update that installs itself while someone is
/// mid-conversation with the engine is a worse outcome than one that waits, so
/// the decision stays with whoever is at the keyboard.
export function UpdatePanel() {
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [available, setAvailable] = useState<UpdateAvailable | null>(null);
  const [upToDate, setUpToDate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    setUpToDate(false);
    try {
      const update = await unwrap(commands.checkForUpdate());
      setAvailable(update);
      setUpToDate(update === null);
    } catch (e) {
      // Being offline is ordinary, not exceptional — so the message says what
      // actually happened rather than "update check failed".
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  const install = useCallback(async () => {
    setInstalling(true);
    setError(null);
    try {
      // This does not return: the application restarts into the new version.
      await unwrap(commands.installUpdate());
    } catch (e) {
      setInstalling(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <div className="card">
      <p className="label">Updates</p>

      <div className="button-row">
        <button onClick={check} disabled={checking || installing}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
        {available && (
          <button onClick={install} disabled={installing}>
            {installing ? "Installing…" : `Install ${available.version}`}
          </button>
        )}
      </div>

      {upToDate && <p className="label">This is the newest version.</p>}

      {available && (
        <dl>
          <dt>Installed</dt>
          <dd>{available.currentVersion}</dd>
          <dt>Available</dt>
          <dd>{available.version}</dd>
          {available.publishedAt && (
            <>
              <dt>Published</dt>
              <dd>{available.publishedAt}</dd>
            </>
          )}
        </dl>
      )}

      {available?.notes && <pre className="error">{available.notes}</pre>}

      {error && <pre className="error">{error}</pre>}

      {installing && (
        <p className="label">
          The engine is stopped first, then the application restarts on its own.
        </p>
      )}
    </div>
  );
}
