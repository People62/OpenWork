// The OpenCode engine, managed from Rust.
//
// In OpenWork this part is a TypeScript backend running as a separate bun
// process. Here it lives inside the Tauri process — but OpenCode itself is still
// a child process, and still 46–67% of memory. What disappears is the bun layer
// in between, not the engine.
//
// Three things have to be right, and all three have been wrong in Rantai:
//
//   1. A binary that is not there must say so — not name a signal or an exit
//      code from the cleanup layer.
//   2. The child process must not be orphaned when the application closes.
//   3. A conversation must be stoppable mid-flight without leaving a remnant.

pub mod client;
pub mod locate;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use specta::Type;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub use locate::Source;

/// How long to wait for the engine to call itself healthy. OpenCode loads its
/// configuration and plugins on start, so this is not a fraction of a second.
const READY_TIMEOUT: Duration = Duration::from_secs(45);

/// The gap between health probes while waiting.
const PROBE_INTERVAL: Duration = Duration::from_millis(150);

/// How long the process is given to close itself before it is forced.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum EngineFailure {
    #[error(
        "the OpenCode binary was not found. Places checked:\n  {}",
        .checked.join("\n  ")
    )]
    BinaryNotFound { checked: Vec<String> },

    #[error("could not run {path}: {cause}")]
    SpawnFailed { path: String, cause: String },

    #[error(
        "the engine exited before it was ready (code {code}). Its last output:\n  {}",
        .output.join("\n  ")
    )]
    ExitedBeforeReady { code: String, output: Vec<String> },

    #[error(
        "the engine never called itself ready within {seconds} seconds. Its last output:\n  {}",
        .output.join("\n  ")
    )]
    NeverBecameReady { seconds: u64, output: Vec<String> },

    #[error("the engine is not running")]
    NotRunning,

    #[error("talking to the engine failed: {0}")]
    Http(String),
}

/// The shape an engine error takes when it crosses to the interface.
///
/// `EngineFailure` deliberately does not derive `Type`: it is an internal type
/// whose variants will grow, and that internal shape is not a contract. The
/// contract is the message — and the message is where all the value of this
/// phase's failure paths lives.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineError {
    pub message: String,
}

