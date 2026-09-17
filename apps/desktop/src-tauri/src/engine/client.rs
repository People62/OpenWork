// The part of @opencode-ai/sdk we use, rewritten against its HTTP API.
//
// The real SDK is far wider than this. Only what the Release 1 backbone demands
// is rewritten: create a session, send a prompt, stream tokens, and stop it
// mid-flight. The rest follows if it is actually needed — not now, and not
// because the SDK happens to have it.
//
// The endpoints come from running OpenCode v1.18.18 and reading its /doc, and
// the event shapes from capturing a real stream. Reading the schema alone was
// not enough: four things here were wrong in the first version and every one of
// them looked right on the page.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use specta::Type;

use super::EngineFailure;

fn to_failure(e: reqwest::Error) -> EngineFailure {
    // Print the whole chain. reqwest hides the real cause in `source`, and
    // without this the message is often just "error sending request".
    let mut message = e.to_string();
    let mut cause: &dyn std::error::Error = &e;
    while let Some(inner) = std::error::Error::source(cause) {
        message.push_str(&format!(" -> {inner}"));
        cause = inner;
    }
    EngineFailure::Http(message)
}

#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    address: String,
}

/// Nearly every OpenCode response is wrapped in `{"data": ...}`. The first
/// version of this client parsed the body directly and failed on its very first
/// call — found by calling the API, not by reading its schema.
#[derive(Debug, Deserialize)]
struct Envelope<T> {
    data: T,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineSession {
    pub id: String,
}

/// A model that is actually available, as reported by the engine.
///
/// It must be asked for, never guessed: provider availability depends on the
/// engine's working directory. The same folder can offer dozens of models or
/// none, depending on whether OpenCode recognises it as a project.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
}

#[derive(Debug, Serialize)]
struct PromptBody<'a> {
    prompt: PromptText<'a>,
}

#[derive(Debug, Serialize)]
struct PromptText<'a> {
    text: &'a str,
}

/// One piece flowing from the engine to the screen.
///
/// It is an event, not a return value — `invoke()` is request-response, and a
/// token stream is not. Deriving `Event` carries the type into `bindings.ts`
/// along with its listener, so the "never write a type twice" rule holds for
/// events as well as commands.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    /// Empty for events that belong to no session — the global stream also
    /// carries `plugin.added`, `catalog.updated` and the like.
    pub engine_session_id: Option<String>,
    /// The event name exactly as the engine gave it. Not translated here —
    /// translating means guessing, and OpenCode's event shapes change between
    /// versions.
    pub kind: String,
    /// The raw event payload, as JSON.
    ///
    /// Deliberately exported as `unknown` rather than modelled. The shape of an
    /// OpenCode event is decided by OpenCode and changes between versions;
    /// writing it down here would promise a contract we do not control, and that
    /// promise would quietly break on the next engine update. The interface
    /// narrows it where it is actually used.
    #[specta(type = specta_typescript::Unknown)]
    pub payload: serde_json::Value,
}

impl Client {
    pub fn new(address: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            address: address.into(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.address.trim_end_matches('/'), path)
    }

    /// A health probe. Used after the process announces its address, because
    /// "listening" and "ready to serve" are not the same thing.
    pub async fn healthy(&self) -> Result<bool, EngineFailure> {
        let response = self
            .http
            .get(self.url("/api/health"))
            .send()
            .await
            .map_err(to_failure)?;
        Ok(response.status().is_success())
    }

    pub async fn list_models(&self) -> Result<Vec<Model>, EngineFailure> {
        let response = self
            .http
            .get(self.url("/api/model"))
            .send()
            .await
            .map_err(to_failure)?;

        let status = response.status();
        let body = response.text().await.map_err(to_failure)?;
        if !status.is_success() {
            return Err(EngineFailure::Http(format!(
                "listing models failed ({status}): {body}"
            )));
        }

        serde_json::from_str::<Envelope<Vec<Model>>>(&body)
            .map(|e| e.data)
            .map_err(|e| EngineFailure::Http(format!("model list unreadable: {e}; body: {body}")))
    }

