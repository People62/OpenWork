// The conversation boundary: start the engine, send a prompt, stream tokens to
// the screen, and stop it mid-flight.
//
// Tokens are not returned as a command's value — they flow as Tauri events.
// `invoke()` is request-response; a token stream is not.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;
use tokio::sync::Mutex;

use crate::engine::client::{Chunk, Client, Model};
use crate::engine::{Engine, EngineError, EngineStatus};

/// Emitted when the stream stops — finished on its own, cancelled, or failed.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub engine_session_id: String,
    pub cancelled: bool,
    pub error: Option<String>,
}

/// The stream currently running, along with its cancel switch.
#[derive(Default)]
pub struct Conversation {
    cancel: Arc<Mutex<Option<tokio::sync::watch::Sender<bool>>>>,
}

#[tauri::command]
#[specta::specta]
pub async fn engine_status(engine: State<'_, Engine>) -> Result<EngineStatus, EngineError> {
    Ok(engine.status().await)
}

#[tauri::command]
#[specta::specta]
pub async fn start_engine(
    working_dir: String,
    app: AppHandle,
    engine: State<'_, Engine>,
) -> Result<EngineStatus, EngineError> {
    let dir = PathBuf::from(working_dir);
    let app_dir = app_resource_dir(&app);
    Ok(engine.start(&dir, app_dir.as_deref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn stop_engine(engine: State<'_, Engine>) -> Result<EngineStatus, EngineError> {
    engine.stop().await?;
    Ok(engine.status().await)
}

/// The models actually available on the running engine.
///
/// These must be asked for, not guessed: provider availability depends on the
/// engine's working directory. The same folder can offer dozens of models or
/// none, depending on whether OpenCode recognises it as a project.
#[tauri::command]
#[specta::specta]
pub async fn list_models(engine: State<'_, Engine>) -> Result<Vec<Model>, EngineError> {
    let client = Client::new(engine.address().await?);
    Ok(client.list_models().await?)
}

/// Creates an engine session with its model fixed on the session.
///
/// The model must not simply be left out in real use: a session without one
/// falls back to the engine's default, and if that default cannot be used, the
/// failure never appears on the event stream at all — only in the engine's log.
/// The interface would appear to hang for no reason.
#[tauri::command]
#[specta::specta]
pub async fn create_engine_session(
    model: Option<Model>,
    engine: State<'_, Engine>,
) -> Result<String, EngineError> {
    let client = Client::new(engine.address().await?);
    Ok(client.create_session(model.as_ref()).await?.id)
}

/// Sends a prompt, then streams the answer out as events. This command returns
/// immediately; the stream runs in the background until it finishes or is
/// stopped.
#[tauri::command]
#[specta::specta]
pub async fn send_prompt(
    engine_session_id: String,
    text: String,
    app: AppHandle,
    engine: State<'_, Engine>,
    conversation: State<'_, Conversation>,
) -> Result<(), EngineError> {
    let client = Client::new(engine.address().await?);

    // Any previous stream is stopped first. Two streams over the same session
    // would double every token on screen.
    let (send_cancel, receive_cancel) = tokio::sync::watch::channel(false);
    if let Some(previous) = conversation.cancel.lock().await.replace(send_cancel) {
        let _ = previous.send(true);
    }

    let stream_client = client.clone();
    let stream_app = app.clone();
    let stream_session = engine_session_id.clone();

    tokio::spawn(async move {
        let emitter = stream_app.clone();
        let result = stream_client
            .stream(
                &stream_session,
                receive_cancel.clone(),
                move |chunk: Chunk| {
                    let _ = chunk.emit(&emitter);
                },
            )
            .await;

        let _ = Finished {
            engine_session_id: stream_session,
            cancelled: *receive_cancel.borrow(),
            error: result.err().map(|e| e.to_string()),
        }
        .emit(&stream_app);
    });

    Ok(client.send_prompt(&engine_session_id, &text).await?)
}

/// Stops a conversation mid-flight — the engine side through `interrupt`, our
/// side by closing the stream. Both are needed: closing the stream alone leaves
/// the engine generating tokens into the void.
#[tauri::command]
#[specta::specta]
pub async fn stop_conversation(
    engine_session_id: String,
    engine: State<'_, Engine>,
    conversation: State<'_, Conversation>,
) -> Result<(), EngineError> {
    if let Some(switch) = conversation.cancel.lock().await.take() {
        let _ = switch.send(true);
    }

    let client = Client::new(engine.address().await?);
    Ok(client.interrupt(&engine_session_id).await?)
}

/// The directory the application binary lives in — where the sidecar sits once
/// the application is packaged.
fn app_resource_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .or_else(|| std::env::current_exe().ok()?.parent().map(PathBuf::from))
}
