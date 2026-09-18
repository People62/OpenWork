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

/// A session as the engine reports it.
///
/// Rantai keeps no session table of its own. OpenCode already stores every one
/// of these fields — title, model, cost, tokens, times — in its own SQLite, and
/// it is the copy the model reads as context for the next turn. A second copy
/// on our side would be the one on screen while the engine answered from the
/// other, and the two would part company the first time a stream broke.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineSession {
    pub id: String,
    /// The engine names a new session itself and renames it once there is
    /// something to name it after, so this changes under us. It is read, never
    /// written.
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub model: Option<Model>,
    pub time: SessionTime,
    #[serde(default)]
    pub location: Option<SessionLocation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionTime {
    #[specta(type = specta_typescript::Number)]
    pub created: i64,
    #[specta(type = specta_typescript::Number)]
    pub updated: i64,
}

/// Which folder the session belongs to. This is how a session is tied to a
/// workspace: there is no id linking them, only the path.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionLocation {
    #[serde(default)]
    pub directory: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MessageTime {
    #[specta(type = specta_typescript::Number)]
    pub created: i64,
    #[specta(type = Option<specta_typescript::Number>)]
    #[serde(default)]
    pub completed: Option<i64>,
}

/// One message in a conversation, as the interface sees it.
///
/// Built from the engine's `{info, parts}` pair rather than deserialised
/// straight into, so the interface keeps one flat shape and this file is the
/// only place that knows the engine nests it. A user message carries its prose
/// as `text`; an assistant message carries typed parts in `content`.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    /// `"user"` or `"assistant"`. Not an enum: the engine decides what kinds
    /// exist, and a value we have not met should not fail the whole list.
    #[serde(rename = "type")]
    pub role: String,
    pub time: MessageTime,
    /// The prose of a user message.
    pub text: Option<String>,
    /// Every part, in order. For a user message the prose is in `text` as well.
    pub content: Vec<Part>,
    /// The model this message was sent to, or answered by. It can differ from
    /// turn to turn: a conversation is not fixed to one model.
    pub model: Option<Model>,
    /// `"stop"`, `"tool-calls"`, and whatever else the engine reports.
    pub finish: Option<String>,
    /// Set when the turn failed or was stopped — `MessageAbortedError` for a
    /// turn someone pressed Stop on.
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub error: Option<serde_json::Value>,
}

/// What `GET /session/{id}/message` actually sends: one of these per message.
#[derive(Debug, Deserialize)]
struct WireMessage {
    info: WireInfo,
    #[serde(default)]
    parts: Vec<Part>,
}

#[derive(Debug, Deserialize)]
struct WireInfo {
    id: String,
    role: String,
    time: MessageTime,
    #[serde(default)]
    finish: Option<String>,
    #[serde(default)]
    error: Option<serde_json::Value>,
    /// An assistant message names its model flat, as two fields…
    #[serde(default, rename = "providerID")]
    provider_id: Option<String>,
    #[serde(default, rename = "modelID")]
    model_id: Option<String>,
    /// …and a user message names it as an object. Same engine, two shapes.
    #[serde(default)]
    model: Option<WireModel>,
}

#[derive(Debug, Deserialize)]
struct WireModel {
    #[serde(rename = "providerID")]
    provider_id: String,
    #[serde(rename = "modelID")]
    model_id: String,
}

