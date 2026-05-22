// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Minimal `git worktree` primitives invoked via [`std::process::Command`].
//!
//! Wraps the five operations CLEO actually needs to provision and tear down
//! agent worktrees:
//!
//! - [`provision_worktree`] — `git worktree add -b <branch> <path> <base>`
//! - [`destroy_worktree`] — `git worktree remove [--force] <path>`
//! - [`list_worktrees`] — parsed output of `git worktree list --porcelain`
//! - [`lock_worktree`] / [`unlock_worktree`] — `git worktree lock` / `unlock`
//!
//! All commands are run with `current_dir(repo_root)` so the SDK never touches
//! the caller's process working directory.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

/// Handle returned from [`provision_worktree`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorktreeHandle {
    /// Absolute path to the new worktree directory.
    pub path: PathBuf,
    /// The branch the worktree checked out (the one passed via `-b`).
    pub branch: String,
    /// The HEAD commit SHA at the moment of creation.
    pub head: String,
}

/// One entry parsed from `git worktree list --porcelain`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorktreeInfo {
    /// Absolute path to the worktree directory.
    pub path: PathBuf,
    /// Branch name (`None` for detached HEAD).
    pub branch: Option<String>,
    /// HEAD commit SHA.
    pub head: String,
    /// Whether the worktree is locked.
    pub is_locked: bool,
    /// Whether the worktree is reported as prunable by git.
    pub is_prunable: bool,
}

/// Provision a new git worktree.
///
/// Runs `git worktree add -b <branch> <target_path> <base_ref>` from
/// `repo_root` and parses HEAD afterwards via `git rev-parse HEAD`.
///
/// # Errors
///
/// Returns an error when `git` exits non-zero or when `target_path` cannot be
/// canonicalized after creation.
pub fn provision_worktree(
    repo_root: &Path,
    target_path: &Path,
    branch: &str,
    base_ref: &str,
) -> anyhow::Result<WorktreeHandle> {
    let output = Command::new("git")
        .args(["worktree", "add", "-b", branch])
        .arg(target_path)
        .arg(base_ref)
        .current_dir(repo_root)
        .output()
        .context("failed to invoke git worktree add")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("git worktree add failed: {}", stderr.trim());
    }

    let head_out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(target_path)
        .output()
        .context("failed to invoke git rev-parse HEAD in new worktree")?;

    if !head_out.status.success() {
        let stderr = String::from_utf8_lossy(&head_out.stderr);
        bail!("git rev-parse HEAD failed: {}", stderr.trim());
    }

    let head = String::from_utf8_lossy(&head_out.stdout).trim().to_string();

    Ok(WorktreeHandle {
        path: target_path.to_path_buf(),
        branch: branch.to_string(),
        head,
    })
}

/// Remove an existing worktree.
///
/// Runs `git worktree remove [--force] <path>` from `repo_root`. When `force`
/// is `true`, the `--force` flag is appended so locked or dirty worktrees can
/// be torn down.
///
/// # Errors
///
/// Returns an error when `git` exits non-zero.
pub fn destroy_worktree(repo_root: &Path, worktree_path: &Path, force: bool) -> anyhow::Result<()> {
    let mut cmd = Command::new("git");
    cmd.args(["worktree", "remove"]);
    if force {
        cmd.arg("--force");
    }
    cmd.arg(worktree_path).current_dir(repo_root);

    let output = cmd
        .output()
        .context("failed to invoke git worktree remove")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("git worktree remove failed: {}", stderr.trim());
    }
    Ok(())
}

/// List all worktrees in `repo_root` via `git worktree list --porcelain`.
///
/// The porcelain format groups records by blank lines and uses key-prefixed
/// lines (e.g. `worktree /path/to/wt`, `HEAD <sha>`, `branch refs/heads/foo`,
/// `locked`, `prunable [<reason>]`, `detached`).
///
/// # Errors
///
/// Returns an error when `git` exits non-zero.
pub fn list_worktrees(repo_root: &Path) -> anyhow::Result<Vec<WorktreeInfo>> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_root)
        .output()
        .context("failed to invoke git worktree list")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("git worktree list failed: {}", stderr.trim());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    Ok(parse_porcelain(&text))
}

