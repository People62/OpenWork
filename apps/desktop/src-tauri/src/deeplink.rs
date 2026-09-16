// The two native touches the Den sign-in needs, and no more.
//
// Everything else in the Den sign-in is TypeScript that moves across unchanged.
// Only these two cannot: receiving `openwork://den-auth` from the system, and
// opening the system browser.
//
// They were built first in Phase 3 on purpose. URL scheme registration behaves
// differently on every operating system, is at its most fragile in development
// mode, and **was never covered by CI in Rantai at all** — the three green
// signals there only exercised the webview, React, the bridge, and IPC. So this
// is the highest-uncertainty part of the whole phase, and the last thing that
// should be discovered broken at the end.
//
// There is a manual paste fallback — pure TypeScript, zero native — for when
// deep links misbehave on some platform.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;

/// The scheme we register. The same one OpenWork uses, so links already in
/// circulation keep working.
pub const SCHEME: &str = "openwork";

/// Arrives when the system hands `openwork://…` to the application.
///
/// Sent as a typed event rather than a `CustomEvent` through `webview.eval` the
/// way the Rantai spike did. That spike had to imitate Electron's event shape
/// because its interface had not changed; here there is nothing to imitate, and
/// a typed event carries into `bindings.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct DeepLink {
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkStatus {
    pub scheme: String,
    /// Whether the system really does hand this scheme to us. Asked of the
    /// system, not assumed from a successful registration.
    pub registered: bool,
    /// Set when the system refuses to answer — in some environments (a headless
    /// CI runner, say) the question itself fails, and that is not the same thing
    /// as "not registered".
    pub error: Option<String>,
}

/// Links that *launched* the application.
///
/// They arrive in `setup`, long before the page has loaded and the React
/// listener is attached — so if they were only sent as an event, they would
/// vanish without trace. And this is the commonest case of all for a sign-in:
/// the user clicks a link in the browser while the application is not running.
///
/// Found by running the application with a link as an argument and reading the
/// order of its traces: "deep link received" printed before "page Finished".
///
/// **Read, not drained.** The first fix drained them, and two readers — the Den
/// panel and the smoke check — raced, so one of them always got an empty list.
/// Launch links are a fixed fact about this run of the application, so reading
/// them repeatedly is exactly right. Links that arrive later are sent as events
/// only.
#[derive(Default)]
pub struct LaunchLinks {
    urls: Mutex<Vec<String>>,
}

#[tauri::command]
#[specta::specta]
pub fn launch_links(links: State<'_, LaunchLinks>) -> Vec<String> {
    links.urls.lock().expect("launch links poisoned").clone()
}

#[tauri::command]
#[specta::specta]
pub fn deep_link_status(app: AppHandle) -> DeepLinkStatus {
    use tauri_plugin_deep_link::DeepLinkExt;

    match app.deep_link().is_registered(SCHEME) {
        Ok(registered) => DeepLinkStatus {
            scheme: SCHEME.to_string(),
            registered,
            error: None,
        },
        Err(e) => DeepLinkStatus {
            scheme: SCHEME.to_string(),
            registered: false,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
#[specta::specta]
pub fn register_deep_link(app: AppHandle) -> Result<DeepLinkStatus, String> {
    use tauri_plugin_deep_link::DeepLinkExt;

    app.deep_link()
        .register(SCHEME)
        .map_err(|e| format!("could not register the {SCHEME}:// scheme: {e}"))?;
    Ok(deep_link_status(app))
}

/// Opens the system browser. The second native touch, and the only other one.
///
/// The Den sign-in sends the user to a web page, then waits for them to come back
/// through a deep link. Opening it inside the application's webview will not do:
/// the session and cookies there are not the user's browser session.
#[tauri::command]
#[specta::specta]
pub fn open_in_browser(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    // http and https only. Without this guard, a URL arriving from Den could
    // tell the system to open anything at all.
    let parsed = url::Url::parse(&url).map_err(|e| format!("invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "refusing to open the {} scheme; http and https only",
            parsed.scheme()
        ));
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("could not open the browser: {e}"))
}

/// Wires deep link delivery to the typed event.
pub fn install(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // The link that triggered the launch is recorded as a fact, then still sent
    // as an event for an interface that happens to be ready already.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        let urls: Vec<String> = urls.into_iter().map(|u| u.to_string()).collect();
        if !urls.is_empty() {
            app.state::<LaunchLinks>()
                .urls
                .lock()
                .expect("launch links poisoned")
                .extend(urls.iter().cloned());
        }
        dispatch(app, urls);
    }

    let receiver = app.clone();
    app.deep_link().on_open_url(move |event| {
        let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
        dispatch(&receiver, urls);
    });
}

fn dispatch(app: &AppHandle, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    if crate::smoke::enabled() {
        // Deep links are the most fragile and least observed part of the sign-in.
        // If one does not arrive, this trace is what distinguishes "the system
        // never handed it over" from "it arrived but was not recognised".
        eprintln!("smoke: deep link received: {urls:?}");
    }
    if app.get_webview_window("main").is_none() {
        eprintln!("a deep link arrived before the window existed: {urls:?}");
    }
    if let Err(e) = (DeepLink { urls }).emit(app) {
        eprintln!("could not emit the deep link event: {e}");
    }
}
