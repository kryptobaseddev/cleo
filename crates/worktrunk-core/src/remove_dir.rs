// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Recursive parallel directory removal with optional progress reporting.
//!
//! Pure-Rust SDK extraction of worktrunk's `src/remove_dir.rs` per the T10221
//! refactor (ADR-078 separation-of-concerns contract). Walks the tree
//! iteratively (no recursion),
//! unlinks files in parallel via a capped rayon pool, then removes the now-empty
//! directories deepest-first. Each unlinked leaf bumps a [`Progress`] counter so
//! a TTY spinner can render live updates; the returned `(files, bytes)` tuple
//! drives the matching post-op summary.
//!
//! Best-effort by design: this is the trash-cleanup phase that runs *after* a
//! worktree has already been pruned from git's metadata, so a partial cleanup
//! leaves the user with a stale directory under `.git/wt/trash/` —
//! recoverable, not catastrophic. read/unlink/rmdir errors are swallowed so the
//! caller can always report the count of leaves we did manage to remove.
//!
//! Parallel unlink runs on a dedicated 4-thread pool — file removal is
//! filesystem latency, not CPU, so a small pool gives most of the speedup
//! without the per-process thread cost of rayon's default `2× CPU cores`
//! global pool (which adds up across many subprocesses in test runs).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use rayon::prelude::*;

use crate::progress::Progress;

/// Capped at 4 threads — same reasoning as the copy pool (filesystem I/O,
/// don't oversubscribe CPU when many subprocesses run in parallel).
///
/// `LazyLock` initializers cannot return errors. On the (unreachable in
/// practice) path where `ThreadPoolBuilder::build` fails — the OS has refused
/// to spawn a thread — we fall back to single-threaded execution. If both
/// attempts fail the host is unusable; we panic with a descriptive message,
/// matching the [`crate::copy`] pool policy.
static REMOVE_POOL: LazyLock<rayon::ThreadPool> = LazyLock::new(build_remove_pool);

#[allow(clippy::panic)]
fn build_remove_pool() -> rayon::ThreadPool {
    if let Ok(pool) = rayon::ThreadPoolBuilder::new().num_threads(4).build() {
        return pool;
    }
    if let Ok(pool) = rayon::ThreadPoolBuilder::new().num_threads(1).build() {
        return pool;
    }
    panic!("worktrunk-core: rayon refuses to build any thread pool — host unusable");
}

