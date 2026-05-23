// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Pure SDK for `wt step relocate` — moving worktrees to their expected paths.
//!
//! Extracted from `worktrunk::commands::step::relocate` + `worktrunk::commands::relocate`
//! per ADR-078. The CLI version mixes:
//!
//! - Path template expansion (the `worktree-path` template engine).
//! - Dirty/locked validation + auto-commit via LLM.
//! - Cycle-breaking executor with temp moves.
//! - JSON / styled output.
//! - HITL approval prompts for batched commit-template appends.
//!
//! This SDK module owns the algorithmic core:
//!
//! - [`expected_path_for`] — compute the canonical CLEO worktree path for a
//!   given branch from the central [`crate::paths`] SSoT. **Folds T10207
//!   scope** — `step::relocate` no longer derives the project-hash root
//!   ad hoc; it consumes the same primitives `@cleocode/paths` ships in
//!   TypeScript.
//! - [`build_relocation_plan`] — given a list of worktrees + a list of
//!   `(branch, expected_path)` candidates, build a [`RelocatePlan`] with
//!   typed cycle-break temp moves resolved.
//!
//! Validation (locked / dirty), execution (`git worktree move`), and output
//! formatting are CLI concerns.

#![allow(clippy::doc_markdown)] // .gitignore etc are not Rust items

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::git_wt::WorktreeInfo;
use crate::paths::{compute_project_hash, resolve_task_worktree_path};

/// A worktree whose current path doesn't match its expected path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelocateCandidate {
    /// Branch name (relocate candidates always have a branch — detached
    /// worktrees are skipped).
    pub branch: String,
    /// Where the worktree currently lives.
    pub current_path: PathBuf,
    /// Where the worktree SHOULD live per the layout template.
    pub expected_path: PathBuf,
    /// HEAD commit at the time of plan construction.
    pub head: String,
}

/// One step in a cycle-breaking dance: the worktree moves through a `temp`
/// path before reaching its `final` destination.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelocateCycleBreak {
    /// Index into [`RelocatePlan::candidates`] this break refers to.
    pub candidate_index: usize,
    /// The temporary path the worktree should be moved to first.
    pub temp_path: PathBuf,
}

/// A typed relocation plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelocatePlan {
    /// All candidates flagged for relocation.
    pub candidates: Vec<RelocateCandidate>,
    /// Subset of candidates that participate in cycles and need a temp move.
    pub cycle_breaks: Vec<RelocateCycleBreak>,
    /// Subset of candidate INDICES whose expected target is currently
    /// occupied by a non-worktree path. CLI callers decide to skip or to
    /// rename out of the way (`--clobber`).
    pub blocked_indices: Vec<usize>,
}

/// Compute the canonical CLEO worktree path for a given `task_id` + project
/// root, going through the [`crate::paths`] SSoT.
///
/// This is the function that closes T10207's open issue: the CLI version of
/// `worktree-path` had its own template engine that re-derived the project
/// hash and the worktree root. This SDK helper makes the SAME computation
/// available to consumers without forking the algorithm.
///
/// `cleo_home` is the resolved `<cleoHome>` directory (the CLI must supply
/// this; in CLEO's case it comes from `@cleocode/paths`'s `getCleoHome()`).
///
/// # Examples
///
/// ```
/// use worktrunk_core::step::expected_path_for;
///
/// let p = expected_path_for("/tmp/cleo-home", "/mnt/projects/cleocode", "T1234");
/// assert!(p.ends_with("worktrees/1e3146b7352ba279/T1234"));
/// ```
#[must_use]
pub fn expected_path_for(cleo_home: &str, project_root: &str, task_id: &str) -> PathBuf {
    let project_hash = compute_project_hash(project_root);
    resolve_task_worktree_path(cleo_home, &project_hash, task_id)
}

