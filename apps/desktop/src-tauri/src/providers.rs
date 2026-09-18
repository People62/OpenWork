// Provider credentials: which services can supply models, and the keys that let
// them.
//
// This is the difference between an application that can hold a conversation and
// one that cannot. The engine reads its credentials from OpenCode's own store,
// written by `opencode auth login` — so on a machine where that was never run
// there is nothing but OpenCode's free tier, and the free tier refuses to be
// used outside the OpenCode application. The first turn fails with nothing on
// screen to explain why.
//
// Keys go to the engine, never to a file of ours. The engine owns `auth.json`
// and has it open; writing it from here would race whatever else is holding it.

use tauri::{AppHandle, State};

use crate::engine::client::{Client, Providers};
use crate::engine::{Engine, EngineError, EngineStatus};

/// The catalogue, and which of it is usable.
///
/// The reply carries no keys. `GET /provider` sends them in plain text, and the
/// type this deserialises into simply has no field for one — see `Provider` in
/// `engine::client`.
#[tauri::command]
#[specta::specta]
pub async fn list_providers(engine: State<'_, Engine>) -> Result<Providers, EngineError> {
    let client = Client::new(engine.address().await?);
    Ok(client.list_providers().await?)
}

/// Stores an API key for a provider, then restarts the engine.
///
/// The restart is not housekeeping. The engine works out its providers and
/// models at startup and never again: measured, removing a provider's
/// credentials from a running engine left every one of its models still listed.
/// Without the restart, a key that was just added would connect nothing that the
/// model picker could see.
///
/// `key` is never logged, never returned, and never stored on this side. It
/// exists in memory long enough to be handed to the engine.
#[tauri::command]
#[specta::specta]
pub async fn connect_provider(
    provider_id: String,
    key: String,
    app: AppHandle,
    engine: State<'_, Engine>,
) -> Result<EngineStatus, EngineError> {
    let client = Client::new(engine.address().await?);
    client.set_provider_key(&provider_id, &key).await?;
    drop(key);
    Ok(engine
        .restart(crate::app_resource_dir(&app).as_deref())
        .await?)
}

/// Removes a provider's key, then restarts for the same reason.
#[tauri::command]
#[specta::specta]
pub async fn disconnect_provider(
    provider_id: String,
    app: AppHandle,
    engine: State<'_, Engine>,
) -> Result<EngineStatus, EngineError> {
    let client = Client::new(engine.address().await?);
    client.remove_provider_key(&provider_id).await?;
    Ok(engine
        .restart(crate::app_resource_dir(&app).as_deref())
        .await?)
}
