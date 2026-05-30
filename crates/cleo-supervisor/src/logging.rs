// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! Rolling-file logging for the supervisor (T11338 AC4).
//!
//! Uses `tracing-appender`'s daily-rolling file appender writing under the
//! canonical CLEO log directory (`<cleo_home>/logs`, see [`crate::paths`]). The
//! appender names files `cleo-supervisor.log.<YYYY-MM-DD>`; a new file rolls in
//! at each UTC day boundary, so the directory accumulates one file per active
//! day. The non-blocking writer keeps a [`WorkerGuard`] alive for the process
//! lifetime — dropping the guard flushes buffered lines.

use std::path::{Path, PathBuf};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::EnvFilter;

/// Log filename prefix for the supervisor's rolling appender.
pub const LOG_FILE_PREFIX: &str = "cleo-supervisor.log";

/// Initialized logging handles. Holding [`LogHandle::guard`] for the process
/// lifetime is required — when it drops, buffered log lines are flushed.
#[derive(Debug)]
pub struct LogHandle {
    /// Keeps the non-blocking writer worker alive; drop flushes.
    guard: WorkerGuard,
    /// The directory the appender writes into.
    log_dir: PathBuf,
}

impl LogHandle {
    /// The directory rolled log files are written to.
    #[must_use]
    pub fn log_dir(&self) -> &Path {
        &self.log_dir
    }

    /// Consume the handle, returning the guard so a caller can own the flush
    /// lifetime explicitly (e.g. store it on the supervisor struct).
    pub fn into_guard(self) -> WorkerGuard {
        self.guard
    }
}

/// Build a daily-rolling, non-blocking file appender for `log_dir`.
///
/// Separated from subscriber installation so tests can drive the appender
/// directly and assert a rolled file appears without registering a global
/// subscriber (which can only be set once per process).
///
/// # Errors
///
/// Returns an error if `log_dir` cannot be created.
pub fn build_appender(
    log_dir: &Path,
) -> std::io::Result<(tracing_appender::non_blocking::NonBlocking, WorkerGuard)> {
    std::fs::create_dir_all(log_dir)?;
    let file_appender =
        RollingFileAppender::new(Rotation::DAILY, log_dir, LOG_FILE_PREFIX);
    Ok(tracing_appender::non_blocking(file_appender))
}

/// Initialize the global tracing subscriber writing to a rolling file under
/// `log_dir`, plus stderr.
///
/// Returns a [`LogHandle`] whose guard must be retained for the process
/// lifetime. The log level honours the `RUST_LOG` / `CLEO_LOG` env filter,
/// defaulting to `info`.
///
/// # Errors
///
/// Returns an error if the log directory cannot be created. Subscriber
/// registration failure (already-set global) is reported as an error too.
pub fn init(log_dir: &Path) -> anyhow::Result<LogHandle> {
    let (non_blocking, guard) = build_appender(log_dir)?;

    let filter = EnvFilter::try_from_env("CLEO_LOG")
        .or_else(|_| EnvFilter::try_from_default_env())
        .unwrap_or_else(|_| EnvFilter::new("info"));

    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let file_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(non_blocking);

    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .try_init()
        .map_err(|e| anyhow::anyhow!("failed to install tracing subscriber: {e}"))?;

    Ok(LogHandle {
        guard,
        log_dir: log_dir.to_path_buf(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;
    use tracing_appender::non_blocking::NonBlocking;

    #[test]
    fn appender_creates_a_rolled_file() {
        let dir = tempdir().expect("tempdir");
        let log_dir = dir.path().join("logs");
        let (mut writer, guard): (NonBlocking, WorkerGuard) =
            build_appender(&log_dir).expect("build appender");

        // Write a line, then drop the guard to force a flush.
        writeln!(writer, "supervisor smoke line").expect("write");
        drop(writer);
        drop(guard);

        // A rolled file with the prefix must now exist.
        let mut found = false;
        // The non-blocking worker flushes asynchronously; give it a brief,
        // bounded window to land the file.
        for _ in 0..50 {
            if let Ok(entries) = std::fs::read_dir(&log_dir) {
                for entry in entries.flatten() {
                    if entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(LOG_FILE_PREFIX)
                    {
                        found = true;
                        break;
                    }
                }
            }
            if found {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(found, "a rolled cleo-supervisor.log.* file should appear in {log_dir:?}");
    }
}