impl From<WireMessage> for Message {
    fn from(wire: WireMessage) -> Self {
        let WireMessage { info, parts } = wire;
        let model = match (info.provider_id, info.model_id, info.model) {
            (Some(provider_id), Some(id), _) => Some(Model { provider_id, id }),
            (_, _, Some(m)) => Some(Model {
                provider_id: m.provider_id,
                id: m.model_id,
            }),
            _ => None,
        };
        let text = (info.role == "user").then(|| {
            parts
                .iter()
                .filter_map(|p| match p {
                    Part::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        });
        Message {
            id: info.id,
            role: info.role,
            time: info.time,
            text,
            content: parts,
            model,
            finish: info.finish,
            error: info.error,
        }
    }
}

/// A piece of an assistant message.
///
/// `Other` is load-bearing. The engine's storage holds `step-start` and
/// `step-finish` alongside these, and will hold kinds that do not exist yet —
/// an enum without a catch-all would fail to parse the whole conversation the
/// first time one appeared.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Part {
    Text {
        #[serde(default)]
        text: String,
    },
    Reasoning {
        #[serde(default)]
        text: String,
    },
    Tool {
        tool: String,
        #[serde(rename = "callID")]
        call_id: String,
        state: ToolState,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolState {
    /// `"pending"`, `"running"`, `"completed"`, `"error"`.
    pub status: String,
    #[serde(default)]
    pub title: Option<String>,
    /// Left as JSON: every tool has its own argument shape, and writing them
    /// down here would promise a contract the tools own, not us.
    #[specta(type = Option<specta_typescript::Unknown>)]
    #[serde(default)]
    pub input: Option<serde_json::Value>,
    #[serde(default)]
    pub output: Option<String>,
}

/// A provider in the engine's catalogue.
///
/// **There is deliberately no `key` field, and one must never be added.**
/// `GET /provider` returns the API key in plain text for every provider that has
/// one. serde drops fields we do not declare, so the key stops here — it never
/// reaches `bindings.ts`, the screen, a log line, or an error message. Declaring
/// it "for completeness" would put a live credential on all four.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// The environment variables this provider would read a key from. Shown so
    /// someone who would rather not paste a key into an application can see
    /// which variable to set instead.
    #[serde(default)]
    pub env: Vec<String>,
}

// There is no model count here on purpose. Carrying one meant reading the
// engine's `models`, whose shape is a list for some providers and an object for
// others, and folding it to a number — which makes the type read one way going
// out and another coming in. specta refuses that, and it is right to: the
// generated TypeScript would describe a shape nothing actually sends. What the
// screen needs is answered by `connected` anyway.

/// The catalogue, and which of it can actually be used.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Providers {
    pub all: Vec<Provider>,
    /// Provider ids the engine considers usable right now. This is the engine's
    /// own answer, not ours — a provider can be connected through a key we
    /// stored, through an environment variable, or by needing nothing at all.
    pub connected: Vec<String>,
}

/// `/provider` as the model list needs it. Separate from `Providers` because it
/// reads `models`, which that type deliberately does not carry.
///
/// Like `Provider`, it has no field for a key, so the credential in the same
/// response is dropped on arrival.
#[derive(Debug, Deserialize)]
struct WireCatalogue {
    all: Vec<WireCatalogueEntry>,
    connected: Vec<String>,
    /// The engine's own pick per provider, by provider id.
    #[serde(default)]
    default: std::collections::HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct WireCatalogueEntry {
    id: String,
    #[serde(default)]
    models: serde_json::Value,
}

/// The provider the free tier belongs to. See `Client::list_models`.
const FREE_TIER_PROVIDER: &str = "opencode";

impl WireCatalogue {
    fn usable_models(self) -> Vec<Model> {
        let mut connected = self.connected;
        // Stable, so every other provider keeps the engine's own order.
        connected.sort_by_key(|id| id == FREE_TIER_PROVIDER);

        let mut out = Vec::new();
        for provider_id in connected {
            let Some(entry) = self.all.iter().find(|p| p.id == provider_id) else {
                continue;
            };
            // An object keyed by model id is what the engine sends. A list is
            // accepted too rather than failing the whole picker over it.
            let mut ids: Vec<String> = match &entry.models {
                serde_json::Value::Object(map) => map.keys().cloned().collect(),
                serde_json::Value::Array(items) => items
                    .iter()
                    .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(str::to_owned))
                    .collect(),
                _ => Vec::new(),
            };
            // The object arrives sorted by name, not in the engine's order — no
            // `preserve_order` on serde_json here, and adding a feature to save
            // an ordering is not worth it. The engine's own default goes first
            // instead, which is the order that actually matters: it is what a
            // new session picks when nothing has been chosen.
            if let Some(preferred) = self.default.get(&provider_id) {
                if let Some(at) = ids.iter().position(|id| id == preferred) {
                    let chosen = ids.remove(at);
                    ids.insert(0, chosen);
                }
            }
            out.extend(ids.into_iter().map(|id| Model {
                provider_id: provider_id.clone(),
                id,
            }));
        }
        out
    }
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

/// The body of `POST /session/{id}/prompt_async`.
#[derive(Debug, Serialize)]
struct PromptBody<'a> {
    parts: [PromptPart<'a>; 1],
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<PromptModel<'a>>,
}

#[derive(Debug, Serialize)]
struct PromptPart<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    text: &'a str,
}

/// `modelID` here, where `Model` everywhere else says `id`. The engine refuses
/// extra fields on this object, so sending our own shape is a 400, not a
/// silently ignored key.
#[derive(Debug, Serialize)]
struct PromptModel<'a> {
    #[serde(rename = "providerID")]
    provider_id: &'a str,
    #[serde(rename = "modelID")]
    model_id: &'a str,
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

/// Percent-encodes a path segment.
///
/// A provider id comes from the catalogue today, but it reaches this function as
/// a plain string from the interface, and a `/` in it would silently address a
/// different route.
fn urlencode(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// Sends a request and unwraps `{"data": ...}`.
///
/// The body is kept and put in the error. A parse failure with only serde's
/// message ("missing field `time` at line 1 column 240") is nearly useless
/// against an API whose shapes move between versions; the body says which
/// shape actually arrived.
async fn read_envelope<T: serde::de::DeserializeOwned>(
    request: reqwest::RequestBuilder,
    what: &str,
) -> Result<T, EngineFailure> {
    let response = request.send().await.map_err(to_failure)?;
    let status = response.status();
    let body = response.text().await.map_err(to_failure)?;
    if !status.is_success() {
        return Err(EngineFailure::Http(format!(
            "reading the {what} failed ({status}): {body}"
        )));
    }
    serde_json::from_str::<Envelope<T>>(&body)
        .map(|e| e.data)
        .map_err(|e| EngineFailure::Http(format!("{what} unreadable: {e}; body: {body}")))
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

    /// Every model a connected provider offers.
    ///
    /// **Read from `/provider`, not `/api/model`.** The newer route only counts
    /// a provider whose key is in the engine's environment; a key in OpenCode's
    /// own credential store does not appear there. Measured with the key only in
    /// the store: `/api/model` offered 31 models, every one of them OpenCode's
    /// free tier, while `/provider` listed MiniMax as connected with its seven.
    /// An installed application has its keys in the store, so the older route is
    /// the only one that shows what can actually run.
    ///
    /// OpenCode's own provider comes last. It is always connected, because its
    /// free tier needs no key — and that free tier refuses to answer outside the
    /// OpenCode application. Listed first, it would be what a new session picks
    /// when nothing else has been chosen.
    ///
    /// **Nothing from this response may reach an error message.** It is the same
    /// endpoint that returns API keys in plain text.
    pub async fn list_models(&self) -> Result<Vec<Model>, EngineFailure> {
        let response = self
            .http
            .get(self.url("/provider"))
            .send()
            .await
            .map_err(to_failure)?;

        let status = response.status();
        if !status.is_success() {
            return Err(EngineFailure::Http(format!(
                "listing models failed ({status})"
            )));
        }
        let body = response.text().await.map_err(to_failure)?;
        let catalogue = serde_json::from_str::<WireCatalogue>(&body).map_err(|e| {
            // The serde message names a position and an expected type; it never
            // quotes the input, so it is safe to pass on. The body is not.
            EngineFailure::Http(format!("model list unreadable: {e}"))
        })?;
        Ok(catalogue.usable_models())
    }

    /// The provider catalogue, and which of it is usable.
    ///
    /// **`/provider`, not `/api/provider`.** They are different endpoints:
    /// `/api/provider` lists only the handful already connected, while this one
    /// carries the whole catalogue — 221 entries on the development machine —
    /// together with a `connected` list. Auth lives outside `/api` too.
    pub async fn list_providers(&self) -> Result<Providers, EngineFailure> {
        // No envelope on this one. It answers with the object directly, unlike
        // everything under /api.
        let response = self
            .http
            .get(self.url("/provider"))
            .send()
            .await
            .map_err(to_failure)?;
        let status = response.status();
        let body = response.text().await.map_err(to_failure)?;
        if !status.is_success() {
            return Err(EngineFailure::Http(format!(
                "reading the providers failed ({status}): {body}"
            )));
        }
        serde_json::from_str::<Providers>(&body)
            .map_err(|e| EngineFailure::Http(format!("provider list unreadable: {e}")))
    }

    /// Stores an API key for a provider, through the engine rather than by
    /// writing its file.
    ///
    /// The engine owns `auth.json`; writing it behind the engine's back would
    /// race whatever else has it open. This is also how the reference delivers
    /// credentials.
    ///
    /// **Nothing here may put `key` in a message.** The response body is not
    /// echoed on failure for that reason alone — on every other call it is, and
    /// it helps; here it is the one place a credential could be reflected back
    /// into a log. The status is enough to act on.
    pub async fn set_provider_key(
        &self,
        provider_id: &str,
        key: &str,
    ) -> Result<(), EngineFailure> {
        let response = self
            .http
            .put(self.url(&format!("/auth/{}", urlencode(provider_id))))
            .json(&serde_json::json!({ "type": "api", "key": key }))
            .send()
            .await
            .map_err(to_failure)?;

        let status = response.status();
        if !status.is_success() {
            return Err(EngineFailure::Http(format!(
                "the engine refused the key for {provider_id} ({status})"
            )));
        }
        Ok(())
    }

    pub async fn remove_provider_key(&self, provider_id: &str) -> Result<(), EngineFailure> {
        let response = self
            .http
            .delete(self.url(&format!("/auth/{}", urlencode(provider_id))))
            .send()
            .await
            .map_err(to_failure)?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(EngineFailure::Http(format!(
                "removing the key for {provider_id} failed ({status}): {body}"
            )));
        }
        Ok(())
    }

    /// Every session the engine knows about in `directory`.
    ///
    /// This stays on the newer `/api` generation while messages and turns use
    /// the older one, and that is safe: the two generations keep separate
    /// message stores but share one table of sessions. A session whose turns ran
    /// through `prompt_async` is listed here, with the model its last turn used.
    ///
    /// **Reading is not bound to the engine's working directory; creating is.**
    /// `?directory=` filters the list to any folder, so one engine serves the
    /// whole sidebar. A create aimed at another folder came back located in the
    /// engine's own — measured, not assumed.
    pub async fn list_sessions(
        &self,
        directory: Option<&str>,
    ) -> Result<Vec<EngineSession>, EngineFailure> {
        // Built through `Url` rather than `RequestBuilder::query`: reqwest is
        // pulled in with `default-features = false` here, deliberately, and the
        // query helper is not in that set. Turning a feature back on to save
        // three lines is how this crate broke every HTTP client once already.
        let mut url = reqwest::Url::parse(&self.url("/api/session"))
            .map_err(|e| EngineFailure::Http(format!("session list url invalid: {e}")))?;
        if let Some(directory) = directory {
            url.query_pairs_mut().append_pair("directory", directory);
        }
        read_envelope::<Vec<EngineSession>>(self.http.get(url), "session list").await
    }

    /// The messages in a session, oldest first — the order the engine already
    /// sends them in on this route.
    ///
    /// **`/session/{id}/message`, not `/api/session/{id}/message`.** OpenCode
    /// v1.18.18 carries two generations of its API side by side, and they keep
    /// their messages apart: a turn sent through one is invisible to the other.
    /// Measured across nineteen sessions — every one had messages in exactly one
    /// of the two lists, never both. Sending through the older generation and
    /// reading through the newer showed conversations as empty.
    pub async fn list_messages(
        &self,
        engine_session_id: &str,
    ) -> Result<Vec<Message>, EngineFailure> {
        let response = self
            .http
            .get(self.url(&format!(
                "/session/{}/message",
                urlencode(engine_session_id)
            )))
            .send()
            .await
            .map_err(to_failure)?;
        let status = response.status();
        let body = response.text().await.map_err(to_failure)?;
        if !status.is_success() {
            return Err(EngineFailure::Http(format!(
                "reading the messages failed ({status}): {body}"
            )));
        }
        let wire = serde_json::from_str::<Vec<WireMessage>>(&body).map_err(|e| {
            EngineFailure::Http(format!("message list unreadable: {e}; body: {body}"))
        })?;
        Ok(wire.into_iter().map(Message::from).collect())
    }

    /// Creates a session, with a model if one is given.
    ///
    /// The model given here is only where the session starts. Every prompt names
    /// its own, so a conversation can change model between turns.
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

    /// Sends a prompt, naming the model that should answer it.
    ///
    /// **Through `/session/{id}/prompt_async`, the older of the engine's two
    /// APIs, deliberately.** The newer `/api/session/{id}/prompt` accepts a turn
    /// and then never runs it unless the provider's key is in the engine's
    /// *environment*. A key in OpenCode's own credential store — which is where
    /// `opencode auth login` and our AI Providers screen both put it — is not
    /// enough there. Measured on the same engine binary, changing nothing but
    /// that variable: with the key only in the store, the turn sat unanswered
    /// with no error anywhere; with it also in the environment, it ran. This
    /// route runs from the store alone.
    ///
    /// Every earlier test passed because the engine was started with the key in
    /// its environment. An installed application is not.
    ///
    /// The model travels with every prompt, so a conversation is not fixed to
    /// the model it started on. Without one the engine falls back to its own
    /// default, which on the test machine is OpenCode's free tier — and that
    /// refuses to run outside the OpenCode application.
    pub async fn send_prompt(
        &self,
        engine_session_id: &str,
        text: &str,
        model: Option<&Model>,
    ) -> Result<(), EngineFailure> {
        let body = PromptBody {
            parts: [PromptPart { kind: "text", text }],
            model: model.map(|m| PromptModel {
                provider_id: &m.provider_id,
                model_id: &m.id,
            }),
        };
        let response = self
            .http
            .post(self.url(&format!(
                "/session/{}/prompt_async",
                urlencode(engine_session_id)
            )))
            .json(&body)
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

    /// Stops a turn mid-flight. The turn ends with `session.idle` on the stream
    /// and a `MessageAbortedError` on the message — both measured.
    pub async fn interrupt(&self, engine_session_id: &str) -> Result<(), EngineFailure> {
        let response = self
            .http
            .post(self.url(&format!("/session/{}/abort", urlencode(engine_session_id))))
            .send()
            .await
            .map_err(to_failure)?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(EngineFailure::Http(format!(
                "stopping the session failed ({status}): {body}"
            )));
        }
        Ok(())
    }

    /// Opens the event stream and calls `on_chunk` for every event belonging to
    /// this session, until the turn ends or `cancel` goes true.
    ///
    /// **`/event`, the stream that belongs with `prompt_async`.** A turn sent
    /// through the older API reports its tokens there as `message.part.delta`;
    /// the newer `/api/event` carried six events for the same turn and not one
    /// token. Events from other sessions come through too, so they are filtered
    /// here.
    ///
    /// `ready` fires once the stream is actually open. The caller must wait for
    /// it before sending the prompt: a short turn can finish — `session.idle`
    /// and all — before a stream opened afterwards has connected, and then the
    /// turn's end is never seen and the interface waits forever.
    ///
    /// SSE is parsed by hand rather than with a library: it is only two kinds of
    /// line, and another dependency is not worth it.
    pub async fn stream<F>(
        &self,
        engine_session_id: &str,
        cancel: tokio::sync::watch::Receiver<bool>,
        ready: Option<tokio::sync::oneshot::Sender<()>>,
        mut on_chunk: F,
    ) -> Result<(), EngineFailure>
    where
        F: FnMut(Chunk),
    {
        let response = self
            .http
            .get(self.url("/event"))
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
        if let Some(ready) = ready {
            let _ = ready.send(());
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

/// The event that marks the end of a turn — every step of it, tool calls
/// included, and a turn that was stopped as well. Measured: a turn that called
/// a tool went through two `step-start`/`step-finish` pairs and ended with one
/// `session.idle`; a stopped turn ended the same way.
const TURN_END: &str = "session.idle";

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

    // `/event` wraps an event's content in `properties`. Anything without that
    // is kept whole rather than guessed at.
    let payload = parsed
        .get("properties")
        .cloned()
        .unwrap_or_else(|| parsed.clone());

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

    /// Copied verbatim from a real OpenCode v1.18.18 `/event` stream — not
    /// invented from the schema. The first version of this test used an invented
    /// shape with `event:` lines, and passed happily while the code it tested
    /// would never have worked against the real engine.
    const REAL_BLOCK: &str = r#"data: {"type":"message.part.delta","properties":{"sessionID":"ses_f4cddf7a8ffewrU6orjt2suKc1","messageID":"msg_0b3220c80001Vryaf1naWLBXAZ","partID":"prt_0b32216bb001PhQsLRTJv24SAG","field":"text","delta":"The user"}}

"#;

    #[test]
    fn kind_comes_from_inside_the_json_not_an_event_line() {
        let c = parse_event(REAL_BLOCK).expect("should parse");
        assert_eq!(c.kind, "message.part.delta");
        assert_eq!(
            c.engine_session_id.as_deref(),
            Some("ses_f4cddf7a8ffewrU6orjt2suKc1")
        );
        assert_eq!(c.payload["delta"], "The user");
    }

    #[test]
    fn an_event_without_a_session_still_parses_but_has_no_owner() {
        // The global stream carries things like this too, and they have to be
        // filtered by the caller — not quietly attributed to the active session.
        let block = r#"data: {"type":"server.heartbeat","properties":{}}

"#;
        let c = parse_event(block).expect("should parse");
        assert_eq!(c.kind, "server.heartbeat");
        assert_eq!(c.engine_session_id, None);
    }

    #[test]
    fn multi_line_data_is_joined() {
        let block = "data: {\"type\":\"x\",\ndata: \"properties\":{\"sessionID\":\"ses_1\"}}\n\n";
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
    fn the_turn_ends_on_session_idle() {
        let block = r#"data: {"type":"session.idle","properties":{"sessionID":"ses_abc"}}

"#;
        let c = parse_event(block).expect("should parse");
        assert_eq!(c.kind, TURN_END);
        assert_eq!(c.engine_session_id.as_deref(), Some("ses_abc"));
    }

    /// Both of the engine's message shapes, from a real capture: a user message
    /// names its model as an object, an assistant message as two flat fields.
    #[test]
    fn messages_are_flattened_from_info_and_parts() {
        let wire = r#"[
          {"info":{"id":"msg_u","sessionID":"ses_1","role":"user","time":{"created":1},
                   "agent":"build","model":{"providerID":"minimax","modelID":"MiniMax-M2.5"}},
           "parts":[{"id":"prt_1","type":"text","text":"Count from 1 to 5."}]},
          {"info":{"id":"msg_a","sessionID":"ses_1","role":"assistant","time":{"created":2,"completed":3},
                   "modelID":"MiniMax-M2.5","providerID":"minimax","finish":"stop"},
           "parts":[{"id":"prt_2","type":"step-start"},
                    {"id":"prt_3","type":"reasoning","text":"thinking"},
                    {"id":"prt_4","type":"tool","tool":"read","callID":"call_1",
                     "state":{"status":"completed","title":"README.md","input":{},"output":"x","metadata":{},"time":{}}},
                    {"id":"prt_5","type":"text","text":"1 2 3 4 5"},
                    {"id":"prt_6","type":"step-finish","reason":"stop"}]}
        ]"#;
        let messages: Vec<Message> = serde_json::from_str::<Vec<WireMessage>>(wire)
            .expect("the captured shape should parse")
            .into_iter()
            .map(Message::from)
            .collect();

        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text.as_deref(), Some("Count from 1 to 5."));
        assert_eq!(
            messages[0].model.as_ref().map(|m| m.id.as_str()),
            Some("MiniMax-M2.5")
        );

        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].text, None);
        assert_eq!(messages[1].finish.as_deref(), Some("stop"));
        assert_eq!(
            messages[1].model.as_ref().map(|m| m.provider_id.as_str()),
            Some("minimax")
        );
        assert!(matches!(messages[1].content[3], Part::Text { .. }));
        assert!(matches!(messages[1].content[2], Part::Tool { .. }));
        assert!(matches!(messages[1].content[0], Part::Other));
    }

