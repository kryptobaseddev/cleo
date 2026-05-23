// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Pure SDK for the `wt step squash` core classification.
//!
//! The CLI version of `handle_squash` braids together six independent
//! responsibilities:
//!
//! 1. Hook approval / hook gating / hook firing.
//! 2. LLM-driven commit-message generation.
//! 3. Auto-staging via `git add`.
//! 4. Merge-base lookup + commit counting + diff stats.
//! 5. Branch sanity (detached HEAD / target-ref resolution).
//! 6. Final `git reset --soft` + `git commit` mechanics.
//!
//! Of those six, ONLY items 4 and 5 are pure git-data computations. The other
//! four are either CLI orchestration (1, 6) or out-of-scope concerns
//! (2, 3 — LLM, side-effecting auto-stage). This module owns 4 + 5 — i.e. the
//! classification step that decides whether a squash is meaningful.
//!
//! CLI callers compose [`SquashInputs`] (`target_ref` + `has_staged`), call
//! [`classify_squash`], and consume a [`SquashClassification`] enum to drive
//! the rest of the flow.

#![allow(clippy::doc_markdown)] // TOCTOU is not a Rust item

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::git::Repo;

/// Caller-supplied inputs to [`classify_squash`].
#[derive(Debug, Clone)]
pub struct SquashInputs<'a> {
    /// User-supplied target ref (branch, tag, or SHA) for the merge-base
    /// computation. CLI resolves this via `Repo::require_target_ref`; we
    /// accept the already-resolved string to keep this function pure.
    pub target_ref: &'a str,
    /// Whether the current worktree has staged changes (CLI checks via
    /// `WorkingTree::has_staged_changes`).
    pub has_staged: bool,
}

/// Result of classifying a potential squash operation against a target ref.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SquashClassification {
    /// No commits ahead of `target_ref` AND no staged changes → nothing to
    /// squash.
    NoCommitsAhead {
        /// The integration target (echoed for downstream messaging).
        target: String,
    },
    /// Exactly one commit ahead of `target_ref` AND no staged changes →
    /// already squashed.
    AlreadySingleCommit,
    /// Zero commits ahead but staged changes present → equivalent to a fresh
    /// commit, no squash needed.
    StagedOnly {
        /// The integration target (echoed).
        target: String,
        /// Merge-base SHA between `HEAD` and `target_ref`.
        merge_base: String,
    },
    /// Squash-eligible: ≥1 commit AND staged changes, OR ≥2 commits.
    Squashable {
        /// The integration target (echoed).
        target: String,
        /// Merge-base SHA — the soft-reset target.
        merge_base: String,
        /// Number of commits ahead of `merge_base`.
        commit_count: u64,
        /// Commit subjects (newest first), capped by [`SUBJECT_LIMIT`].
        subjects: Vec<String>,
        /// `git diff --shortstat <merge_base>..HEAD` summary text.
        diff_summary: String,
    },
}

/// Maximum number of commit subjects fetched into a [`SquashClassification`].
///
/// The CLI version of the LLM prompt builder caps this around 30; we expose
/// the constant so consumers can override via [`classify_squash_with_limit`].
pub const SUBJECT_LIMIT: usize = 30;

/// Classify a potential squash against `inputs.target_ref` using the default
/// subject limit [`SUBJECT_LIMIT`].
///
/// # Errors
///
/// Returns errors from `Repo::merge_base`, `Repo::count_commits`,
/// `Repo::commit_subjects`, or `Repo::diff_stats_summary` — i.e. any failure
/// in the underlying git plumbing.
pub fn classify_squash(repo: &dyn Repo, inputs: SquashInputs<'_>) -> Result<SquashClassification> {
    classify_squash_with_limit(repo, inputs, SUBJECT_LIMIT)
}

