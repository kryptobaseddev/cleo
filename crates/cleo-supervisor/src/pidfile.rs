// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! Atomic pidfile with stale-pid detection.
//!
//! Mirrors the advisory-lock semantics of `acquireLock`/`releaseLock` in
//! `packages/core/src/sentient/daemon.ts`, but uses the supervisor's own
//! atomic-write discipline:
//!
//!   * The pidfile is written via the **tmp-then-rename** pattern (write a
//!     uniquely-named sibling temp file, fsync, then `rename` over the target).
//!     `rename` is atomic on the same filesystem, so a reader never observes a
//!     half-written pidfile.
//!   * On startup, if a pidfile already exists and the recorded pid belongs to
//!     a **live** process, acquisition fails (double-launch refused). If the
//!     recorded pid is dead, the stale pidfile is reclaimed.
//!
//! The pidfile holds a single decimal pid followed by a newline. That is the
//! same minimal format the TS lock uses (`String(process.pid)`), so external
//! tooling can read either interchangeably.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::process;

/// Error raised when a pidfile cannot be acquired.
#[derive(Debug, thiserror::Error)]
pub enum PidfileError {
    /// Another supervisor is already running (the recorded pid is alive).
    #[error("another cleo-supervisor is already running (pid {pid}) — refusing double-launch")]
    AlreadyRunning {
        /// The live pid that currently owns the pidfile.
        pid: u32,
    },
    /// An underlying filesystem error occurred.
    #[error("pidfile I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// A held pidfile. Dropping the guard removes the pidfile from disk.
///
/// The guard owns the resolved path; [`Pidfile::release`] (or `Drop`) deletes
/// it. We deliberately delete on release — unlike the TS lock which keeps the
/// pid for diagnostics — because a supervisor pidfile that outlives the process
/// is precisely the stale state the next launch has to reclaim, and a clean
/// shutdown should leave no trace.
#[derive(Debug)]
pub struct Pidfile {
    path: PathBuf,
    pid: u32,
}

impl Pidfile {
    /// Acquire the pidfile at `path` for the current process.
    ///
    /// Creates the parent directory if necessary, refuses to start when a live
    /// process already owns the pidfile, and otherwise atomically writes this
    /// process's pid.
    ///
    /// # Errors
    ///
    /// Returns [`PidfileError::AlreadyRunning`] when a live supervisor holds the
    /// pidfile, or [`PidfileError::Io`] on filesystem failure.
    pub fn acquire(path: impl AsRef<Path>) -> Result<Self, PidfileError> {
        Self::acquire_for(path, process::current_pid())
    }

    /// Acquire the pidfile recording an explicit pid. Exposed for tests so a
    /// known-dead pid can be simulated without spawning a real process.
    ///
    /// # Errors
    ///
    /// See [`Pidfile::acquire`].
    pub fn acquire_for(path: impl AsRef<Path>, pid: u32) -> Result<Self, PidfileError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        // If a pidfile exists, decide whether to refuse or reclaim it.
        if let Some(existing) = read_pid(&path)?
            && process::is_alive(existing)
        {
            return Err(PidfileError::AlreadyRunning { pid: existing });
        }

        write_atomic(&path, pid)?;
        Ok(Self { path, pid })
    }

    /// The pid recorded in this pidfile.
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// The on-disk path of this pidfile.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Explicitly release the pidfile, removing it from disk.
    ///
    /// Equivalent to dropping the guard, but lets callers handle the I/O error
    /// (Drop swallows it).
    ///
    /// # Errors
    ///
    /// Returns the underlying filesystem error if removal fails for a reason
    /// other than the file already being absent.
    pub fn release(self) -> std::io::Result<()> {
        let path = self.path.clone();
        std::mem::forget(self); // prevent Drop double-remove
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

impl Drop for Pidfile {
    fn drop(&mut self) {
        // Best-effort cleanup; nothing actionable if it fails during teardown.
        let _ = fs::remove_file(&self.path);
    }
}

/// Read the pid recorded in a pidfile, if any.
///
/// Returns `Ok(None)` when the file is absent or does not contain a parseable
/// pid (a corrupt pidfile is treated as reclaimable, not fatal).
///
/// # Errors
///
/// Returns an error only for unexpected I/O failures other than "not found".
pub fn read_pid(path: &Path) -> std::io::Result<Option<u32>> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(contents.trim().parse::<u32>().ok().filter(|p| *p > 0)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Atomically write `pid` to `path` using the tmp-then-rename pattern.
fn write_atomic(path: &Path, pid: u32) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    // Unique temp name in the same directory so `rename` stays on one
    // filesystem and is therefore atomic.
    let tmp_name = format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("cleo-supervisor.pid"),
        pid
    );
    let tmp_path = parent.join(tmp_name);

    {
        let mut f = File::create(&tmp_path)?;
        writeln!(f, "{pid}")?;
        f.flush()?;
        // Durability: fsync the file so the rename can't expose empty content
        // after a crash. Failure here is non-fatal for correctness of the
        // rename itself, so it is intentionally surfaced.
        f.sync_all()?;
    }

    // Atomic replace.
    match fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn acquire_writes_pid_atomically() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("cleo-supervisor.pid");
        let guard = Pidfile::acquire(&path).expect("acquire");
        assert!(path.exists());
        let recorded = read_pid(&path).expect("read").expect("pid present");
        assert_eq!(recorded, guard.pid());
        // No stray temp files left behind.
        let leftover: Vec<_> = fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftover.is_empty(), "temp file should be renamed away");
    }

    #[test]
    fn release_removes_pidfile() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("cleo-supervisor.pid");
        let guard = Pidfile::acquire(&path).expect("acquire");
        guard.release().expect("release");
        assert!(!path.exists());
    }

    #[test]
    fn drop_removes_pidfile() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("cleo-supervisor.pid");
        {
            let _guard = Pidfile::acquire(&path).expect("acquire");
            assert!(path.exists());
        }
        assert!(!path.exists());
    }

    #[test]
    fn live_pid_refuses_double_launch() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("cleo-supervisor.pid");
        // Record THIS process's pid (definitely alive) then try to re-acquire.
        let live = process::current_pid();
        write_atomic(&path, live).expect("seed live pid");
        let err = Pidfile::acquire(&path).expect_err("should refuse");
        match err {
            PidfileError::AlreadyRunning { pid } => assert_eq!(pid, live),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn stale_pid_is_reclaimed() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("cleo-supervisor.pid");
        // A pid that is almost certainly dead. is_alive() must return false.
        let dead = pick_dead_pid();
        write_atomic(&path, dead).expect("seed dead pid");
        let guard = Pidfile::acquire(&path).expect("should reclaim stale");
        assert_ne!(guard.pid(), dead);
        assert_eq!(guard.pid(), process::current_pid());
    }

    #[test]
    fn corrupt_pidfile_is_reclaimed() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("cleo-supervisor.pid");
        fs::write(&path, "not-a-pid\n").expect("seed corrupt");
        assert!(read_pid(&path).expect("read").is_none());
        let guard = Pidfile::acquire(&path).expect("should reclaim corrupt");
        assert_eq!(guard.pid(), process::current_pid());
    }

    /// Find a pid that is not currently alive so stale-reclaim can be tested
    /// deterministically.
    fn pick_dead_pid() -> u32 {
        for candidate in (2u32..100_000).rev() {
            if !process::is_alive(candidate) {
                return candidate;
            }
        }
        // Extremely unlikely fallback.
        u32::MAX - 1
    }
}
