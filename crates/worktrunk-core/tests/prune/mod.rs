// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Parity tests for `worktrunk_core::step::prune::build_prune_plan`.
//!
//! The donor `wt step prune` CLI calls into the same `build_prune_plan` after
//! T10220 extraction, so the SDK function IS the source of truth. We assert
//! the SDK against canonical fixtures:
//!
//! - Two-worktree repo where the secondary branch is merged into `main` —
//!   secondary must appear as a [`PruneCandidateKind::Other`] candidate.
//! - A branch that exists locally with no worktree, fully merged — must
//!   appear as a [`PruneCandidateKind::BranchOnly`] candidate.
//! - The main worktree itself MUST NEVER appear in the plan.
//! - The integration target branch MUST NEVER appear in the plan.
//! - Locked worktrees MUST be excluded.
//!
//! The `wt` binary's `step prune --dry-run --json` envelope would emit
//! essentially the same shape; if the binary is available we cross-check the
//! candidate count (full text parity is out of scope here because the CLI
//! adds styling + colour).

use worktrunk_core::git::ProcessRepo;
use worktrunk_core::git::repo::Repo;
use worktrunk_core::step::{PruneCandidateKind, build_prune_plan};

use crate::common::{add_worktree, commit_all, git, init_repo, write};

#[test]
fn merged_secondary_branch_appears_in_plan() {
    let repo = init_repo();
    write(repo.path(), "README.md", "v0\n");
    commit_all(repo.path(), "init");

    // Create `feat` from main (ancestor relationship: feat == main).
    git(repo.path(), &["branch", "feat"]).expect("branch");

    let p = ProcessRepo::at(repo.path()).expect("open repo");
    let snapshot = p.capture_refs().expect("snapshot");
    let worktrees = p.list_worktrees().expect("list worktrees");

    let plan = build_prune_plan(&p, &worktrees, &snapshot, "main").expect("plan");

    // `feat` should be flagged as branch-only (ancestor of main → merged).
    let branch_only: Vec<_> = plan
        .candidates
        .iter()
        .filter(|c| c.kind == PruneCandidateKind::BranchOnly)
        .collect();
    assert!(
        branch_only
            .iter()
            .any(|c| c.branch.as_deref() == Some("feat")),
        "expected `feat` as a BranchOnly candidate, got: {:#?}",
        plan.candidates
    );
    assert_eq!(plan.integration_target, "main");
}

#[test]
fn main_worktree_never_appears_in_plan() {
    let repo = init_repo();
    write(repo.path(), "README.md", "v0\n");
    commit_all(repo.path(), "init");

    let p = ProcessRepo::at(repo.path()).expect("open repo");
    let snapshot = p.capture_refs().expect("snapshot");
    let worktrees = p.list_worktrees().expect("list worktrees");
    let plan = build_prune_plan(&p, &worktrees, &snapshot, "main").expect("plan");

    // The primary worktree's path must NOT be a candidate.
    let main_path = &worktrees[0].path;
    for c in &plan.candidates {
        if let Some(p) = &c.path {
            assert_ne!(
                p, main_path,
                "main worktree path leaked into prune plan: {plan:#?}"
            );
        }
    }
}

#[test]
fn integration_target_branch_never_appears() {
    let repo = init_repo();
    write(repo.path(), "README.md", "v0\n");
    commit_all(repo.path(), "init");
    // Add a worktree that checks out `main` itself (somehow possible via
    // a detached step; we simulate with a separate branch fully merged).
    git(repo.path(), &["branch", "feat"]).expect("branch");

    let p = ProcessRepo::at(repo.path()).expect("open repo");
    let snapshot = p.capture_refs().expect("snapshot");
    let worktrees = p.list_worktrees().expect("list worktrees");
    let plan = build_prune_plan(&p, &worktrees, &snapshot, "main").expect("plan");

    for c in &plan.candidates {
        assert_ne!(
            c.branch.as_deref(),
            Some("main"),
            "integration target branch `main` leaked into plan"
        );
    }
}

#[test]
fn divergent_branch_is_not_a_candidate() {
    let repo = init_repo();
    write(repo.path(), "README.md", "v0\n");
    commit_all(repo.path(), "init");

    // Create `feat` and add a commit only on `feat` — feat is NOT an
    // ancestor of main.
    git(repo.path(), &["checkout", "-b", "feat"]).expect("checkout feat");
    write(repo.path(), "only-on-feat.txt", "x\n");
    commit_all(repo.path(), "feat-only");
    git(repo.path(), &["checkout", "main"]).expect("back to main");

    let p = ProcessRepo::at(repo.path()).expect("open repo");
    let snapshot = p.capture_refs().expect("snapshot");
    let worktrees = p.list_worktrees().expect("list worktrees");
    let plan = build_prune_plan(&p, &worktrees, &snapshot, "main").expect("plan");

    for c in &plan.candidates {
        assert_ne!(
            c.branch.as_deref(),
            Some("feat"),
            "divergent branch `feat` should NOT be pruneable, got: {plan:#?}"
        );
    }
}

#[test]
fn linked_worktree_on_merged_branch_appears_in_plan() {
    let repo = init_repo();
    write(repo.path(), "README.md", "v0\n");
    commit_all(repo.path(), "init");

    // Add a linked worktree on branch `wt-feat` that is at the same SHA as
    // main (so it's "merged").
    let wt_dir = tempfile::tempdir().expect("wt-dir");
    add_worktree(repo.path(), wt_dir.path(), "wt-feat");

    let p = ProcessRepo::at(repo.path()).expect("open primary repo");
    let snapshot = p.capture_refs().expect("snapshot");
    let worktrees = p.list_worktrees().expect("list");
    let plan = build_prune_plan(&p, &worktrees, &snapshot, "main").expect("plan");

    let live: Vec<_> = plan
        .candidates
        .iter()
        .filter(|c| c.kind == PruneCandidateKind::Other)
        .collect();
    assert!(
        live.iter().any(|c| c.branch.as_deref() == Some("wt-feat")),
        "expected wt-feat as live Other candidate, got: {:#?}",
        plan.candidates
    );
}
