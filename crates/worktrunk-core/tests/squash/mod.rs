// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Parity tests for `worktrunk_core::step::squash::classify_squash`.
//!
//! The classifier decides whether a `wt step squash` invocation has any work
//! to do, given a target ref and the current staged-changes state. The
//! decision table is small but each branch matters for the CLI's exit
//! behaviour:
//!
//! - `NoCommitsAhead` — no commits past `target_ref`, no staged → bail.
//! - `AlreadySingleCommit` — exactly 1 commit past, no staged → bail.
//! - `StagedOnly` — 0 commits, staged → no squash but allow commit.
//! - `Squashable` — anything else → squash dance.
//!
//! We build a real git repo per test, exercise `classify_squash` through
//! `ProcessRepo`, and assert the variant + non-trivial payload fields.
//!
//! The donor `wt step squash` flow internally calls into the same
//! `classify_squash` (post-T10220 extraction), so binary parity reduces to
//! "SDK on fixture X returns enum variant Y". We assert that directly.

use std::path::Path;

use worktrunk_core::git::ProcessRepo;
use worktrunk_core::step::{SquashClassification, SquashInputs, classify_squash};

use crate::common::{commit_all, git, init_repo, write};

fn build_repo_with_commits(n: usize) -> tempfile::TempDir {
    let repo = init_repo();
    // Baseline commit (creates `main`).
    write(repo.path(), "README.md", "v0\n");
    commit_all(repo.path(), "init");
    for i in 1..=n {
        write(repo.path(), &format!("f{i}.txt"), "x\n");
        commit_all(repo.path(), &format!("feat: change {i}"));
    }
    repo
}

fn open_repo(path: &Path) -> ProcessRepo {
    ProcessRepo::at(path).expect("ProcessRepo::at")
}

#[test]
fn no_commits_ahead_with_no_staged_yields_no_commits_ahead() {
    // HEAD == main (zero commits ahead), no staged changes.
    let repo = build_repo_with_commits(0);
    git(repo.path(), &["checkout", "-b", "feat"]).expect("branch");
    // No changes on `feat`.
    let p = open_repo(repo.path());
    let cls = classify_squash(
        &p,
        SquashInputs {
            target_ref: "main",
            has_staged: false,
        },
    )
    .expect("classify");
    match cls {
        SquashClassification::NoCommitsAhead { target } => assert_eq!(target, "main"),
        other => panic!("expected NoCommitsAhead, got {other:?}"),
    }
}

#[test]
fn exactly_one_commit_ahead_yields_already_single_commit() {
    let repo = build_repo_with_commits(0);
    git(repo.path(), &["checkout", "-b", "feat"]).expect("branch");
    write(repo.path(), "extra.txt", "y\n");
    commit_all(repo.path(), "one ahead");

    let p = open_repo(repo.path());
    let cls = classify_squash(
        &p,
        SquashInputs {
            target_ref: "main",
            has_staged: false,
        },
    )
    .expect("classify");
    assert!(
        matches!(cls, SquashClassification::AlreadySingleCommit),
        "expected AlreadySingleCommit, got {cls:?}"
    );
}

#[test]
fn zero_commits_with_staged_yields_staged_only() {
    let repo = build_repo_with_commits(0);
    git(repo.path(), &["checkout", "-b", "feat"]).expect("branch");
    // Add a staged file but don't commit.
    write(repo.path(), "staged.txt", "z\n");
    git(repo.path(), &["add", "staged.txt"]).expect("git add");

    let p = open_repo(repo.path());
    let cls = classify_squash(
        &p,
        SquashInputs {
            target_ref: "main",
            has_staged: true,
        },
    )
    .expect("classify");
    match cls {
        SquashClassification::StagedOnly { target, merge_base } => {
            assert_eq!(target, "main");
            assert_eq!(merge_base.len(), 40, "merge_base should be a full SHA");
        }
        other => panic!("expected StagedOnly, got {other:?}"),
    }
}

#[test]
fn multiple_commits_ahead_yields_squashable() {
    let repo = build_repo_with_commits(0);
    git(repo.path(), &["checkout", "-b", "feat"]).expect("branch");
    write(repo.path(), "a.txt", "1\n");
    commit_all(repo.path(), "feat: alpha");
    write(repo.path(), "b.txt", "2\n");
    commit_all(repo.path(), "feat: beta");
    write(repo.path(), "c.txt", "3\n");
    commit_all(repo.path(), "feat: gamma");

    let p = open_repo(repo.path());
    let cls = classify_squash(
        &p,
        SquashInputs {
            target_ref: "main",
            has_staged: false,
        },
    )
    .expect("classify");
    match cls {
        SquashClassification::Squashable {
            target,
            merge_base,
            commit_count,
            subjects,
            diff_summary,
        } => {
            assert_eq!(target, "main");
            assert_eq!(merge_base.len(), 40);
            assert_eq!(commit_count, 3);
            // Subjects newest-first.
            assert_eq!(subjects.len(), 3);
            assert!(subjects[0].contains("gamma"), "newest first: got {subjects:?}");
            assert!(!diff_summary.is_empty(), "diff_summary must be non-empty");
        }
        other => panic!("expected Squashable, got {other:?}"),
    }
}

#[test]
fn unknown_target_ref_errors() {
    let repo = build_repo_with_commits(0);
    let p = open_repo(repo.path());
    let err = classify_squash(
        &p,
        SquashInputs {
            target_ref: "does-not-exist",
            has_staged: false,
        },
    )
    .unwrap_err();
    // Whether merge_base returns Ok(None) or Err depends on git's exit code
    // — either way the SDK propagates a non-success result.
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("does-not-exist")
            || msg.contains("not")
            || msg.contains("common ancestor")
            || msg.contains("merge-base"),
        "unexpected error message: {err}"
    );
}
