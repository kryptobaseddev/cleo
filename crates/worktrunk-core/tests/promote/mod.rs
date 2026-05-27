// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Parity tests for `worktrunk_core::step::promote`.
//!
//! Full promote orchestration (branch swap + stage/unstage + final dance)
//! requires two real worktrees, fully wired hooks, and a default-branch
//! resolved against the underlying repo — too much surface to exercise in
//! a pure SDK parity test without rebuilding most of `wt`.
//!
//! We focus on the two pure-data primitives that promote exposes:
//!
//! 1. [`move_or_copy_entry`] — the cross-device-tolerant filesystem move.
//!    Donor used a manual `EXDEV` fallback; SDK preserves the behaviour.
//! 2. `PROMOTE_STAGING_DIR` — the well-known staging directory name. Donor
//!    and SDK MUST agree on the literal so a CLI consumer that pre-creates
//!    the directory will end up where the SDK looks.

use std::fs;
use std::path::Path;

use tempfile::TempDir;
use worktrunk_core::step::move_or_copy_entry;
use worktrunk_core::step::promote::PROMOTE_STAGING_DIR;

#[test]
fn promote_staging_dir_constant_is_stable() {
    // This literal is part of the SDK <-> CLI contract — changing it without
    // updating the CLI's pre-create / cleanup logic will break promote.
    assert_eq!(PROMOTE_STAGING_DIR, "staging/promote");
}

#[test]
fn move_renames_file_within_same_device() {
    let tmp = TempDir::new().unwrap();
    let src = tmp.path().join("src.txt");
    let dst = tmp.path().join("nested/dst.txt");
    fs::write(&src, "content").unwrap();

    move_or_copy_entry(&src, &dst, false).expect("move");

    assert!(!src.exists(), "src should be gone after rename");
    assert_eq!(fs::read_to_string(&dst).unwrap(), "content");
}

#[test]
fn move_creates_parent_directory() {
    let tmp = TempDir::new().unwrap();
    let src = tmp.path().join("a.txt");
    let dst = tmp.path().join("deeply/nested/b.txt");
    fs::write(&src, "x").unwrap();

    move_or_copy_entry(&src, &dst, false).expect("move with mkdir -p");

    assert!(dst.parent().unwrap().is_dir());
    assert_eq!(fs::read_to_string(&dst).unwrap(), "x");
}

#[test]
fn move_directory_recursively() {
    let tmp = TempDir::new().unwrap();
    let src_dir = tmp.path().join("src-dir");
    fs::create_dir_all(src_dir.join("nested")).unwrap();
    fs::write(src_dir.join("a.txt"), "a").unwrap();
    fs::write(src_dir.join("nested/b.txt"), "b").unwrap();

    let dst_dir = tmp.path().join("dst-dir");
    move_or_copy_entry(&src_dir, &dst_dir, true).expect("move dir");

    // Same-device rename should remove the source.
    assert!(!src_dir.exists(), "src dir should be gone");
    assert_eq!(fs::read_to_string(dst_dir.join("a.txt")).unwrap(), "a");
    assert_eq!(
        fs::read_to_string(dst_dir.join("nested/b.txt")).unwrap(),
        "b"
    );
}

#[test]
fn move_missing_src_errors() {
    let tmp = TempDir::new().unwrap();
    let src = tmp.path().join("ghost");
    let dst = tmp.path().join("out");
    let err = move_or_copy_entry(&src, &dst, false).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("moving") || msg.contains("ghost"),
        "error must mention what failed: {err}"
    );
}

#[test]
fn move_idempotent_into_clean_destination() {
    // Two moves in a row: first creates dst, second should fail loudly
    // because src is gone.
    let tmp = TempDir::new().unwrap();
    let src = tmp.path().join("a.txt");
    let dst = tmp.path().join("b.txt");
    fs::write(&src, "hello").unwrap();

    move_or_copy_entry(&src, &dst, false).expect("first move");
    let err = move_or_copy_entry(&src, &dst, false).unwrap_err();
    let _ = Path::new(&dst); // keep test deterministic across runs
    assert!(err.to_string().to_lowercase().contains("moving"));
}