    /// Creates a session with its model fixed on the session itself.
    ///
    /// The model **must** be set here. The `/prompt` schema has no model field at
    /// all — slipping one in is silently ignored, and the session falls back to
    /// the engine's default. On the test machine that default is OpenCode's free
    /// tier, which refuses to be used outside the OpenCode application, and the
    /// refusal shows up as a baffling `step.failed`.
    pub async fn create_session(
        &self,
        model: Option<&Model>,
    ) -> Result<EngineSession, EngineFailure> {
        let body = match model {
            Some(m) => serde_json::json!({
                "model": { "providerID": m.provider_id, "id": m.id }
            }),
            None => serde_json::json!({}),
        };

        let response = self
            .http
            .post(self.url("/api/session"))
            .json(&body)
            .send()
            .await
            .map_err(to_failure)?;

        let status = response.status();
        let text = response.text().await.map_err(to_failure)?;
        if !status.is_success() {
            return Err(EngineFailure::Http(format!(
                "creating a session failed ({status}): {text}"
            )));
        }

        serde_json::from_str::<Envelope<EngineSession>>(&text)
            .map(|e| e.data)
            .map_err(|e| {
                EngineFailure::Http(format!("session reply unreadable: {e}; body: {text}"))
            })
    }

    pub async fn send_prompt(
        &self,
        engine_session_id: &str,
        text: &str,
    ) -> Result<(), EngineFailure> {
        let response = self
            .http
            .post(self.url(&format!("/api/session/{engine_session_id}/prompt")))
            .json(&PromptBody {
                prompt: PromptText { text },
            })
            .send()
            .await
            .map_err(to_failure)?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(EngineFailure::Http(format!(
                "prompt rejected ({status}): {body}"
            )));
        }
        Ok(())
    }

    /// This is what closes the Phase 2 gate: a conversation has to be stoppable
    /// mid-flight.
    pub async fn interrupt(&self, engine_session_id: &str) -> Result<(), EngineFailure> {
        let response = self
            .http
            .post(self.url(&format!("/api/session/{engine_session_id}/interrupt")))
            .send()
            .await
            .map_err(to_failure)?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(EngineFailure::Http(format!(
                "interrupting the session failed ({status}): {body}"
            )));
        }
        Ok(())
    }

    /// Opens the event stream and calls `on_chunk` for every event belonging to
    /// this session, until the turn ends or `cancel` goes true.
    ///
    /// **Uses the global `/api/event`, not `/api/session/{id}/event`.** Both
    /// exist, and the difference only shows up when you run them: the per-session
    /// stream is durable and coarse — it sends `text.started` and `text.ended`
    /// with not one token in between. The global stream is what carries
    /// `session.next.text.delta`. One real conversation produced 8 events on the
    /// per-session stream and 63 on the global one.
    ///
    /// The cost: events from other sessions come through too, so they are
    /// filtered here.
    ///
    /// SSE is parsed by hand rather than with a library: it is only two kinds of
    /// line, and another dependency is not worth it.
    pub async fn stream<F>(
        &self,
        engine_session_id: &str,
        cancel: tokio::sync::watch::Receiver<bool>,
        mut on_chunk: F,
    ) -> Result<(), EngineFailure>
    where
        F: FnMut(Chunk),
    {
        let response = self
            .http
            .get(self.url("/api/event"))
            .send()
            .await
            .map_err(to_failure)?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(EngineFailure::Http(format!(
                "event stream rejected ({status}): {body}"
            )));
        }

        let mut body = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(bytes) = body.next().await {
            if *cancel.borrow() {
                break;
            }
            let bytes = bytes.map_err(to_failure)?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            // SSE events are separated by a blank line, and a single network
            // chunk almost never holds exactly one event.
            while let Some(boundary) = buffer.find("\n\n") {
                let block: String = buffer.drain(..boundary + 2).collect();
                let Some(chunk) = parse_event(&block) else {
                    continue;
                };
                if chunk.engine_session_id.as_deref() != Some(engine_session_id) {
                    continue;
                }
                let is_end = chunk.kind == TURN_END;
                on_chunk(chunk);
                if is_end {
                    return Ok(());
                }
            }
        }

        Ok(())
    }
}

