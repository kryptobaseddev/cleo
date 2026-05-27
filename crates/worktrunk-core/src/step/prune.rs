// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Pure SDK for `wt step prune` — selecting integrated worktrees + branches
//! for removal.
//!
//! Extracted from `worktrunk::commands::step::prune` per ADR-078. The CLI
//! version owns:
//!
//! - Hook plan construction + approval (CLI-shaped).
//! - Rayon-parallel integration probes + Windows `.git/config` lock dance.
//! - Dry-run vs live output formatting (CLI-shaped).
//! - `try_remove` execution (calls into orchestration / pre-remove hooks).
//!
//! This SDK module owns the pure decisions:
//!
//! - Walk worktrees + branches, classify each as a [`PruneCandidate`].
//! - Probe integration status against a target branch via the snapshot.
//! - Filter by min-age constraints when filesystem metadata is available.
//!
//! Hooks, parallelism strategy, and removal execution are CLI concerns.

#![allow(clippy::doc_markdown)] // pre-remove etc are not Rust items

use std::collections::HashSet;
use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::git::{RefSnapshot, Repo};
use crate::git_wt::WorktreeInfo;

/// Whether a candidate has a live worktree, is the *current* worktree, or is
/// branch-only (no worktree).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PruneCandidateKind {
    /// The current worktree (the one the caller is running from).
    Current,
    /// Some other live linked worktree.
    Other,
    /// Local branch with no worktree (orphan or stale).
    BranchOnly,
}

impl PruneCandidateKind {
    /// Stable identifier suitable for JSON output (matches the CLI's labels).
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Other => "worktree",
            Self::BranchOnly => "branch_only",
        }
    }
}

/// A worktree or branch that passed the integration probe and is eligible
/// for pruning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PruneCandidate {
    /// Branch name (None for detached HEAD worktrees).
    pub branch: Option<String>,
    /// Display label — branch name or short SHA for detached worktrees.
    pub label: String,
    /// Worktree path (None for branch-only candidates).
    pub path: Option<PathBuf>,
    /// Kind of candidate.
    pub kind: PruneCandidateKind,
    /// Human-readable reason from [`Repo::integration_reason`] explaining why
    /// this candidate is considered integrated.
    pub reason: String,
}

/// Full prune plan: the candidate set plus the integration target it was
/// computed against.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrunePlan {
    /// The default branch this plan was computed against.
    pub integration_target: String,
    /// Candidates eligible for removal, in deterministic discovery order.
    pub candidates: Vec<PruneCandidate>,
}

/// Probe whether `branch` is integrated into `target` using a captured
/// [`RefSnapshot`].
///
/// Delegates to [`Repo::integration_reason`]; returns the reason string when
/// integrated, `None` otherwise. Wrapping the trait call as a free function
/// gives downstream CLI code a stable name to mock in tests.
///
/// # Errors
///
/// Forwards any error from [`Repo::integration_reason`].
pub fn integration_is_integrated(
    repo: &dyn Repo,
    snapshot: &RefSnapshot,
    branch: &str,
    target: &str,
) -> Result<Option<String>> {
    repo.integration_reason(snapshot, branch, target)
}

