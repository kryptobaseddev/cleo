// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Pure SDK for `wt step promote` — branch-swap between two worktrees.
//!
//! Extracted from `worktrunk::commands::step::promote` per ADR-078. The CLI
//! version mixes path/branch resolution, leftover-staging detection, file
//! movement, the actual `git switch` exchange, success messaging, and
//! mismatch warnings. This SDK module owns:
//!
//! - [`move_or_copy_entry`] — `fs::rename` with cross-device fallback.
//! - [`stage_ignored_files`] — pre-exchange move of both worktrees' ignored
//!   files into staging.
//! - [`distribute_staged_files`] — post-exchange distribution.
//! - [`exchange_branches`] — the four-step `git switch --detach` dance.
//! - [`plan_promote`] / [`PromotePlan`] / [`PromoteOutcome`] — the high-level
//!   API: build a plan, run a plan, produce a typed outcome.
//!
//! Hook firing, approval prompts, output messages, mismatch-warning
//! presentation, default-branch lookups: ALL CLI concerns.

#![allow(clippy::doc_markdown)] // EXDEV / TOCTOU are not Rust items

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::copy::{copy_dir_recursive, copy_leaf};
use crate::git::Repo;
use crate::progress::Progress;

/// Sub-dir under the repo's `wt` state directory where promote stages ignored
/// files during the swap. Mirrors `PROMOTE_STAGING_DIR` from the CLI.
pub const PROMOTE_STAGING_DIR: &str = "staging/promote";

/// Move a file or directory, falling back to copy+delete on cross-device errors.
///
/// `fs::rename` is the fast path. When it returns
/// `io::ErrorKind::CrossesDevices`, this function falls back to a full
/// recursive copy followed by `remove_*`. The original failure metadata is
/// preserved as the error context.
///
/// # Errors
///
/// Returns an error from `fs::rename`, the fallback copy, or the fallback
/// removal — whichever step actually failed.
pub fn move_or_copy_entry(src: &Path, dest: &Path, is_dir: bool) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating parent directory for {}", dest.display()))?;
    }
    match fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::CrossesDevices => copy_and_remove(src, dest, is_dir),
        Err(e) => Err(anyhow::Error::from(e).context(format!(
            "moving {} to {}",
            src.display(),
            dest.display()
        ))),
    }
}

fn copy_and_remove(src: &Path, dest: &Path, is_dir: bool) -> Result<()> {
    if is_dir {
        copy_dir_recursive(src, dest, None, true, &Progress::disabled())?;
        fs::remove_dir_all(src)
            .with_context(|| format!("removing source directory {}", src.display()))?;
    } else {
        copy_leaf(src, dest, None, true)?;
        fs::remove_file(src).with_context(|| format!("removing source file {}", src.display()))?;
    }
    Ok(())
}

/// Move both worktrees' ignored entries into a staging directory before a
/// branch exchange.
///
/// `git switch` silently overwrites ignored files that collide with tracked
/// files on the target branch — staging them first prevents data loss.
///
/// Returns `(staging_dir, count_of_entries_staged)`. When `count == 0` the
/// staging directory is cleaned up before returning (defensive against TOCTOU
/// races between listing and staging).
///
/// # Errors
///
/// Returns errors from `fs::create_dir_all`, [`move_or_copy_entry`], or path
/// prefix-stripping when an entry isn't under its declared worktree.
pub fn stage_ignored_files(
    staging_root: &Path,
    path_a: &Path,
    entries_a: &[(PathBuf, bool)],
    path_b: &Path,
    entries_b: &[(PathBuf, bool)],
) -> Result<(PathBuf, usize)> {
    let staging_dir = staging_root.join(PROMOTE_STAGING_DIR);
    fs::create_dir_all(&staging_dir).context("creating promote staging directory")?;

    let staging_a = staging_dir.join("a");
    let staging_b = staging_dir.join("b");
    let mut count = 0;

    for (src_entry, is_dir) in entries_a {
        let relative = src_entry
            .strip_prefix(path_a)
            .context("entry not under worktree A")?;
        let staging_entry = staging_a.join(relative);
        if fs::symlink_metadata(src_entry).is_ok() {
            move_or_copy_entry(src_entry, &staging_entry, *is_dir)
                .with_context(|| format!("staging {}", relative.display()))?;
            count += 1;
        }
    }

    for (src_entry, is_dir) in entries_b {
        let relative = src_entry
            .strip_prefix(path_b)
            .context("entry not under worktree B")?;
        let staging_entry = staging_b.join(relative);
        if fs::symlink_metadata(src_entry).is_ok() {
            move_or_copy_entry(src_entry, &staging_entry, *is_dir)
                .with_context(|| format!("staging {}", relative.display()))?;
            count += 1;
        }
    }

    if count == 0 && staging_dir.exists() {
        let _ = fs::remove_dir_all(&staging_dir);
    }

    Ok((staging_dir, count))
}