/// The event that marks the end of a turn.
///
/// A turn with tool calls can have several steps; for Release 1, which only needs
/// one plain conversation, the first step that ends means done. This has to be
/// revisited as soon as tools arrive.
const TURN_END: &str = "session.next.step.ended";

/// Parses one SSE block.
///
/// OpenCode **sends no `event:` lines at all** — only `data:`, with the event
/// kind inside the JSON as a `type` field. The first version of this parser read
/// `event:` lines and therefore labelled every event "message". Found by
/// capturing the stream, not by reading the schema.
fn parse_event(block: &str) -> Option<Chunk> {
    let mut data = String::new();

    for line in block.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim_start());
        }
    }

    if data.is_empty() {
        return None;
    }

    let parsed: serde_json::Value = serde_json::from_str(&data).ok()?;

    let kind = parsed
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("untyped")
        .to_string();

    let payload = parsed.get("data").cloned().unwrap_or(parsed.clone());

    let engine_session_id = payload
        .get("sessionID")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());

    Some(Chunk {
        engine_session_id,
        kind,
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This block is copied verbatim from a real OpenCode v1.18.18 stream — not
    /// invented from the schema. The first version of this test used an invented
    /// shape with `event:` lines, and passed happily while the code it tested
    /// would never have worked against the real engine.
    const REAL_BLOCK: &str = r#"data: {"id":"evt_1","type":"session.next.text.delta","durable":{"aggregateID":"ses_abc","seq":7,"version":1},"data":{"timestamp":1789548855918,"sessionID":"ses_abc","text":"ha"}}

"#;

    #[test]
    fn kind_comes_from_inside_the_json_not_an_event_line() {
        let c = parse_event(REAL_BLOCK).expect("should parse");
        assert_eq!(c.kind, "session.next.text.delta");
        assert_eq!(c.engine_session_id.as_deref(), Some("ses_abc"));
        assert_eq!(c.payload["text"], "ha");
    }

    #[test]
    fn an_event_without_a_session_still_parses_but_has_no_owner() {
        // The global stream carries things like this too, and they have to be
        // filtered by the caller — not quietly attributed to the active session.
        let block = r#"data: {"id":"evt_2","type":"plugin.added","data":{"name":"something"}}

"#;
        let c = parse_event(block).expect("should parse");
        assert_eq!(c.kind, "plugin.added");
        assert_eq!(c.engine_session_id, None);
    }

    #[test]
    fn multi_line_data_is_joined() {
        let block = "data: {\"type\":\"x\",\ndata: \"data\":{\"sessionID\":\"ses_1\"}}\n\n";
        let c = parse_event(block).expect("should parse");
        assert_eq!(c.kind, "x");
        assert_eq!(c.engine_session_id.as_deref(), Some("ses_1"));
    }

    #[test]
    fn a_block_without_data_is_ignored() {
        assert!(parse_event(": keep-alive\n\n").is_none());
    }

    #[test]
    fn data_that_is_not_json_is_ignored() {
        // It used to be kept as text and reached the interface as a bogus,
        // kindless event.
        assert!(parse_event("data: not json\n\n").is_none());
    }

    #[test]
    fn the_turn_ends_on_step_ended() {
        let block = r#"data: {"type":"session.next.step.ended","data":{"sessionID":"ses_abc"}}

"#;
        let c = parse_event(block).expect("should parse");
        assert_eq!(c.kind, TURN_END);
    }
}