/// Build a [`PrunePlan`] from `worktrees` + the integration target.
///
/// Skips:
/// - The main worktree (entry 0) — never pruned.
/// - Worktrees whose branch == `target` (the default branch itself).
/// - Locked worktrees.
/// - Prunable (stale-metadata) worktrees go in as branch-only entries.
///
/// Each candidate is probed via [`integration_is_integrated`]; only candidates
/// that ARE integrated land in the plan.
///
/// The CLI version of this loop fans the integration probes out across
/// rayon workers. The SDK version is single-threaded and serial — parallelism
/// is a CLI optimisation and orthogonal to the core algorithm. Re-add via
/// `rayon::iter::IntoParallelIterator` in the CLI if needed.
///
/// # Errors
///
/// Forwards errors from [`Repo::short_sha`], [`Repo::all_branches`], or the
/// integration probe.
pub fn build_prune_plan(
    repo: &dyn Repo,
    worktrees: &[WorktreeInfo],
    snapshot: &RefSnapshot,
    integration_target: &str,
) -> Result<PrunePlan> {
    let mut candidates: Vec<PruneCandidate> = Vec::new();
    let mut seen_branches: HashSet<String> = HashSet::new();

    let main_path = worktrees.first().map(|wt| wt.path.clone());

    for wt in worktrees.iter() {
        if let Some(branch) = &wt.branch {
            seen_branches.insert(branch.clone());
        }
        // Skip locked.
        if wt.is_locked {
            continue;
        }
        // Skip the main worktree by path (entry 0 is conventionally the main).
        if Some(&wt.path) == main_path.as_ref() {
            continue;
        }
        // Skip the worktree currently checking out the target branch.
        if let Some(branch) = &wt.branch
            && branch == integration_target
        {
            continue;
        }

        // Build label: branch name for normal worktrees, "(detached <short>)"
        // for detached HEAD.
        let label = match &wt.branch {
            Some(b) => b.clone(),
            None => {
                let short = repo.short_sha(&wt.head).unwrap_or_else(|_| wt.head.clone());
                format!("(detached {short})")
            }
        };

        if wt.is_prunable {
            // Stale-metadata worktree: branch-only removal candidate.
            if let Some(branch) = &wt.branch
                && let Some(reason) =
                    integration_is_integrated(repo, snapshot, branch, integration_target)?
            {
                candidates.push(PruneCandidate {
                    branch: Some(branch.clone()),
                    label,
                    path: None,
                    kind: PruneCandidateKind::BranchOnly,
                    reason,
                });
            }
            continue;
        }

        // Live linked worktree: probe via branch (when non-detached) or
        // accept "detached + no integration probe" — the latter never lands
        // in candidates because there's no branch to probe against.
        let probe_ref = wt.branch.clone();

        if let Some(b) = probe_ref
            && let Some(reason) = integration_is_integrated(repo, snapshot, &b, integration_target)?
        {
            // Caller decides whether this is the current worktree.
            candidates.push(PruneCandidate {
                branch: Some(b),
                label,
                path: Some(wt.path.clone()),
                kind: PruneCandidateKind::Other,
                reason,
            });
        }
    }

    // Branch-only candidates — local branches with no worktree.
    for branch_ref in repo.all_branches()? {
        if branch_ref.is_remote {
            continue;
        }
        if seen_branches.contains(&branch_ref.name) {
            continue;
        }
        if branch_ref.name == integration_target {
            continue;
        }
        if let Some(reason) =
            integration_is_integrated(repo, snapshot, &branch_ref.name, integration_target)?
        {
            candidates.push(PruneCandidate {
                branch: Some(branch_ref.name.clone()),
                label: branch_ref.name.clone(),
                path: None,
                kind: PruneCandidateKind::BranchOnly,
                reason,
            });
        }
    }

    Ok(PrunePlan {
        integration_target: integration_target.to_string(),
        candidates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::ProcessRepo;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn init_repo_with_merged_branch() -> TempDir {
        let dir = TempDir::new().unwrap();
        Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "t@t.t"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "t"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        fs::write(dir.path().join("README.md"), "v0\n").unwrap();
        Command::new("git")
            .args(["add", "README.md"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-q", "-m", "init"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        // Create branch `feat`, commit, then merge fast-forward back into main.
        Command::new("git")
            .args(["switch", "-c", "feat"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        fs::write(dir.path().join("feat.txt"), "x").unwrap();
        Command::new("git")
            .args(["add", "feat.txt"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-q", "-m", "feat work"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["switch", "main"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        // Fast-forward main to feat.
        Command::new("git")
            .args(["merge", "-q", "--ff-only", "feat"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        dir
    }

    #[test]
    fn merged_branch_lands_in_prune_plan_as_branch_only() {
        let d = init_repo_with_merged_branch();
        let repo = ProcessRepo::at(d.path()).unwrap();
        let snapshot = repo.capture_refs().unwrap();
        let worktrees = repo.list_worktrees().unwrap();
        let plan = build_prune_plan(&repo, &worktrees, &snapshot, "main").unwrap();
        assert_eq!(plan.integration_target, "main");
        assert!(plan.candidates.iter().any(
            |c| c.branch.as_deref() == Some("feat") && c.kind == PruneCandidateKind::BranchOnly
        ));
    }

    #[test]
    fn target_branch_never_lands_in_plan() {
        let d = init_repo_with_merged_branch();
        let repo = ProcessRepo::at(d.path()).unwrap();
        let snapshot = repo.capture_refs().unwrap();
        let worktrees = repo.list_worktrees().unwrap();
        let plan = build_prune_plan(&repo, &worktrees, &snapshot, "main").unwrap();
        assert!(
            !plan
                .candidates
                .iter()
                .any(|c| c.branch.as_deref() == Some("main"))
        );
    }

    #[test]
    fn kind_as_str_is_stable() {
        assert_eq!(PruneCandidateKind::Current.as_str(), "current");
        assert_eq!(PruneCandidateKind::Other.as_str(), "worktree");
        assert_eq!(PruneCandidateKind::BranchOnly.as_str(), "branch_only");
    }
}