/// Distribute staged ignored files to their new worktrees after a branch
/// exchange.
///
/// B's original files (under `staging/b`) go to worktree A (which now has B's
/// branch). A's original files (under `staging/a`) go to worktree B.
///
/// The staging directory is best-effort removed before returning.
///
/// # Errors
///
/// Returns the first error from [`move_or_copy_entry`] or path prefix
/// stripping.
pub fn distribute_staged_files(
    staging_dir: &Path,
    path_a: &Path,
    entries_a: &[(PathBuf, bool)],
    path_b: &Path,
    entries_b: &[(PathBuf, bool)],
) -> Result<usize> {
    let staging_a = staging_dir.join("a");
    let staging_b = staging_dir.join("b");
    let mut count = 0;

    for (src_entry, is_dir) in entries_b {
        let relative = src_entry
            .strip_prefix(path_b)
            .context("entry not under worktree B")?;
        let staging_entry = staging_b.join(relative);
        let dest_entry = path_a.join(relative);
        if fs::symlink_metadata(&staging_entry).is_ok() {
            move_or_copy_entry(&staging_entry, &dest_entry, *is_dir)
                .with_context(|| format!("distributing {}", relative.display()))?;
            count += 1;
        }
    }

    for (src_entry, is_dir) in entries_a {
        let relative = src_entry
            .strip_prefix(path_a)
            .context("entry not under worktree A")?;
        let staging_entry = staging_a.join(relative);
        let dest_entry = path_b.join(relative);
        if fs::symlink_metadata(&staging_entry).is_ok() {
            move_or_copy_entry(&staging_entry, &dest_entry, *is_dir)
                .with_context(|| format!("distributing {}", relative.display()))?;
            count += 1;
        }
    }

    let _ = fs::remove_dir_all(staging_dir);
    Ok(count)
}

/// Perform the four-step `git switch --detach` dance that swaps two branches
/// between two worktrees.
///
/// Steps: detach target → detach main → switch main → switch target. Both
/// worktrees MUST be clean before this is called (the SDK does NOT verify;
/// CLI callers run `ensure_clean` first).
///
/// `run_in_worktree` is a callback supplied by the caller (typically wrapping
/// `Repo::run_command` with `current_dir` set to the per-worktree root). It
/// returns the exit code or an error.
///
/// # Errors
///
/// Returns the first failing step with a context label.
pub fn exchange_branches<F>(
    main_worktree_root: &Path,
    main_branch: &str,
    target_worktree_root: &Path,
    target_branch: &str,
    mut run_in_worktree: F,
) -> Result<()>
where
    F: FnMut(&Path, &[&str]) -> Result<()>,
{
    let steps: [(&Path, &[&str], &str); 4] = [
        (
            target_worktree_root,
            &["switch", "--detach"],
            "detach target",
        ),
        (main_worktree_root, &["switch", "--detach"], "detach main"),
        (
            main_worktree_root,
            &["switch", "--end-of-options", target_branch],
            "switch main",
        ),
        (
            target_worktree_root,
            &["switch", "--end-of-options", main_branch],
            "switch target",
        ),
    ];
    for (root, args, label) in steps {
        run_in_worktree(root, args)
            .with_context(|| format!("branch exchange failed at: {label}"))?;
    }
    Ok(())
}

/// A typed promote plan built BEFORE the swap happens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromotePlan {
    /// Main worktree root.
    pub main_path: PathBuf,
    /// Main worktree's current branch.
    pub main_branch: String,
    /// Target worktree root (the one to promote into main).
    pub target_path: PathBuf,
    /// Branch currently in `target_path`.
    pub target_branch: String,
    /// Whether this plan is a no-op because the target is already in main.
    pub already_in_main: bool,
}

/// Outcome of a successful promote run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PromoteOutcome {
    /// Plan was `already_in_main` — no swap performed.
    AlreadyInMain {
        /// The branch name reported.
        branch: String,
    },
    /// Swap succeeded. Includes count of ignored files re-distributed.
    Promoted {
        /// Branch now in the main worktree (was `target_branch`).
        main_branch: String,
        /// Branch now in the formerly-target worktree (was `main_branch`).
        target_branch: String,
        /// Number of ignored leaves moved across worktrees.
        files_swapped: usize,
    },
}

