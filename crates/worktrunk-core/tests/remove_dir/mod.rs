// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Parity tests for `worktrunk_core::remove_dir::remove_dir_with_progress`.
//!
//! Donor `wt step prune` invokes `remove_dir_with_progress` after `git
//! worktree remove --force` for the `.git/wt/trash/` cleanup. The donor's CLI
//! does not expose `remove_dir` as a top-level subcommand, so binary parity
//! reduces to "the SDK function removes the same set of files the donor's
//! function would have, given identical input trees".
//!
//! Since the donor and SDK share the SAME algorithm by extraction (T10221),
//! we test the SDK invariants directly. Any divergence would be caught by
//! the donor's own unit suite (which the extraction preserved).

use std::fs;
use std::path::Path;

use tempfile::TempDir;

use worktrunk_core::Progress;
use worktrunk_core::remove_dir::remove_dir_with_progress;

fn write_tree(root: &Path) -> (usize, u64) {
    // Builds a deterministic fixture: 3 top-level files + 2 subtrees, one
    // shallow, one deep. Returns (file_count, byte_count) so the test can
    // cross-check.
    let plan: &[(&str, &str)] = &[
        ("a.txt", "alpha"),
        ("b.txt", "beta-content"),
        ("c.txt", "gamma!"),
        ("sub/inner.txt", "inner data"),
        ("sub/deep/leaf.txt", "deepest"),
        ("sub/deep/sibling.txt", "next to deepest"),
    ];
    let mut files = 0usize;
    let mut bytes = 0u64;
    for (rel, body) in plan {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, body).unwrap();
        files += 1;
        bytes += body.len() as u64;
    }
    (files, bytes)
}

#[test]
fn removes_full_tree_reporting_correct_counts() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("doomed");
    fs::create_dir_all(&root).unwrap();
    let (expected_files, expected_bytes) = write_tree(&root);

    let progress = Progress::counting();
    let (files, bytes) = remove_dir_with_progress(&root, &progress);

    assert_eq!(files, expected_files, "file count mismatch");
    assert_eq!(bytes, expected_bytes, "byte count mismatch");
    assert!(!root.exists(), "root dir should be gone");

    let (snap_files, _) = progress.snapshot();
    assert_eq!(
        snap_files, expected_files,
        "progress counter should match returned file count"
    );
}

#[test]
fn missing_root_is_zero() {
    let tmp = TempDir::new().unwrap();
    let progress = Progress::disabled();
    let (files, bytes) = remove_dir_with_progress(&tmp.path().join("never-existed"), &progress);
    assert_eq!(files, 0);
    assert_eq!(bytes, 0);
}

#[test]
fn empty_dir_removes_cleanly() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("empty");
    fs::create_dir_all(&root).unwrap();
    let progress = Progress::disabled();
    let (files, bytes) = remove_dir_with_progress(&root, &progress);
    assert_eq!(files, 0);
    assert_eq!(bytes, 0);
    assert!(!root.exists());
}

#[test]
#[cfg(unix)]
fn symlinks_count_by_link_metadata_not_target() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("with-links");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("real.txt"), "5-bytes").unwrap();
    std::os::unix::fs::symlink("real.txt", root.join("link.txt")).unwrap();

    let progress = Progress::disabled();
    let (files, _bytes) = remove_dir_with_progress(&root, &progress);
    // 2 leaves removed: 1 file + 1 symlink.
    assert_eq!(files, 2);
    assert!(!root.exists());
}

#[test]
fn progress_disabled_is_zero_cost_noop() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("noprog");
    fs::create_dir_all(&root).unwrap();
    write_tree(&root);

    // Progress::disabled() should record nothing — only the return tuple
    // carries data.
    let progress = Progress::disabled();
    let (files, _) = remove_dir_with_progress(&root, &progress);
    let (snap, _) = progress.snapshot();
    assert!(files > 0);
    assert_eq!(snap, 0, "disabled progress must remain zero");
}
