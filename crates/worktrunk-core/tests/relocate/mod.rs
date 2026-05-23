// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Parity tests for `worktrunk_core::step::relocate`.
//!
//! The relocate primitives split into two pieces:
//!
//! 1. [`expected_path_for`] — pure path computation. Cross-checked against
//!    the `SSoT` formula owned by `@cleocode/paths` (T10207 fold).
//! 2. [`build_relocation_plan`] — pure data classifier. Tests stub the
//!    "blocked path exists" callback to deterministic answers.
//!
//! Donor binary parity (`wt step relocate --dry-run --json`) would require
//! a full git worktree set up to a non-canonical layout. We exercise the
//! pure functions directly here; the SDK shares the same algorithm by
//! extraction.

use std::collections::HashMap;
use std::path::PathBuf;

use worktrunk_core::git_wt::WorktreeInfo;
use worktrunk_core::paths::{compute_project_hash, resolve_task_worktree_path};
use worktrunk_core::step::{build_relocation_plan, expected_path_for};

#[test]
fn expected_path_matches_paths_ssot_layout() {
    let cleo_home = "/tmp/cleo-home";
    let project_root = "/mnt/projects/cleocode";
    let task_id = "T1234";

    let from_helper = expected_path_for(cleo_home, project_root, task_id);
    let project_hash = compute_project_hash(project_root);
    let direct = resolve_task_worktree_path(cleo_home, &project_hash, task_id);

    assert_eq!(
        from_helper, direct,
        "expected_path_for must equal SSoT composition"
    );
    assert!(from_helper.ends_with("worktrees/1e3146b7352ba279/T1234"));
}

#[test]
fn project_hash_is_deterministic_and_16_chars() {
    let h = compute_project_hash("/mnt/projects/cleocode");
    assert_eq!(h.len(), 16);
    assert!(h.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    // Recompute — same answer.
    assert_eq!(h, compute_project_hash("/mnt/projects/cleocode"));
}

#[test]
fn different_project_roots_yield_different_hashes() {
    let a = compute_project_hash("/mnt/projects/cleocode");
    let b = compute_project_hash("/mnt/projects/worktrunk");
    assert_ne!(a, b);
}

fn wt(branch: &str, current: &str, head: &str) -> WorktreeInfo {
    WorktreeInfo {
        path: PathBuf::from(current),
        branch: Some(branch.to_string()),
        head: head.to_string(),
        is_locked: false,
        is_prunable: false,
    }
}

#[test]
fn relocation_plan_skips_already_correct_paths() {
    let worktrees = vec![wt("main", "/wt/root", "abc")];
    let mut expected = HashMap::new();
    expected.insert("main".to_string(), PathBuf::from("/wt/root")); // same

    let plan = build_relocation_plan(&worktrees, &expected, |_| false).unwrap();
    assert!(
        plan.candidates.is_empty(),
        "no candidates when current == expected"
    );
    assert!(plan.cycle_breaks.is_empty());
    assert!(plan.blocked_indices.is_empty());
}

#[test]
fn relocation_plan_flags_blocked_paths() {
    let worktrees = vec![wt("feat", "/old/feat", "abc")];
    let mut expected = HashMap::new();
    expected.insert("feat".to_string(), PathBuf::from("/new/feat"));

    // Stub: expected target exists in the filesystem (occupied by some
    // non-worktree directory).
    let plan = build_relocation_plan(&worktrees, &expected, |p| {
        p == std::path::Path::new("/new/feat")
    })
    .unwrap();

    assert_eq!(plan.candidates.len(), 1);
    assert_eq!(plan.blocked_indices, vec![0]);
    assert!(plan.cycle_breaks.is_empty());
}

#[test]
fn relocation_plan_detects_simple_swap_cycle() {
    // Two worktrees that want to swap paths:
    //   feat-a is at /p1 and wants /p2
    //   feat-b is at /p2 and wants /p1
    // The SDK must flag a cycle-break (one moves to a temp first).
    let worktrees = vec![
        wt("feat-a", "/p1", "aaa"),
        wt("feat-b", "/p2", "bbb"),
    ];
    let mut expected = HashMap::new();
    expected.insert("feat-a".to_string(), PathBuf::from("/p2"));
    expected.insert("feat-b".to_string(), PathBuf::from("/p1"));

    // Neither expected path is occupied by a NON-worktree path.
    let plan = build_relocation_plan(&worktrees, &expected, |_| false).unwrap();

    assert_eq!(plan.candidates.len(), 2);
    assert!(plan.blocked_indices.is_empty());
    assert!(
        !plan.cycle_breaks.is_empty(),
        "swap cycle MUST yield at least one cycle break, got plan: {plan:?}"
    );
    // Cycle-break must reference a real candidate index.
    for br in &plan.cycle_breaks {
        assert!(br.candidate_index < plan.candidates.len());
    }
}

#[test]
fn relocation_plan_drops_detached_worktrees() {
    let detached = WorktreeInfo {
        path: PathBuf::from("/detached"),
        branch: None,
        head: "deadbeef".into(),
        is_locked: false,
        is_prunable: false,
    };
    let worktrees = vec![detached];
    let expected: HashMap<String, PathBuf> = HashMap::new();

    let plan = build_relocation_plan(&worktrees, &expected, |_| false).unwrap();
    assert!(plan.candidates.is_empty());
}