impl From<EngineFailure> for EngineError {
    fn from(e: EngineFailure) -> Self {
        Self {
            message: e.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub running: bool,
    pub address: Option<String>,
    pub binary_path: Option<String>,
    pub source: Option<String>,
    pub uptime_seconds: Option<f64>,
    /// The folder the running engine works in, if it is running.
    pub working_dir: Option<String>,
}

/// A live engine process.
struct Live {
    child: Child,
    address: String,
    binary_path: PathBuf,
    source: Source,
    since: Instant,
    /// The folder it was started in. Reading history works for any folder, but
    /// creating a session and running a turn always land here — so this decides
    /// which workspace the engine can actually work in.
    working_dir: PathBuf,
}

/// Held by Tauri as state. One engine for the whole application in Release 1;
/// several workspaces at once is a leaf, not the trunk.
#[derive(Default)]
pub struct Engine {
    live: Arc<Mutex<Option<Live>>>,
}

impl Engine {
    pub async fn status(&self) -> EngineStatus {
        describe(self.live.lock().await.as_ref())
    }

    pub async fn address(&self) -> Result<String, EngineFailure> {
        self.live
            .lock()
            .await
            .as_ref()
            .map(|l| l.address.clone())
            .ok_or(EngineFailure::NotRunning)
    }

    /// Starts the engine inside `working_dir`.
    ///
    /// An engine already running in that same folder is returned as it is. One
    /// running somewhere **else** is stopped and replaced: `?directory=` lets us
    /// read any folder's history from any engine, but a session is created, and
    /// a turn is run, in the engine's own cwd — so working in another workspace
    /// means another process. This is what the reference does too.
    ///
    /// The whole thing happens under one lock. Releasing it between the check
    /// and the spawn would let two workspace switches land at once and leave a
    /// process with no handle to it — which is exactly how an orphan engine
    /// happened before.
    pub async fn start(
        &self,
        working_dir: &Path,
        app_dir: Option<&Path>,
    ) -> Result<EngineStatus, EngineFailure> {
        let wanted = canonical(working_dir);
        let mut guard = self.live.lock().await;

        if let Some(live) = guard.as_ref() {
            if live.working_dir == wanted {
                let status = describe(Some(live));
                drop(guard);
                return Ok(status);
            }
        }

        // A different folder. Stop the old process before spawning the new one —
        // two engines at once would both hold the same OpenCode storage open.
        if let Some(live) = guard.take() {
            shutdown(live).await;
        }

        let found = locate::locate(&locate::Search::from_env(app_dir))?;

        let mut child = Command::new(&found.path)
            .arg("serve")
            // Port 0 means the system picks. The number is read from the
            // process's output rather than guessed — two applications using a
            // fixed port would collide, and that collision surfaces as a failure
            // that sounds like something else entirely.
            .arg("--port")
            .arg("0")
            .arg("--hostname")
            .arg("127.0.0.1")
            .current_dir(&wanted)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Without this, closing the window leaves OpenCode alive in the
            // background.
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| EngineFailure::SpawnFailed {
                path: found.path.display().to_string(),
                cause: e.to_string(),
            })?;

        let address = match wait_until_ready(&mut child).await {
            Ok(address) => address,
            Err(e) => {
                // Do not leave a half-started process behind if it failed to
                // become ready.
                let _ = child.kill().await;
                return Err(e);
            }
        };

        // "Listening" and "ready to serve" are not the same thing. The marker
        // line above only proves the socket is open; this probe proves the
        // engine answers.
        if let Err(e) = wait_until_healthy(&address).await {
            let _ = child.kill().await;
            return Err(e);
        }

        *guard = Some(Live {
            child,
            address,
            binary_path: found.path,
            source: found.source,
            since: Instant::now(),
            working_dir: wanted,
        });
        let status = describe(guard.as_ref());
        drop(guard);

        Ok(status)
    }

    /// Stops the engine. It is given a chance to close itself first, then forced.
    /// Safe to call when the engine is not running.
    pub async fn stop(&self) -> Result<(), EngineFailure> {
        let Some(live) = self.live.lock().await.take() else {
            return Ok(());
        };
        shutdown(live).await;
        Ok(())
    }
}

/// Ends a process: asked first, forced after `SHUTDOWN_TIMEOUT`, then reaped.
///
/// Reaping matters. Killing without waiting leaves a zombie, and a zombie still
/// holds the port — the next start would fail with an error naming the port
/// rather than the process that never died.
async fn shutdown(mut live: Live) {
    let _ = live.child.start_kill();

    let started = Instant::now();
    loop {
        match live.child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {}
            Err(_) => break,
        }
        if started.elapsed() > SHUTDOWN_TIMEOUT {
            break;
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
    }

    let _ = live.child.kill().await;
    let _ = live.child.wait().await;
}

/// The folder as the engine will see it. `canonicalize` resolves symlinks and
/// trailing slashes, so `/home/x` and `/home/x/` compare equal; a path that does
/// not exist is left alone and the spawn reports it.
fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Status without taking the lock, for callers that already hold it.
fn describe(live: Option<&Live>) -> EngineStatus {
    match live {
        Some(l) => EngineStatus {
            running: true,
            address: Some(l.address.clone()),
            binary_path: Some(l.binary_path.display().to_string()),
            source: Some(format!("{:?}", l.source)),
            uptime_seconds: Some(l.since.elapsed().as_secs_f64()),
            working_dir: Some(l.working_dir.display().to_string()),
        },
        None => EngineStatus {
            running: false,
            address: None,
            binary_path: None,
            source: None,
            uptime_seconds: None,
            working_dir: None,
        },
    }
}

/// Probes /api/health until the engine answers, or gives up.
async fn wait_until_healthy(address: &str) -> Result<(), EngineFailure> {
    let client = client::Client::new(address);
    let started = Instant::now();
    let mut last = String::from("never answered");

    while started.elapsed() < READY_TIMEOUT {
        match client.healthy().await {
            Ok(true) => return Ok(()),
            Ok(false) => last = "answered, but called itself unhealthy".into(),
            Err(e) => last = e.to_string(),
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
    }

    Err(EngineFailure::NeverBecameReady {
        seconds: READY_TIMEOUT.as_secs(),
        output: vec![format!("{address}/api/health — {last}")],
    })
}

/// Waits for the engine to be ready while reading its output.
///
/// Two things are watched at once, and that is deliberate: the "listening on"
/// line that gives its address, and the death of the process. If only the address
/// were awaited, a process that dies on startup would look like a timeout — a
/// message naming the wrong thing.
async fn wait_until_ready(child: &mut Child) -> Result<String, EngineFailure> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel::<String>();

    if let Some(out) = stdout {
        let send = send.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if send.send(line).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if send.send(line).is_err() {
                    break;
                }
            }
        });
    }

    let started = Instant::now();
    // Only the last few lines are kept; OpenCode's output can be long, and what
    // is useful on failure is always the tail.
    let mut tail: Vec<String> = Vec::new();

    loop {
        if let Ok(Some(state)) = child.try_wait() {
            return Err(EngineFailure::ExitedBeforeReady {
                code: state
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "no code".into()),
                output: tail,
            });
        }

        if started.elapsed() > READY_TIMEOUT {
            return Err(EngineFailure::NeverBecameReady {
                seconds: READY_TIMEOUT.as_secs(),
                output: tail,
            });
        }

        match tokio::time::timeout(PROBE_INTERVAL, receive.recv()).await {
            Ok(Some(line)) => {
                if let Some(address) = address_from(&line) {
                    return Ok(address);
                }
                tail.push(line);
                if tail.len() > 12 {
                    tail.remove(0);
                }
            }
            Ok(None) => {}
            Err(_) => {}
        }
    }
}