/// Same as [`classify_squash`] but with a caller-controlled subject limit.
///
/// # Errors
///
/// See [`classify_squash`].
pub fn classify_squash_with_limit(
    repo: &dyn Repo,
    inputs: SquashInputs<'_>,
    subject_limit: usize,
) -> Result<SquashClassification> {
    let merge_base = repo.merge_base("HEAD", inputs.target_ref)?.ok_or_else(|| {
        anyhow::anyhow!("no common ancestor with target ref {}", inputs.target_ref)
    })?;

    let range = format!("{merge_base}..HEAD");
    let commit_count = repo.count_commits(&range)?;

    if commit_count == 0 && !inputs.has_staged {
        return Ok(SquashClassification::NoCommitsAhead {
            target: inputs.target_ref.to_string(),
        });
    }
    if commit_count == 1 && !inputs.has_staged {
        return Ok(SquashClassification::AlreadySingleCommit);
    }
    if commit_count == 0 && inputs.has_staged {
        return Ok(SquashClassification::StagedOnly {
            target: inputs.target_ref.to_string(),
            merge_base,
        });
    }

    // Squash-eligible. Fetch subjects + diff stats.
    let subjects = repo.commit_subjects(&range, subject_limit)?;
    let diff_summary = repo
        .diff_stats_summary(&merge_base, "HEAD")
        .unwrap_or_default();
    Ok(SquashClassification::Squashable {
        target: inputs.target_ref.to_string(),
        merge_base,
        commit_count,
        subjects,
        diff_summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::ProcessRepo;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn init_repo() -> TempDir {
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
        dir
    }

    fn add_commits(dir: &Path, n: u32) {
        for i in 1..=n {
            fs::write(dir.join(format!("f{i}.txt")), "x").unwrap();
            Command::new("git")
                .args(["add", &format!("f{i}.txt")])
                .current_dir(dir)
                .status()
                .unwrap();
            Command::new("git")
                .args(["commit", "-q", "-m", &format!("c{i}")])
                .current_dir(dir)
                .status()
                .unwrap();
        }
    }

    use std::path::Path;

    #[test]
    fn classify_no_commits_ahead_returns_variant() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        // HEAD == HEAD: zero commits ahead, no staged changes.
        let c = classify_squash(
            &repo,
            SquashInputs {
                target_ref: "HEAD",
                has_staged: false,
            },
        )
        .unwrap();
        assert!(matches!(c, SquashClassification::NoCommitsAhead { .. }));
    }

    #[test]
    fn classify_already_single_commit() {
        let d = init_repo();
        // Create a branch one commit ahead of main.
        Command::new("git")
            .args(["switch", "-c", "feat", "main"])
            .current_dir(d.path())
            .status()
            .unwrap();
        add_commits(d.path(), 1);
        let repo = ProcessRepo::at(d.path()).unwrap();
        let c = classify_squash(
            &repo,
            SquashInputs {
                target_ref: "main",
                has_staged: false,
            },
        )
        .unwrap();
        assert!(matches!(c, SquashClassification::AlreadySingleCommit));
    }

    #[test]
    fn classify_squashable_returns_subjects_and_count() {
        let d = init_repo();
        Command::new("git")
            .args(["switch", "-c", "feat", "main"])
            .current_dir(d.path())
            .status()
            .unwrap();
        add_commits(d.path(), 3);
        let repo = ProcessRepo::at(d.path()).unwrap();
        let c = classify_squash(
            &repo,
            SquashInputs {
                target_ref: "main",
                has_staged: false,
            },
        )
        .unwrap();
        match c {
            SquashClassification::Squashable {
                commit_count,
                subjects,
                ..
            } => {
                assert_eq!(commit_count, 3);
                // Newest-first ordering — c3 should be first.
                assert!(subjects.first().is_some_and(|s| s.contains('c')));
            }
            other => panic!("expected Squashable, got {other:?}"),
        }
    }

    #[test]
    fn classify_no_common_ancestor_errors() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        // Use a SHA that doesn't exist — merge-base will fail and propagate.
        let res = classify_squash(
            &repo,
            SquashInputs {
                target_ref: "0000000000000000000000000000000000000000",
                has_staged: false,
            },
        );
        assert!(res.is_err());
    }
}
