// Smoke mode — what CI uses to tell "it built" apart from "it opened and is
// alive".
//
// The application is genuinely run, waits for an ordered set of signals, then
// exits with a code that means something. A green CI step does not necessarily
// do anything; this is what makes it do something.

use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use specta::Type;
use tauri::{Manager, State};

/// The order means something: a later signal cannot arrive unless the one before
/// it did.
///
///   1. `webview-loaded`  — the page loaded, the bundle ran, React mounted
///   2. `ipc-roundtrip`   — Rust's answer reached the screen and went back again
///   3. `data-roundtrip`  — data was written to SQLite and read back intact
const CORE_SIGNALS: [&str; 3] = ["webview-loaded", "ipc-roundtrip", "data-roundtrip"];

/// A fourth signal, only required when CI deliberately runs the application
/// without an engine binary. The Phase 2 gate asks for it explicitly: run
/// without the engine binary, and make sure the message is right.
///
/// It is kept separate because OpenCode is 176 MB and is not in the repository.
/// Testing its *absence* needs no download at all — so this part of the gate can
/// run on every CI round, on all three platforms, for nothing.
const SIGNAL_ENGINE_ABSENT: &str = "engine-absent-correct";

/// A fifth signal, required when CI launches the application with a deep link and
/// says which grant should arrive.
///
/// URL scheme registration was never covered by CI in Rantai at all — the three
/// green signals there only exercised the webview, React, the bridge and IPC.
/// This is the highest-uncertainty part of the whole sign-in, so it is tested
/// here rather than discovered broken later.
const SIGNAL_DEEP_LINK: &str = "deep-link-received";

/// A sixth signal. Release 1 promises a conversation is "saved in SQLite and can
/// be reopened" — and that is only provable by running the application twice:
/// once to write, once to read after the process has genuinely died.
///
/// A test inside one process proves nothing about it. It can pass entirely from
/// an in-memory cache without a single byte ever touching disk.
const SIGNAL_PERSISTENCE: &str = "data-persisted";

const DEFAULT_TIMEOUT_MS: u64 = 120_000;

/// When this is on, the application is run with RANTAI_OPENCODE deliberately
/// pointing at nothing, and the interface must prove the message is right.
pub fn expects_engine_absent() -> bool {
    std::env::var("RANTAI_SMOKE_ENGINE_ABSENT").is_ok_and(|v| v == "1")
}

/// The grant that should arrive through a deep link, if CI asks for one.
pub fn expected_deep_link() -> Option<String> {
    std::env::var("RANTAI_SMOKE_DEEP_LINK")
        .ok()
        .filter(|v| !v.is_empty())
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceCheck {
    /// "write" on the first run, "read" on the second.
    pub mode: String,
    /// The same marker on both runs, so what is looked for is exactly what was
    /// written.
    pub marker: String,
}

fn persistence_check() -> Option<PersistenceCheck> {
    let mode = std::env::var("RANTAI_SMOKE_PERSIST").ok()?;
    if mode != "write" && mode != "read" {
        return None;
    }
    let marker = std::env::var("RANTAI_SMOKE_PERSIST_MARKER").ok()?;
    if marker.is_empty() {
        return None;
    }
    Some(PersistenceCheck { mode, marker })
}

fn required_signals() -> Vec<&'static str> {
    let mut signals = CORE_SIGNALS.to_vec();
    if expects_engine_absent() {
        signals.push(SIGNAL_ENGINE_ABSENT);
    }
    if expected_deep_link().is_some() {
        signals.push(SIGNAL_DEEP_LINK);
    }
    if persistence_check().is_some() {
        signals.push(SIGNAL_PERSISTENCE);
    }
    signals
}

/// Told to the interface so it knows which checks to run. Without this the
/// interface would have to guess — and guessing on a failure path is exactly how
/// a test becomes flawed without anyone noticing.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SmokeExpectations {
    pub enabled: bool,
    pub engine_absent: bool,
    /// When set, the interface must prove this grant is the one that arrived by
    /// deep link.
    pub deep_link: Option<String>,
    /// When set, the interface must write or read data under this marker.
    pub persistence: Option<PersistenceCheck>,
}

