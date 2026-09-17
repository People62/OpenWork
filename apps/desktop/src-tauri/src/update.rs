// Automatic updates.
//
// The updater has its own signing key, generated locally with
// `tauri signer generate`, and it is not an operating-system code-signing
// certificate. Those are separate things: this key proves an update came from
// this repository, and costs nothing. OS signing is what stops SmartScreen and
// Gatekeeper complaining, and this project deliberately goes without it.
//
// An installed application only accepts updates signed by the matching private
// key. If that key is lost, no update can ever reach the installations already
// out there — they would have to be replaced by hand. It lives in this
// repository's GitHub Secrets.
//
// Checking is never automatic and never silent. The interface asks, and the
// interface decides what to do with the answer: an update that installs itself
// while someone is mid-conversation with the engine is a worse outcome than one
// that waits.

use serde::Serialize;
use specta::Type;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAvailable {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

/// Asks the endpoint whether there is a newer version. `None` means this is the
/// newest.
///
/// A failure here is ordinary, not exceptional: the machine may be offline, or
/// GitHub may be unreachable. The message is returned as-is so the interface can
/// say what actually happened rather than "update check failed".
#[tauri::command]
#[specta::specta]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateAvailable>, String> {
    let updater = app
        .updater()
        .map_err(|e| format!("the updater is not configured: {e}"))?;

    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateAvailable {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
            published_at: update.date.map(|d| d.to_string()),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(format!("checking for an update failed: {e}")),
    }
}

/// Downloads and installs the update, then relaunches.
///
/// The engine is stopped first, deliberately. Replacing the application's files
/// while a child process is running out of them is how an update leaves a
/// half-broken installation behind — and on Windows a running child can hold a
/// file lock that makes the replacement fail outright.
#[tauri::command]
#[specta::specta]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|e| format!("the updater is not configured: {e}"))?;

    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("checking for an update failed: {e}"))?
    else {
        return Err("there is no update to install".into());
    };

    {
        use tauri::Manager;
        let engine = app.state::<crate::engine::Engine>();
        engine
            .stop()
            .await
            .map_err(|e| format!("could not stop the engine before updating: {e}"))?;
    }

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("installing the update failed: {e}"))?;

    // download_and_install restarts the application on some platforms and not
    // others; restarting here makes the behaviour the same everywhere.
    app.restart();
}