/// Build a [`PromotePlan`] for swapping `target_branch` into the main worktree.
///
/// `repo.list_worktrees()` is consulted to find the main worktree (entry 0)
/// and the worktree currently holding `target_branch`. The plan is
/// `already_in_main` when those resolve to the same worktree.
///
/// # Errors
///
/// Returns errors from [`Repo::list_worktrees`], or when:
/// - the worktree list is empty
/// - the repo is bare
/// - the main worktree has detached HEAD
/// - no worktree currently checks out `target_branch`
pub fn plan_promote(repo: &dyn Repo, target_branch: &str) -> Result<PromotePlan> {
    let worktrees = repo.list_worktrees()?;
    if worktrees.is_empty() {
        anyhow::bail!("no worktrees found");
    }
    if repo.is_bare()? {
        anyhow::bail!("promote is not supported in bare repositories");
    }
    let main_wt = &worktrees[0];
    let main_branch = main_wt
        .branch
        .clone()
        .ok_or_else(|| anyhow::anyhow!("main worktree has detached HEAD"))?;

    if main_branch == target_branch {
        return Ok(PromotePlan {
            main_path: main_wt.path.clone(),
            main_branch,
            target_path: main_wt.path.clone(),
            target_branch: target_branch.to_string(),
            already_in_main: true,
        });
    }

    let target_wt = worktrees
        .iter()
        .skip(1)
        .find(|wt| wt.branch.as_deref() == Some(target_branch))
        .ok_or_else(|| anyhow::anyhow!("no worktree currently checks out {target_branch}"))?;

    Ok(PromotePlan {
        main_path: main_wt.path.clone(),
        main_branch,
        target_path: target_wt.path.clone(),
        target_branch: target_branch.to_string(),
        already_in_main: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_or_copy_entry_file_renames_within_same_fs() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src.txt");
        let dest = tmp.path().join("sub/dest.txt");
        fs::write(&src, "hi").unwrap();
        move_or_copy_entry(&src, &dest, false).unwrap();
        assert!(!src.exists());
        assert_eq!(fs::read_to_string(&dest).unwrap(), "hi");
    }

    #[test]
    fn move_or_copy_entry_directory_renames_within_same_fs() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("srcdir");
        let dest = tmp.path().join("nested/destdir");
        fs::create_dir_all(src.join("inner")).unwrap();
        fs::write(src.join("inner/f.txt"), "v").unwrap();
        move_or_copy_entry(&src, &dest, true).unwrap();
        assert!(!src.exists());
        assert_eq!(fs::read_to_string(dest.join("inner/f.txt")).unwrap(), "v");
    }

    #[test]
    fn stage_then_distribute_round_trips_files() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        let staging_root = tmp.path().join("repo_state");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::create_dir_all(&staging_root).unwrap();
        fs::write(a.join("from-a.txt"), "from-a").unwrap();
        fs::write(b.join("from-b.txt"), "from-b").unwrap();
        let entries_a = vec![(a.join("from-a.txt"), false)];
        let entries_b = vec![(b.join("from-b.txt"), false)];

        let (staging_dir, count) =
            stage_ignored_files(&staging_root, &a, &entries_a, &b, &entries_b).unwrap();
        assert_eq!(count, 2);
        // Files are now in staging
        assert!(!a.join("from-a.txt").exists());
        assert!(!b.join("from-b.txt").exists());

        let distributed =
            distribute_staged_files(&staging_dir, &a, &entries_a, &b, &entries_b).unwrap();
        assert_eq!(distributed, 2);
        // After distribute: A has B's file, B has A's file
        assert_eq!(fs::read_to_string(a.join("from-b.txt")).unwrap(), "from-b");
        assert_eq!(fs::read_to_string(b.join("from-a.txt")).unwrap(), "from-a");
        // Staging cleaned up
        assert!(!staging_dir.exists());
    }

    #[test]
    fn exchange_branches_invokes_four_steps_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        let target = tmp.path().join("target");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(&target).unwrap();

        let mut log: Vec<String> = Vec::new();
        exchange_branches(
            &main,
            "main-branch",
            &target,
            "target-branch",
            |root, args| {
                log.push(format!("{} {:?}", root.display(), args));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(log.len(), 4);
        // Step order: detach target, detach main, switch main, switch target
        assert!(log[0].contains("target"));
        assert!(log[1].contains("main"));
        assert!(log[2].contains("main"));
        assert!(log[3].contains("target"));
    }

    #[test]
    fn exchange_branches_surfaces_step_error() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        let target = tmp.path().join("target");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(&target).unwrap();
        let res = exchange_branches(&main, "m", &target, "t", |_, _| {
            anyhow::bail!("synthetic git switch failure")
        });
        assert!(res.is_err());
        let msg = format!("{:#}", res.unwrap_err());
        assert!(msg.contains("branch exchange failed at"));
    }
}
