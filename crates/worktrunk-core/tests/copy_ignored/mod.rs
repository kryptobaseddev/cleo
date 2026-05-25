// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Parity tests for `worktrunk_core::step::copy_ignored::{plan_copy_ignored, run_copy_ignored}`.
//!
//! The donor `wt step copy-ignored` CLI calls into the same two functions
//! after T10220 extraction. We assert the SDK against:
//!
//! - Plain ignored files (no `.worktreeinclude`) — every entry in `git
//!   ls-files --ignored` makes it into the plan.
//! - `.worktreeinclude` filter — only matching entries land in the plan.
//! - Same-source/destination short-circuit — `same_worktree` flag set.
//! - VCS-metadata directories — always skipped per
//!   [`BUILTIN_COPY_IGNORED_EXCLUDES`].
//! - Run-phase — entries are actually written to the destination.

use std::fs;

use tempfile::TempDir;
use worktrunk_core::Progress;
use worktrunk_core::step::{BUILTIN_COPY_IGNORED_EXCLUDES, plan_copy_ignored, run_copy_ignored};

use crate::common::{commit_all, init_repo, write};

#[test]
fn same_source_and_destination_yields_empty_plan() {
    let repo = init_repo();
    write(repo.path(), "README.md", "v0\n");
    commit_all(repo.path(), "init");

    let plan = plan_copy_ignored(
        repo.path(),
        repo.path(),
        "self-copy",
        &[repo.path().to_path_buf()],
        &[],
    )
    .expect("plan");

    assert!(plan.same_worktree, "same path → same_worktree flag");
    assert!(plan.entries.is_empty());
}

#[test]
fn plan_includes_ignored_files() {
    let repo = init_repo();
    write(repo.path(), ".gitignore", "secrets/\n*.log\n");
    write(repo.path(), "README.md", "tracked\n");
    commit_all(repo.path(), "tracked init");

    // Now add ignored files — these are NOT in the index but are emitted
    // by `git ls-files --ignored --exclude-standard -o --directory`.
    write(repo.path(), "secrets/key.txt", "shhh\n");
    write(repo.path(), "build.log", "warning: foo\n");

    let dst = TempDir::new().unwrap();
    let plan = plan_copy_ignored(
        repo.path(),
        dst.path(),
        "src->dst",
        &[repo.path().to_path_buf()],
        &[],
    )
    .expect("plan");

    assert!(!plan.same_worktree);
    let names: Vec<String> = plan
        .entries
        .iter()
        .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    // `secrets/` is a dir + `build.log` is a file.
    assert!(
        names.iter().any(|n| n == "secrets"),
        "expected `secrets` dir entry, got names={names:?}"
    );
    assert!(
        names.iter().any(|n| n == "build.log"),
        "expected `build.log` file entry, got names={names:?}"
    );
}

#[test]
fn worktreeinclude_filter_restricts_plan() {
    let repo = init_repo();
    write(repo.path(), ".gitignore", "*.log\n*.tmp\n");
    write(repo.path(), "README.md", "init\n");
    commit_all(repo.path(), "init");

    write(repo.path(), "keep.log", "keep me\n");
    write(repo.path(), "drop.tmp", "drop me\n");
    // `.worktreeinclude` selects only `*.log` — `.tmp` files are excluded.
    write(repo.path(), ".worktreeinclude", "*.log\n");

    let dst = TempDir::new().unwrap();
    let plan = plan_copy_ignored(
        repo.path(),
        dst.path(),
        "src->dst",
        &[repo.path().to_path_buf()],
        &[],
    )
    .expect("plan");

    let names: Vec<String> = plan
        .entries
        .iter()
        .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert!(names.iter().any(|n| n == "keep.log"));
    assert!(
        !names.iter().any(|n| n == "drop.tmp"),
        "drop.tmp must be excluded by .worktreeinclude, got names={names:?}"
    );
}

#[test]
fn builtin_excludes_skip_vcs_metadata() {
    let repo = init_repo();
    write(repo.path(), ".gitignore", ".hg/\n.svn/\n.jj/\n");
    write(repo.path(), "README.md", "init\n");
    commit_all(repo.path(), "init");

    // Create VCS metadata directories.
    fs::create_dir_all(repo.path().join(".hg")).unwrap();
    write(repo.path(), ".hg/store", "hg-state\n");
    fs::create_dir_all(repo.path().join(".svn")).unwrap();
    write(repo.path(), ".svn/entries", "svn-state\n");
    fs::create_dir_all(repo.path().join(".jj")).unwrap();
    write(repo.path(), ".jj/repo", "jj-state\n");

    let dst = TempDir::new().unwrap();
    let plan = plan_copy_ignored(
        repo.path(),
        dst.path(),
        "src->dst",
        &[repo.path().to_path_buf()],
        &[],
    )
    .expect("plan");

    let names: Vec<String> = plan
        .entries
        .iter()
        .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    for vcs in [".hg", ".svn", ".jj"] {
        assert!(
            !names.iter().any(|n| n == vcs),
            "VCS metadata {vcs} must be skipped, got names={names:?}"
        );
    }
}

#[test]
fn builtin_excludes_list_is_canonical() {
    // The SDK exposes the list as a public constant — assert it contains the
    // known set so a refactor cannot silently drop one.
    for must_contain in [".hg/", ".svn/", ".jj/", ".bzr/", ".pijul/", ".sl/"] {
        assert!(
            BUILTIN_COPY_IGNORED_EXCLUDES.contains(&must_contain),
            "BUILTIN_COPY_IGNORED_EXCLUDES missing {must_contain}: {BUILTIN_COPY_IGNORED_EXCLUDES:?}"
        );
    }
}

#[test]
fn run_copies_planned_entries_to_destination() {
    let repo = init_repo();
    write(repo.path(), ".gitignore", "secrets/\n*.log\n");
    write(repo.path(), "README.md", "tracked\n");
    commit_all(repo.path(), "init");

    write(repo.path(), "secrets/key.txt", "shhh\n");
    write(repo.path(), "build.log", "warn\n");

    let dst = TempDir::new().unwrap();
    let plan = plan_copy_ignored(
        repo.path(),
        dst.path(),
        "src->dst",
        &[repo.path().to_path_buf()],
        &[],
    )
    .expect("plan");

    let outcome = run_copy_ignored(&plan, false, &Progress::disabled()).expect("run");
    assert!(
        outcome.files >= 2,
        "expected ≥2 files copied, got {}",
        outcome.files
    );
    assert!(outcome.bytes > 0);

    assert!(dst.path().join("secrets/key.txt").exists());
    assert!(dst.path().join("build.log").exists());
}

#[test]
fn configured_excludes_apply_after_worktreeinclude() {
    let repo = init_repo();
    write(repo.path(), ".gitignore", "*.cache\n*.tmp\n");
    write(repo.path(), "README.md", "init\n");
    commit_all(repo.path(), "init");

    write(repo.path(), "keep.cache", "keep\n");
    write(repo.path(), "drop.cache", "drop\n");

    let dst = TempDir::new().unwrap();
    let plan = plan_copy_ignored(
        repo.path(),
        dst.path(),
        "src->dst",
        &[repo.path().to_path_buf()],
        &["drop.cache".to_string()],
    )
    .expect("plan");

    let names: Vec<String> = plan
        .entries
        .iter()
        .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert!(names.iter().any(|n| n == "keep.cache"));
    assert!(
        !names.iter().any(|n| n == "drop.cache"),
        "configured exclude `drop.cache` should be filtered out: {names:?}"
    );
}