/// Build a [`RelocatePlan`] from a list of worktrees + their pre-resolved
/// expected paths.
///
/// `worktrees` is the snapshot from [`Repo::list_worktrees`]; `expected_paths`
/// is a map from `branch_name` to the expected absolute path (computed by the
/// CLI via [`expected_path_for`] or its own template engine).
///
/// The function:
///
/// 1. Iterates `worktrees`, drops anything without a branch (detached) or
///    where `current == expected`.
/// 2. Builds a `current → candidate_index` map.
/// 3. Detects cycles: when candidate A's `expected_path` IS candidate B's
///    `current_path`, A is "blocked" by B until B moves. If B's expected
///    target is also blocked (closing the cycle), one candidate is flagged
///    for a temp move.
/// 4. Detects path-conflict-with-non-worktree: when an expected target
///    exists in the filesystem but does NOT match any worktree's current
///    path. These land in `blocked_indices`.
///
/// `blocked_path_exists` is a callback the SDK uses to ask "does this path
/// exist?" — extracted so tests can stub the filesystem.
///
/// # Errors
///
/// This function returns `anyhow::Result` for forward-compat with future
/// fallible probes, but the current body never errors.
pub fn build_relocation_plan<F>(
    worktrees: &[WorktreeInfo],
    expected_paths: &HashMap<String, PathBuf>,
    mut blocked_path_exists: F,
) -> Result<RelocatePlan>
where
    F: FnMut(&Path) -> bool,
{
    let mut candidates: Vec<RelocateCandidate> = Vec::new();

    for wt in worktrees {
        let Some(branch) = &wt.branch else {
            continue; // Detached worktrees are not relocated.
        };
        let Some(expected) = expected_paths.get(branch) else {
            continue; // No expected path configured for this branch.
        };
        if &wt.path == expected {
            continue; // Already at expected path.
        }
        candidates.push(RelocateCandidate {
            branch: branch.clone(),
            current_path: wt.path.clone(),
            expected_path: expected.clone(),
            head: wt.head.clone(),
        });
    }

    // Index by current path for cycle detection.
    let current_to_idx: HashMap<PathBuf, usize> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| (c.current_path.clone(), i))
        .collect();

    // For each candidate, determine if its expected_path is occupied:
    //   - By another candidate's current_path → potential cycle.
    //   - By a non-candidate path (filesystem-existent but not a relocation
    //     source) → blocked.
    //   - Otherwise → free to move directly.
    let mut visited: HashSet<usize> = HashSet::new();
    let mut cycle_breaks: Vec<RelocateCycleBreak> = Vec::new();
    let mut blocked_indices: Vec<usize> = Vec::new();

    for (idx, candidate) in candidates.iter().enumerate() {
        if let Some(&other_idx) = current_to_idx.get(&candidate.expected_path) {
            // Expected target is another candidate's current source — chase
            // the chain to look for a cycle that closes back to `idx`.
            if walk_chain_closes(&candidates, idx, other_idx, &current_to_idx)
                && !visited.contains(&idx)
            {
                visited.insert(idx);
                let temp_path = make_temp_path(&candidate.current_path);
                cycle_breaks.push(RelocateCycleBreak {
                    candidate_index: idx,
                    temp_path,
                });
            }
            // Non-cyclic chain: no temp move needed; the topological executor
            // will resolve order. Not the SDK's concern beyond the cycle
            // detection.
            continue;
        }
        if blocked_path_exists(&candidate.expected_path) {
            blocked_indices.push(idx);
        }
    }

    Ok(RelocatePlan {
        candidates,
        cycle_breaks,
        blocked_indices,
    })
}

/// Walk the "expected_path is someone else's current_path" chain starting at
/// `start`; return `true` if the chain loops back to `start`.
fn walk_chain_closes(
    candidates: &[RelocateCandidate],
    start: usize,
    first_hop: usize,
    current_to_idx: &HashMap<PathBuf, usize>,
) -> bool {
    let mut seen: HashSet<usize> = HashSet::from([start]);
    let mut cursor = first_hop;
    loop {
        if cursor == start {
            return true;
        }
        if !seen.insert(cursor) {
            return false; // Loop that doesn't include `start`.
        }
        let expected = &candidates[cursor].expected_path;
        match current_to_idx.get(expected) {
            Some(&next) => cursor = next,
            None => return false, // Chain ends in a free target.
        }
    }
}