fn parse_porcelain(text: &str) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    let mut current: Option<WorktreeInfo> = None;

    for line in text.lines() {
        if line.is_empty() {
            if let Some(info) = current.take() {
                out.push(info);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            // Push any in-progress record (defensive: porcelain output already
            // separates records with blank lines, but be safe).
            if let Some(info) = current.take() {
                out.push(info);
            }
            current = Some(WorktreeInfo {
                path: PathBuf::from(path),
                branch: None,
                head: String::new(),
                is_locked: false,
                is_prunable: false,
            });
        } else if let Some(sha) = line.strip_prefix("HEAD ") {
            if let Some(info) = current.as_mut() {
                info.head = sha.to_string();
            }
        } else if let Some(refname) = line.strip_prefix("branch ") {
            if let Some(info) = current.as_mut() {
                let short = refname.strip_prefix("refs/heads/").unwrap_or(refname);
                info.branch = Some(short.to_string());
            }
        } else if (line == "locked" || line.starts_with("locked "))
            && let Some(info) = current.as_mut()
        {
            info.is_locked = true;
        } else if (line == "prunable" || line.starts_with("prunable "))
            && let Some(info) = current.as_mut()
        {
            info.is_prunable = true;
        }
        // `detached`, `bare`, and unknown lines are ignored — branch stays None.
    }
    if let Some(info) = current.take() {
        out.push(info);
    }
    out
}

/// Lock a worktree.
///
/// Runs `git worktree lock [--reason <reason>] <path>` from `repo_root`.
///
/// # Errors
///
/// Returns an error when `git` exits non-zero.
pub fn lock_worktree(
    repo_root: &Path,
    worktree_path: &Path,
    reason: Option<&str>,
) -> anyhow::Result<()> {
    let mut cmd = Command::new("git");
    cmd.args(["worktree", "lock"]);
    if let Some(reason) = reason {
        cmd.args(["--reason", reason]);
    }
    cmd.arg(worktree_path).current_dir(repo_root);

    let output = cmd.output().context("failed to invoke git worktree lock")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("git worktree lock failed: {}", stderr.trim());
    }
    Ok(())
}

/// Unlock a worktree.
///
/// Runs `git worktree unlock <path>` from `repo_root`.
///
/// # Errors
///
/// Returns an error when `git` exits non-zero.
pub fn unlock_worktree(repo_root: &Path, worktree_path: &Path) -> anyhow::Result<()> {
    let output = Command::new("git")
        .args(["worktree", "unlock"])
        .arg(worktree_path)
        .current_dir(repo_root)
        .output()
        .context("failed to invoke git worktree unlock")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("git worktree unlock failed: {}", stderr.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_with_main_and_branch_worktree() {
        let input = "worktree /repo/main\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/.wt/feat\nHEAD def456\nbranch refs/heads/feat/foo\nlocked\n\n";
        let out = parse_porcelain(input);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path, PathBuf::from("/repo/main"));
        assert_eq!(out[0].head, "abc123");
        assert_eq!(out[0].branch.as_deref(), Some("main"));
        assert!(!out[0].is_locked);
        assert_eq!(out[1].path, PathBuf::from("/repo/.wt/feat"));
        assert_eq!(out[1].head, "def456");
        assert_eq!(out[1].branch.as_deref(), Some("feat/foo"));
        assert!(out[1].is_locked);
    }

    #[test]
    fn parses_porcelain_detached_head() {
        // `detached` lines have no branch; we leave branch as None.
        let input = "worktree /repo/wt\nHEAD abc\ndetached\n\n";
        let out = parse_porcelain(input);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].branch, None);
    }

    #[test]
    fn parses_porcelain_prunable_marker() {
        let input = "worktree /repo/stale\nHEAD abc\nprunable gitdir file points to non-existent location\n\n";
        let out = parse_porcelain(input);
        assert_eq!(out.len(), 1);
        assert!(out[0].is_prunable);
    }

    #[test]
    fn parses_porcelain_handles_trailing_no_blank() {
        // git may omit the trailing blank line; we must still emit the record.
        let input = "worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n";
        let out = parse_porcelain(input);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].head, "abc");
    }
}