#[tauri::command]
#[specta::specta]
pub fn smoke_expectations() -> SmokeExpectations {
    SmokeExpectations {
        enabled: enabled(),
        engine_absent: expects_engine_absent(),
        deep_link: expected_deep_link(),
        persistence: persistence_check(),
    }
}

/// Where signals are collected. Outside smoke mode it merely fills up and is
/// ignored; it costs nothing, and its presence keeps the path CI exercises
/// identical to the one used every day.
#[derive(Default)]
pub struct Board {
    seen: Mutex<Vec<String>>,
    changed: Condvar,
}

impl Board {
    fn record(&self, name: &str) {
        let mut seen = self.seen.lock().expect("signal board poisoned");
        if !seen.iter().any(|s| s == name) {
            seen.push(name.to_string());
        }
        self.changed.notify_all();
    }
}

#[tauri::command]
#[specta::specta]
pub fn report_signal(name: String, board: State<'_, Board>) -> Result<(), String> {
    if !required_signals().contains(&name.as_str()) {
        return Err(format!("unknown signal: {name}"));
    }
    board.record(&name);
    Ok(())
}

#[derive(Serialize, Type)]
struct Report {
    passed: bool,
    required: Vec<&'static str>,
    received: Vec<String>,
    missing: Vec<&'static str>,
    seconds: f64,
    platform: &'static str,
    arch: &'static str,
}

pub fn enabled() -> bool {
    std::env::var("RANTAI_SMOKE").is_ok_and(|v| v == "1")
}

fn timeout() -> Duration {
    let ms = std::env::var("RANTAI_SMOKE_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    Duration::from_millis(ms)
}

fn report_path() -> PathBuf {
    std::env::var("RANTAI_SMOKE_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("rantai-smoke.json"))
}

/// Stops the engine before the process ends. Called on every exit path the
/// watchdog takes — passing and failing alike.
fn stop_engine_first(handle: &tauri::AppHandle) {
    let engine = handle.state::<crate::engine::Engine>();
    if let Err(e) = tauri::async_runtime::block_on(engine.stop()) {
        eprintln!("smoke: could not stop the engine on exit: {e}");
    }
}

pub fn watch(handle: tauri::AppHandle) {
    let timeout = timeout();
    let destination = report_path();

    std::thread::spawn(move || {
        let board = handle.state::<Board>();
        let started = Instant::now();

        let required = required_signals();
        let mut seen = board.seen.lock().expect("signal board poisoned");
        while !required.iter().all(|s| seen.iter().any(|t| t == s)) {
            let left = match timeout.checked_sub(started.elapsed()) {
                Some(left) if !left.is_zero() => left,
                _ => break,
            };
            let (next, _) = board
                .changed
                .wait_timeout(seen, left)
                .expect("signal board poisoned");
            seen = next;
        }
        let received: Vec<String> = seen.clone();
        drop(seen);

        let missing: Vec<&'static str> = required
            .iter()
            .copied()
            .filter(|s| !received.iter().any(|t| t == s))
            .collect();

        let report = Report {
            passed: missing.is_empty(),
            required: required.clone(),
            received,
            missing: missing.clone(),
            seconds: started.elapsed().as_secs_f64(),
            platform: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        };

        let text = serde_json::to_string_pretty(&report)
            .unwrap_or_else(|e| format!("{{\"error\":\"could not write the report: {e}\"}}"));

        if let Some(parent) = destination.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("smoke: could not create {}: {e}", parent.display());
            }
        }
        if let Err(e) = std::fs::write(&destination, &text) {
            eprintln!("smoke: could not write {}: {e}", destination.display());
        }

        // std::process::exit does not run destructors, so `kill_on_drop` on the
        // child process never fires. Without this line, every exit from smoke
        // mode leaves OpenCode alive and adopted by init — found by listing
        // processes after a run, not by reading the code.
        stop_engine_first(&handle);

        if report.passed {
            eprintln!(
                "smoke: passed — every signal arrived within {:.1}s",
                report.seconds
            );
            std::process::exit(0);
        }

        // Name what never arrived, not merely that something failed.
        eprintln!(
            "smoke: failed after {:.1}s — signals that never arrived: {}",
            report.seconds,
            missing.join(", ")
        );
        eprintln!("{text}");
        std::process::exit(1);
    });
}