/// Build a temp-move path by appending `.relocate-tmp` to the basename.
///
/// The CLI version uses a per-cycle scratch dir; the SDK shape is path-only
/// so consumers can wire whatever scratch convention they prefer.
fn make_temp_path(current: &Path) -> PathBuf {
    let mut s = current.as_os_str().to_os_string();
    s.push(".relocate-tmp");
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn wt(path: &str, branch: &str, head: &str) -> WorktreeInfo {
        WorktreeInfo {
            path: PathBuf::from(path),
            branch: Some(branch.to_string()),
            head: head.to_string(),
            is_locked: false,
            is_prunable: false,
        }
    }

    #[test]
    fn expected_path_for_uses_project_hash() {
        let p = expected_path_for("/c/home", "/mnt/projects/cleocode", "T9999");
        // Verifies via the known hash for /mnt/projects/cleocode.
        assert!(p.ends_with("worktrees/1e3146b7352ba279/T9999"));
    }

    #[test]
    fn build_plan_skips_already_at_expected_path() {
        let worktrees = vec![wt("/wt/foo", "foo", "abc")];
        let mut expected = HashMap::new();
        expected.insert("foo".into(), PathBuf::from("/wt/foo"));
        let plan = build_relocation_plan(&worktrees, &expected, |_| false).unwrap();
        assert!(plan.candidates.is_empty());
    }

    #[test]
    fn build_plan_emits_candidate_when_paths_mismatch() {
        let worktrees = vec![wt("/wt/old", "foo", "abc")];
        let mut expected = HashMap::new();
        expected.insert("foo".into(), PathBuf::from("/wt/new"));
        let plan = build_relocation_plan(&worktrees, &expected, |_| false).unwrap();
        assert_eq!(plan.candidates.len(), 1);
        assert_eq!(plan.candidates[0].current_path, PathBuf::from("/wt/old"));
        assert_eq!(plan.candidates[0].expected_path, PathBuf::from("/wt/new"));
    }

    #[test]
    fn build_plan_detects_simple_two_way_swap_cycle() {
        // foo lives at /wt/a, wants /wt/b. bar lives at /wt/b, wants /wt/a.
        let worktrees = vec![wt("/wt/a", "foo", "ha"), wt("/wt/b", "bar", "hb")];
        let mut expected = HashMap::new();
        expected.insert("foo".into(), PathBuf::from("/wt/b"));
        expected.insert("bar".into(), PathBuf::from("/wt/a"));
        let plan = build_relocation_plan(&worktrees, &expected, |_| false).unwrap();
        assert_eq!(plan.candidates.len(), 2);
        assert!(
            !plan.cycle_breaks.is_empty(),
            "expected at least one cycle-break temp move"
        );
    }

    #[test]
    fn build_plan_flags_blocked_paths() {
        let worktrees = vec![wt("/wt/old", "foo", "abc")];
        let mut expected = HashMap::new();
        expected.insert("foo".into(), PathBuf::from("/wt/new"));
        // /wt/new exists but is not another worktree's current path.
        let plan = build_relocation_plan(&worktrees, &expected, |p| {
            p == Path::new("/wt/new")
        })
        .unwrap();
        assert_eq!(plan.blocked_indices, vec![0]);
    }

    #[test]
    fn build_plan_skips_detached_worktrees() {
        let worktrees = vec![WorktreeInfo {
            path: PathBuf::from("/wt/det"),
            branch: None,
            head: "abc".into(),
            is_locked: false,
            is_prunable: false,
        }];
        let plan = build_relocation_plan(&worktrees, &HashMap::new(), |_| false).unwrap();
        assert!(plan.candidates.is_empty());
    }
}
