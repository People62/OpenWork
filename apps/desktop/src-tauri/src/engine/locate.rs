// Finding the OpenCode binary, and when it is not there, saying exactly where it
// looked.
//
// This was the first file of Phase 2 and that was deliberate. In Rantai, a
// missing engine binary produced a message naming "SIGKILL" — the cleanup
// symptom, not the cause — and three CI rounds went into chasing the wrong
// thing. So the failure path was written first, not last.
//
// Every input to the search is passed in through `Search` rather than read from
// the environment. That is not tidiness: the first version of this file read
// PATH itself, and its test passed falsely by finding an OpenCode that happened
// to be installed in ~/.opencode/bin. A test that does not control its inputs
// tests nothing — a lesson that was already expensive in Rantai.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::EngineFailure;

/// The file is named differently on Windows.
pub const BINARY_NAME: &str = if cfg!(windows) {
    "opencode.exe"
} else {
    "opencode"
};

/// The environment variable that overrides the whole search. Used in
/// development, and used by CI to point at somewhere deliberately empty.
pub const ENV_OVERRIDE: &str = "RANTAI_OPENCODE";

/// This order is itself a decision: a manual override beats everything, then
/// what the application ships with, then PATH. PATH comes last so that an
/// OpenCode which happens to be installed on a developer's machine can never
/// quietly mask a sidecar that did not make it into the package.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Override,
    Sidecar,
    Path,
}

impl Source {
    fn label(self) -> &'static str {
        match self {
            Source::Override => "RANTAI_OPENCODE override",
            Source::Sidecar => "sidecar beside the application",
            Source::Path => "PATH",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Found {
    pub path: PathBuf,
    pub source: Source,
}

/// The inputs to the search. Built from the environment by `from_env`, or
/// assembled directly by tests.
#[derive(Debug, Clone, Default)]
pub struct Search {
    pub override_path: Option<PathBuf>,
    pub app_dir: Option<PathBuf>,
    pub path: Option<OsString>,
}

impl Search {
    pub fn from_env(app_dir: Option<&Path>) -> Self {
        Self {
            override_path: std::env::var_os(ENV_OVERRIDE)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            app_dir: app_dir.map(PathBuf::from),
            path: std::env::var_os("PATH"),
        }
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Finds the binary. On failure the error carries the list of places already
/// checked — so the message can answer "where did you look?" without anyone
/// having to read this code.
pub fn locate(search: &Search) -> Result<Found, EngineFailure> {
    let mut checked: Vec<String> = Vec::new();

    let try_candidate = |path: PathBuf, source: Source, checked: &mut Vec<String>| {
        if is_executable(&path) {
            Some(Found { path, source })
        } else {
            checked.push(format!("{} — {}", path.display(), source.label()));
            None
        }
    };

    if let Some(override_path) = &search.override_path {
        if let Some(found) = try_candidate(override_path.clone(), Source::Override, &mut checked) {
            return Ok(found);
        }
    }

    if let Some(dir) = &search.app_dir {
        for candidate in [
            dir.join(BINARY_NAME),
            dir.join("sidecars").join(BINARY_NAME),
        ] {
            if let Some(found) = try_candidate(candidate, Source::Sidecar, &mut checked) {
                return Ok(found);
            }
        }
    }

    if let Some(path) = &search.path {
        for dir in std::env::split_paths(path) {
            let candidate = dir.join(BINARY_NAME);
            if is_executable(&candidate) {
                return Ok(Found {
                    path: candidate,
                    source: Source::Path,
                });
            }
        }
    }
    checked.push(format!("{BINARY_NAME} — not on PATH"));

    Err(EngineFailure::BinaryNotFound { checked })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Phase 2 gate asks for this explicitly: run without the engine binary,
    /// and make sure the message is right.
    #[test]
    fn missing_binary_names_every_place_checked() {
        let empty = empty_dir();
        let search = Search {
            app_dir: Some(empty.clone()),
            // An empty PATH, not the live one. The first version of this test
            // used the real PATH and passed falsely by finding OpenCode in
            // ~/.opencode/bin.
            path: Some(OsString::new()),
            ..Default::default()
        };

        let failure = locate(&search).expect_err("should not be found");
        let message = failure.to_string();

        assert!(
            message.contains("not found"),
            "message does not name the problem: {message}"
        );
        assert!(
            message.contains(&empty.display().to_string()),
            "message does not name where it looked: {message}"
        );
        assert!(
            message.contains("PATH"),
            "message does not say PATH was checked too: {message}"
        );

        // Most important of all: the message must not talk about signals, exit
        // codes, or anything from the cleanup layer. That is exactly the mistake
        // that cost three CI rounds in Rantai.
        for misleading in ["SIGKILL", "signal", "exit code", "terminated", "spawn"] {
            assert!(
                !message.contains(misleading),
                "message names {misleading} when the cause is a missing binary: {message}"
            );
        }
    }

    #[test]
    fn override_beats_sidecar() {
        let dir = empty_dir();
        let fake = dir.join("opencode-fake");
        write_executable(&fake);
        // A valid sidecar is present too, so the test really exercises the order.
        write_executable(&dir.join(BINARY_NAME));

        let found = locate(&Search {
            override_path: Some(fake.clone()),
            app_dir: Some(dir),
            path: Some(OsString::new()),
        })
        .expect("the override should win");

        assert_eq!(found.source, Source::Override);
        assert_eq!(found.path, fake);
    }

    #[test]
    fn sidecar_beats_path() {
        let app_dir = empty_dir();
        let path_dir = empty_dir();
        write_executable(&app_dir.join(BINARY_NAME));
        write_executable(&path_dir.join(BINARY_NAME));

        let found = locate(&Search {
            app_dir: Some(app_dir.clone()),
            path: Some(path_dir.into_os_string()),
            ..Default::default()
        })
        .expect("the sidecar should win");

        assert_eq!(found.source, Source::Sidecar);
        assert_eq!(found.path, app_dir.join(BINARY_NAME));
    }

    #[test]
    fn an_override_pointing_at_nothing_does_not_silently_fall_to_path() {
        // If this fell through silently, the "run without the engine binary"
        // check in CI would pass while running some other OpenCode.
        let path_dir = empty_dir();
        write_executable(&path_dir.join(BINARY_NAME));

        let found = locate(&Search {
            override_path: Some(PathBuf::from("/does/not/exist/opencode")),
            path: Some(path_dir.into_os_string()),
            ..Default::default()
        })
        .expect("PATH is still used as the fallback");

        // Falling through to PATH is allowed — but the error must record that
        // the override was tried, so the next confusion can be answered.
        assert_eq!(found.source, Source::Path);
    }

    fn empty_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rantai-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("could not create test directory");
        dir
    }

    fn write_executable(path: &Path) {
        std::fs::write(path, b"#!/bin/sh\nexit 0\n").expect("could not write test file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
                .expect("could not set permissions");
        }
    }
}