/// Remove a directory tree, reporting per-file progress.
///
/// Returns `(files_removed, bytes_removed)`. Bytes use `symlink_metadata`, so
/// symlinks count as their own size, not the target's. Any I/O errors are
/// silently skipped — a leaf that can't be unlinked is simply not counted.
///
/// Callers that don't want progress should pass [`Progress::disabled`] —
/// every `record` call is a zero-cost no-op.
#[must_use]
pub fn remove_dir_with_progress(path: &Path, progress: &Progress) -> (usize, u64) {
    let mut leaves: Vec<PathBuf> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut stack = vec![path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        // read_dir failure (NotFound, EACCES, anything else) -> skip this
        // subtree. We still try to rmdir it later in case it's actually empty.
        let Ok(entries) = fs::read_dir(&dir) else {
            dirs.push(dir);
            continue;
        };
        // Push parents first; we'll reverse before rmdir so children unlink first.
        dirs.push(dir);
        for entry in entries.flatten() {
            // entry.file_type() is an lstat on Unix - symlinks report
            // is_dir() == false and fall through to the leaf branch, which
            // is what we want (unlink the link, not the target).
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let entry_path = entry.path();
            if file_type.is_dir() {
                stack.push(entry_path);
            } else {
                leaves.push(entry_path);
            }
        }
    }

    let removed_files = AtomicUsize::new(0);
    let removed_bytes = AtomicU64::new(0);
    REMOVE_POOL.install(|| {
        leaves.par_iter().for_each(|leaf| {
            // Capture size before unlinking. Best-effort: symlink_metadata may
            // fail on a racy delete, in which case we still try to unlink and
            // count the leaf with zero bytes.
            let bytes = leaf.symlink_metadata().map(|m| m.len()).unwrap_or(0);
            if fs::remove_file(leaf).is_ok() {
                removed_files.fetch_add(1, Ordering::Relaxed);
                removed_bytes.fetch_add(bytes, Ordering::Relaxed);
                progress.record(bytes);
            }
        });
    });

    // Pop order pushed parents before children, so reversing gives
    // deepest-first - exactly what rmdir needs.
    for dir in dirs.iter().rev() {
        let _ = fs::remove_dir(dir);
    }

    (removed_files.into_inner(), removed_bytes.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_dir_with_progress_empty_dir() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("empty");
        std::fs::create_dir(&dir).unwrap();

        let (files, bytes) = remove_dir_with_progress(&dir, &Progress::disabled());

        assert_eq!(files, 0);
        assert_eq!(bytes, 0);
        assert!(!dir.exists());
    }

    #[test]
    fn remove_dir_with_progress_counts_files_and_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("tree");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/file1.txt"), b"hello").unwrap(); // 5 bytes
        std::fs::write(root.join("a/b/file2.txt"), b"world!").unwrap(); // 6 bytes
        std::fs::write(root.join("top.txt"), b"x").unwrap(); // 1 byte

        let (files, bytes) = remove_dir_with_progress(&root, &Progress::disabled());

        assert_eq!(files, 3);
        assert_eq!(bytes, 12);
        assert!(!root.exists());
    }

    #[test]
    fn remove_dir_with_progress_missing_root_is_ok() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("does-not-exist");

        let (files, bytes) = remove_dir_with_progress(&missing, &Progress::disabled());

        assert_eq!(files, 0);
        assert_eq!(bytes, 0);
    }

    #[test]
    fn remove_dir_with_progress_records_into_counting_progress() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("tree");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a"), b"abc").unwrap();
        std::fs::write(root.join("b"), b"defg").unwrap();

        let progress = Progress::counting();
        let (files, bytes) = remove_dir_with_progress(&root, &progress);

        assert_eq!(files, 2);
        assert_eq!(bytes, 7);
        let (p_files, p_bytes) = progress.snapshot();
        assert_eq!(p_files, 2, "Progress::record should fire per leaf");
        assert_eq!(p_bytes, 7, "Progress should aggregate byte counts");
    }

    #[cfg(unix)]
    #[test]
    fn remove_dir_with_progress_handles_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("tree");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("real.txt"), b"abc").unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("link")).unwrap();

        let (files, _bytes) = remove_dir_with_progress(&root, &Progress::disabled());

        // 1 file + 1 symlink = 2 leaves removed; the symlink is unlinked
        // without following.
        assert_eq!(files, 2);
        assert!(!root.exists());
    }

    /// Cover the read_dir-fails path. Permission-denied is the realistic
    /// non-NotFound failure; the function should silently skip the subtree
    /// and still rmdir what it can. Skipped when running as root (the kernel
    /// ignores mode-0 directories for euid 0).
    #[cfg(unix)]
    #[test]
    fn remove_dir_with_progress_skips_unreadable_subtree() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("tree");
        let blocked = root.join("blocked");
        std::fs::create_dir_all(&blocked).unwrap();
        std::fs::write(blocked.join("hidden.txt"), b"x").unwrap();
        // Make blocked unreadable. Also blocks rmdir of blocked itself, but
        // that's fine - we want to exercise the read_dir error branch and
        // verify the function returns gracefully.
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();

        // Skip if running as root: euid 0 ignores DAC mode bits, so the
        // walk would succeed and unlink hidden.txt. Probe via a read attempt.
        if std::fs::read_dir(&blocked).is_ok() {
            std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o755)).ok();
            eprintln!("Skipping - running with elevated privileges");
            return;
        }

        let (files, bytes) = remove_dir_with_progress(&root, &Progress::disabled());

        // Restore so the tempdir's Drop can clean up.
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o755)).ok();

        assert_eq!(files, 0, "no leaves should be unlinked when blocked");
        assert_eq!(bytes, 0);
    }
}
