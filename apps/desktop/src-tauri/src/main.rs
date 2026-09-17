// Rantai — the desktop shell and its local backend, one Rust process.
//
// Tauri *is* a Rust program; this is not a shell with a backend attached from
// outside. The local backend lives in the files next to this one, and the
// interface calls it through `invoke()` — with no HTTP loopback, no dynamic
// port, no CORS and no token.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;
mod conversation;
mod db;
mod deeplink;
mod domain;
mod engine;
mod error;
mod shell;
mod smoke;
mod update;

use serde::Serialize;
use specta::Type;
use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder};

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Greeting {
    message: String,
    platform: String,
    arch: String,
    tauri_version: String,
    app_version: String,
}

/// The first command, from Phase 0. It survives because smoke mode uses it to
/// prove the IPC round-trip before anything touches the database.
#[tauri::command]
#[specta::specta]
fn hello(name: String) -> Greeting {
    Greeting {
        message: format!("Hello from Rust, {name}."),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// The single place every command is registered. Used twice: by the application
/// when it runs, and by the test that writes `bindings.ts`. Because both read
/// the same list, the types on screen cannot drift from the types in Rust
/// without something failing.
fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            hello,
            smoke::report_signal,
            smoke::smoke_expectations,
            commands::create_workspace,
            commands::list_workspaces,
            commands::create_session,
            commands::list_sessions,
            commands::add_message,
            commands::list_messages,
            commands::check_database,
            conversation::engine_status,
            conversation::start_engine,
            conversation::stop_engine,
            conversation::list_models,
            conversation::create_engine_session,
            conversation::send_prompt,
            conversation::stop_conversation,
            deeplink::deep_link_status,
            deeplink::register_deep_link,
            deeplink::open_in_browser,
            deeplink::launch_links,
            update::check_for_update,
            update::install_update,
        ])
        // Events carry into bindings.ts too, listeners and all.
        .events(collect_events![
            engine::client::Chunk,
            conversation::Finished,
            deeplink::DeepLink
        ])
}

fn main() {
    let builder = builder();

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(smoke::Board::default())
        .manage(engine::Engine::default())
        .manage(conversation::Conversation::default())
        .manage(deeplink::LaunchLinks::default())
        .invoke_handler(builder.invoke_handler())
        // When a signal never arrives, the first question is always the same:
        // did the page load, and from what address. Without this trace, a smoke
        // failure looks like total silence.
        .on_page_load(|window, payload| {
            if smoke::enabled() {
                eprintln!(
                    "smoke: page {:?} at {} ({})",
                    payload.event(),
                    payload.url(),
                    window.label()
                );
            }
        })
        .setup(move |app| {
            builder.mount_events(app);
            deeplink::install(app.handle());

            // The menu is not decoration: on macOS a webview gets no clipboard
            // at all unless the application supplies menu items carrying those
            // roles. Its absence looks like a bug in the text boxes.
            app.set_menu(shell::build_menu(app.handle())?)?;

            // Smoke mode exits on its own schedule and never sees a user, so a
            // tray icon there is noise — and on a headless CI runner it is one
            // more thing that can fail for reasons that have nothing to do with
            // what is being tested.
            if !smoke::enabled() {
                shell::build_tray(app.handle())?;
            }

            let data_dir = app
                .path()
                .app_data_dir()
                .expect("there is no application data directory");
            let path = db::default_path(data_dir);

            match db::open(&path) {
                Ok(db) => {
                    app.manage(db);
                }
                Err(e) => {
                    // Print the whole chain. A database that fails to open makes
                    // every later command fail for a reason that sounds like
                    // something else.
                    eprintln!("could not open the database at {}: {e}", path.display());
                    return Err(Box::new(e));
                }
            }

            if smoke::enabled() {
                eprintln!("smoke: database at {}", path.display());
                smoke::watch(app.handle().clone());
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build the Tauri application")
        // Closing the window does not automatically stop the child process:
        // `kill_on_drop` only covers the normal drop path, and not every exit
        // goes through it. The Phase 2 gate asks for no orphaned processes, so
        // the shutdown happens here, on the exit path that is always taken.
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let engine = handle.state::<engine::Engine>();
                if let Err(e) = tauri::async_runtime::block_on(engine.stop()) {
                    eprintln!("could not stop the engine on exit: {e}");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use specta_typescript::Typescript;

    /// Where `bindings.ts` lands, relative to src-tauri.
    const BINDINGS_PATH: &str = "../../ui/app/bindings.ts";

    /// This is the Phase 1 gate. The test rewrites `bindings.ts` from the command
    /// list in Rust; CI runs it and then demands a clean `git diff`. So changing
    /// the shape of the data in Rust without updating that file fails CI, and
    /// updating it raises type errors in Next.js until the callers follow.
    #[test]
    fn bindings_are_current() {
        builder()
            .export(
                Typescript::default().header("// Generated from Rust. Do not edit by hand.\n"),
                BINDINGS_PATH,
            )
            .expect("could not write bindings.ts");
    }
}