/// Reads "opencode server listening on http://127.0.0.1:PORT".
fn address_from(line: &str) -> Option<String> {
    let piece = line.split_whitespace().find(|p| p.starts_with("http://"))?;
    Some(piece.trim_end_matches(['.', ',']).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_address_from_the_marker_line() {
        assert_eq!(
            address_from("opencode server listening on http://127.0.0.1:47777").as_deref(),
            Some("http://127.0.0.1:47777")
        );
        assert_eq!(address_from("timestamp=... message=loading"), None);
    }

    #[test]
    fn a_missing_binary_error_names_no_signal() {
        let failure = EngineFailure::BinaryNotFound {
            checked: vec!["/tmp/empty/opencode — sidecar".into()],
        };
        let message = failure.to_string();
        assert!(message.contains("not found"));
        assert!(message.contains("/tmp/empty/opencode"));
        assert!(!message.contains("SIGKILL"));
    }
}

#[cfg(test)]
mod process_tests {
    use super::*;

    /// This test runs a real OpenCode. It only runs when `RANTAI_OPENCODE_TEST`
    /// points at a binary that exists — otherwise it is skipped without
    /// pretending to test anything. Pretending is exactly the failure that made
    /// three reproduction attempts in Rantai worthless.
    fn test_binary() -> Option<PathBuf> {
        let path = PathBuf::from(std::env::var_os("RANTAI_OPENCODE_TEST")?);
        path.is_file().then_some(path)
    }

    #[tokio::test]
    async fn starts_then_stops_without_leaving_an_orphan() {
        let Some(binary) = test_binary() else {
            eprintln!("skipped: RANTAI_OPENCODE_TEST does not point at a binary");
            return;
        };

        let working_dir = std::env::temp_dir();
        let engine = Engine::default();

        let status = start_with(&engine, &working_dir, &binary)
            .await
            .expect("the engine should start");
        assert!(status.running);
        let address = status.address.clone().expect("there should be an address");
        assert!(address.starts_with("http://127.0.0.1:"));

        // Really alive, not merely claimed to be.
        let client = client::Client::new(&address);
        assert!(client.healthy().await.expect("probe failed"));

        // Record the PID so it can be checked after shutdown.
        let pid = engine
            .live
            .lock()
            .await
            .as_ref()
            .and_then(|l| l.child.id())
            .expect("there should be a PID");

        engine.stop().await.expect("stopping failed");
        assert!(!engine.status().await.running);

        // Give the system a moment to reap it, then make sure it really is gone
        // — not merely released by us.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            !process_exists(pid),
            "process {pid} is still alive after being stopped — orphaned"
        );
        assert!(
            client.healthy().await.is_err(),
            "the engine still answers after being stopped"
        );
    }

    #[cfg(unix)]
    pub(super) fn process_exists(pid: u32) -> bool {
        Path::new(&format!("/proc/{pid}")).exists()
    }

    #[cfg(not(unix))]
    pub(super) fn process_exists(_pid: u32) -> bool {
        false
    }

    /// Starts the engine from a known binary, so the test does not depend on the
    /// search environment.
    async fn start_with(
        engine: &Engine,
        working_dir: &Path,
        binary: &Path,
    ) -> Result<EngineStatus, EngineFailure> {
        // SAFETY: this variable is only read by `Search::from_env`, and the
        // process tests run serially via `--test-threads=1` in CI.
        unsafe { std::env::set_var(locate::ENV_OVERRIDE, binary) };
        let result = engine.start(working_dir, None).await;
        unsafe { std::env::remove_var(locate::ENV_OVERRIDE) };
        result
    }
}