    /// Only connected providers, the free tier last, each provider's default
    /// first, and the key that rides along in the same response never read.
    #[test]
    fn models_come_from_connected_providers_with_the_free_tier_last() {
        let body = r#"{
          "all": [
            {"id":"opencode","models":{"big-pickle":{"id":"big-pickle"}}},
            {"id":"minimax","key":"sk-must-never-be-read","models":{"MiniMax-M2.5":{"id":"MiniMax-M2.5"},"MiniMax-M2.1":{}}},
            {"id":"anthropic","models":{"claude-opus-5":{}}}
          ],
          "connected": ["opencode","minimax"],
          "default": {"minimax":"MiniMax-M2.5","opencode":"big-pickle"}
        }"#;
        let models = serde_json::from_str::<WireCatalogue>(body)
            .expect("parses")
            .usable_models();
        let names: Vec<String> = models
            .iter()
            .map(|m| format!("{}/{}", m.provider_id, m.id))
            .collect();
        assert_eq!(
            names,
            [
                "minimax/MiniMax-M2.5",
                "minimax/MiniMax-M2.1",
                "opencode/big-pickle"
            ]
        );
    }

    /// `modelID`, not `id` — the engine refuses extra fields on this object.
    #[test]
    fn a_prompt_names_its_model_the_way_the_engine_expects() {
        let body = PromptBody {
            parts: [PromptPart {
                kind: "text",
                text: "hi",
            }],
            model: Some(PromptModel {
                provider_id: "minimax",
                model_id: "MiniMax-M2.5",
            }),
        };
        assert_eq!(
            serde_json::to_value(&body).expect("serialises"),
            serde_json::json!({
                "parts": [{ "type": "text", "text": "hi" }],
                "model": { "providerID": "minimax", "modelID": "MiniMax-M2.5" }
            })
        );
    }
}
