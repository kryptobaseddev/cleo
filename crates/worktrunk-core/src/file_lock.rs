// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Exclusive OS advisory lock held on an open file descriptor (T14491).
//!
//! The lock is taken with [`std::fs::File::try_lock`] (`flock(LOCK_EX |
//! LOCK_NB)` on Unix, `LockFileEx` on Windows). It belongs to the open file,
//! not to a path, so the OS drops it when the descriptor closes, including
//! when the holding process dies. No liveness probe, no stale-break and no
//! compare-and-delete of a path is ever needed: a crashed holder frees the
//! lock by exiting.
//!
//! Rust opens files close-on-exec (non-inheritable on Windows), so a child
//! process the holder spawns never keeps the lock alive after the holder.
//!
//! The lock file itself is never deleted: unlinking a lock file while another
//! process holds or is opening it would let two holders lock two different
//! inodes under one path.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

/// An exclusive advisory lock on an open file. Dropping it (or the process
/// exiting) releases the lock.
#[derive(Debug)]
pub struct FileLock {
    file: File,
}

impl FileLock {
    /// Release the lock now (dropping the value does the same).
    ///
    /// # Errors
    ///
    /// Returns the OS error from unlocking; the descriptor is closed either
    /// way, which also releases the lock.
    pub fn release(self) -> io::Result<()> {
        self.file.unlock()
    }
}

/// Try to take an exclusive lock on `path` without blocking, creating the
/// file when it does not exist (its content is never read or written).
///
/// # Errors
///
/// Returns the OS error when the file cannot be opened or the lock call
/// fails for a reason other than "held by someone else" (for example a
/// filesystem without advisory locks). Callers must treat that as a refusal.
///
/// # Returns
///
/// `Ok(Some(lock))` when this call now holds the lock, `Ok(None)` when another
/// open file (in this or any other process) holds it.
pub fn try_lock_exclusive(path: &Path) -> io::Result<Option<FileLock>> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(FileLock { file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(err)) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_open_file_is_refused_until_the_first_releases() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("t.lock.flock");
        let first = try_lock_exclusive(&path)?;
        assert!(first.is_some(), "first lock must be taken");
        assert!(
            try_lock_exclusive(&path)?.is_none(),
            "second open file must be refused"
        );
        if let Some(lock) = first {
            lock.release()?;
        }
        assert!(try_lock_exclusive(&path)?.is_some(), "free after release");
        Ok(())
    }

    #[test]
    fn dropping_the_lock_releases_it() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("t.lock.flock");
        {
            let held = try_lock_exclusive(&path)?;
            assert!(held.is_some());
        }
        assert!(try_lock_exclusive(&path)?.is_some(), "free after drop");
        Ok(())
    }

    #[test]
    fn missing_parent_directory_is_an_error_not_a_hold() {
        let path = Path::new("/nonexistent-dir-t14491/x.lock.flock");
        assert!(try_lock_exclusive(path).is_err());
    }
}