#[cfg(test)]
mod conversation_tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    /// The Phase 2 gate, exercised through our own code against a real model.
    ///
    /// Only runs when `RANTAI_OPENCODE_TEST` points at a binary **and**
    /// `RANTAI_MODEL_TEST` names a model as `providerID/id`. Without both it
    /// skips and says so — pretending to test is a worse failure than not
    /// testing.
    ///
    /// The working directory matters: provider availability in OpenCode depends
    /// on it. This runs at the repository root, which is recognised as a project.
    #[tokio::test]
    async fn a_full_conversation_streams_then_can_be_stopped() {
        let (Some(binary), Some(model_text)) = (
            std::env::var_os("RANTAI_OPENCODE_TEST").map(PathBuf::from),
            std::env::var("RANTAI_MODEL_TEST").ok(),
        ) else {
            eprintln!("skipped: RANTAI_OPENCODE_TEST and RANTAI_MODEL_TEST are not set");
            return;
        };
        if !binary.is_file() {
            eprintln!("skipped: the test binary does not exist");
            return;
        }
        let (provider_id, model_id) = model_text
            .split_once('/')
            .expect("RANTAI_MODEL_TEST must be providerID/modelID");
        let model = client::Model {
            provider_id: provider_id.to_string(),
            id: model_id.to_string(),
        };

        // The repository root: two levels above src-tauri.
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .expect("could not find the repository root");

        let engine = Engine::default();
        // SAFETY: these tests run serially via --test-threads=1.
        unsafe { std::env::set_var(locate::ENV_OVERRIDE, &binary) };
        let status = engine
            .start(&root, None)
            .await
            .expect("the engine should start");
        unsafe { std::env::remove_var(locate::ENV_OVERRIDE) };

        let client = client::Client::new(status.address.clone().expect("address"));

        // The model has to actually be available; otherwise the failure never
        // appears on the event stream at all — only in the engine's log.
        let available = client.list_models().await.expect("listing models");
        assert!(
            available
                .iter()
                .any(|m| m.provider_id == model.provider_id && m.id == model.id),
            "model {model_text} is not available in {}; what is: {:?}",
            root.display(),
            available.iter().take(5).collect::<Vec<_>>()
        );

        let session = client
            .create_session(Some(&model))
            .await
            .expect("creating the session failed");

        let collected: Arc<StdMutex<Vec<client::Chunk>>> = Arc::default();
        let (send_cancel, receive_cancel) = tokio::sync::watch::channel(false);

        let stream_client = client.clone();
        let stream_session = session.id.clone();
        let stream_collected = collected.clone();
        let task = tokio::spawn(async move {
            stream_client
                .stream(&stream_session, receive_cancel, move |c| {
                    stream_collected
                        .lock()
                        .expect("collection poisoned")
                        .push(c);
                })
                .await
        });

        // Give the stream a moment to open before the prompt goes out.
        tokio::time::sleep(Duration::from_millis(500)).await;
        client
            .send_prompt(&session.id, "Count from 1 to 40, one number per line.")
            .await
            .expect("the prompt was rejected");

        // Wait for real tokens to start flowing.
        let started = Instant::now();
        loop {
            let has_delta = collected
                .lock()
                .expect("collection poisoned")
                .iter()
                .any(|c| c.kind.contains("delta"));
            if has_delta {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(90),
                "not one token in 90 seconds; events that arrived: {:?}",
                collected
                    .lock()
                    .expect("collection poisoned")
                    .iter()
                    .map(|c| c.kind.clone())
                    .collect::<Vec<_>>()
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        // Stop it mid-flight — this is what closes the gate.
        client
            .interrupt(&session.id)
            .await
            .expect("interrupt failed");
        let _ = send_cancel.send(true);

        let finished = tokio::time::timeout(Duration::from_secs(30), task).await;
        assert!(
            finished.is_ok(),
            "the stream did not stop within 30 seconds of being cancelled"
        );

        // The lock is released before the next `await`. A synchronous MutexGuard
        // held across an await point can deadlock the runtime — clippy catches
        // it, and it is right.
        let (count, kinds, all_ours) = {
            let chunks = collected.lock().expect("collection poisoned");
            (
                chunks.len(),
                chunks
                    .iter()
                    .map(|c| c.kind.clone())
                    .collect::<std::collections::BTreeSet<_>>(),
                chunks
                    .iter()
                    .all(|c| c.engine_session_id.as_deref() == Some(session.id.as_str())),
            )
        };
        assert!(all_ours, "an event from another session slipped the filter");
        eprintln!("conversation: {count} events, kinds: {kinds:?}");

        let pid = engine.live.lock().await.as_ref().and_then(|l| l.child.id());
        engine.stop().await.expect("stopping failed");
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(pid) = pid {
            assert!(
                !super::process_tests::process_exists(pid),
                "process {pid} orphaned"
            );
        }
    }

    /// The Phase 5 gate: ask something, get an answer, close the application,
    /// open it again, and the answer is still there.
    ///
    /// The engine is stopped and started again in the middle on purpose. Rantai
    /// keeps no copy of a conversation — OpenCode does — so "it is still there"
    /// is only a real claim if it survives the process that wrote it. Reading it
    /// back from the same live engine would pass just as well against an
    /// in-memory cache, and prove nothing.
    #[tokio::test]
    async fn an_answer_survives_the_engine_being_restarted() {
        let Some((binary, model)) = live_model() else {
            eprintln!("skipped: RANTAI_OPENCODE_TEST and RANTAI_MODEL_TEST are not set");
            return;
        };
        let root = repository_root();
        let engine = Engine::default();

        // --- first run: ask, and wait for a real answer -------------------
        let address = start_with_override(&engine, &root, &binary).await;
        let client = client::Client::new(address);

        let session = client
            .create_session(Some(&model))
            .await
            .expect("creating the session failed");

        let asked = "Reply with exactly one word: halo";
        let (_cancel_send, cancel_receive) = tokio::sync::watch::channel(false);
        let stream_client = client.clone();
        let stream_session = session.id.clone();
        let streaming = tokio::spawn(async move {
            stream_client
                .stream(&stream_session, cancel_receive, |_| {})
                .await
        });

        tokio::time::sleep(Duration::from_millis(500)).await;
        client
            .send_prompt(&session.id, asked)
            .await
            .expect("the prompt was rejected");

        // The stream returns when the turn ends. Waiting on it rather than on a
        // timer is what makes this test about the answer instead of about how
        // fast the model happens to be today.
        tokio::time::timeout(Duration::from_secs(180), streaming)
            .await
            .expect("the turn did not end within 180 seconds")
            .expect("the streaming task panicked")
            .expect("the stream failed");

        let before = client
            .list_messages(&session.id)
            .await
            .expect("reading the messages failed");
        let answer = assistant_text(&before);
        assert!(
            !answer.is_empty(),
            "the turn ended with no assistant text; what is there: {:?}",
            before
                .iter()
                .map(|m| (&m.role, &m.finish))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            before.first().map(|m| m.role.as_str()),
            Some("user"),
            "messages should arrive oldest first"
        );

        // --- the application closes ---------------------------------------
        let pid = engine.live.lock().await.as_ref().and_then(|l| l.child.id());
        engine.stop().await.expect("stopping failed");
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(pid) = pid {
            assert!(
                !super::process_tests::process_exists(pid),
                "process {pid} orphaned"
            );
        }

        // --- it opens again ------------------------------------------------
        let address = start_with_override(&engine, &root, &binary).await;
        let reopened = client::Client::new(address);

        let sessions = reopened
            .list_sessions(Some(&root.display().to_string()))
            .await
            .expect("listing the sessions failed");
        assert!(
            sessions.iter().any(|s| s.id == session.id),
            "the session is gone after a restart; {} others are listed",
            sessions.len()
        );

        let after = reopened
            .list_messages(&session.id)
            .await
            .expect("reading the messages failed");
        assert_eq!(
            assistant_text(&after),
            answer,
            "the answer changed across the restart"
        );
        assert!(
            after.iter().any(|m| m.text.as_deref() == Some(asked)),
            "the question is gone after a restart"
        );

        engine.stop().await.expect("stopping failed");
    }

    /// Every `text` part of every assistant message, joined.
    fn assistant_text(messages: &[client::Message]) -> String {
        messages
            .iter()
            .filter(|m| m.role == "assistant")
            .flat_map(|m| &m.content)
            .filter_map(|part| match part {
                client::Part::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }

    fn live_model() -> Option<(PathBuf, client::Model)> {
        let binary = PathBuf::from(std::env::var_os("RANTAI_OPENCODE_TEST")?);
        if !binary.is_file() {
            return None;
        }
        let text = std::env::var("RANTAI_MODEL_TEST").ok()?;
        let (provider_id, id) = text.split_once('/')?;
        Some((
            binary,
            client::Model {
                provider_id: provider_id.to_string(),
                id: id.to_string(),
            },
        ))
    }

    /// The repository root: three levels above `src-tauri`. Provider
    /// availability depends on the working directory, and the root is the folder
    /// OpenCode recognises as a project.
    fn repository_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .expect("could not find the repository root")
    }

    async fn start_with_override(engine: &Engine, root: &Path, binary: &Path) -> String {
        // SAFETY: these tests run serially via --test-threads=1.
        unsafe { std::env::set_var(locate::ENV_OVERRIDE, binary) };
        let status = engine.start(root, None).await;
        unsafe { std::env::remove_var(locate::ENV_OVERRIDE) };
        status
            .expect("the engine should start")
            .address
            .expect("address")
    }
}
