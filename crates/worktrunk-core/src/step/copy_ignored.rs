// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Pure SDK for `wt step copy-ignored` — copy gitignored files between worktrees.
//!
//! Extracted from `worktrunk::commands::step::copy_ignored` per ADR-078. The
//! CLI version mixes path resolution, file copying, progress reporting, JSON
//! output, and styled stderr messaging. This SDK module owns only the algorithm:
//!
//! 1. Given source + destination paths and a list of `worktree_paths` (for the
//!    nested-worktree skip), produce a [`CopyIgnoredPlan`] of entries to copy.
//! 2. Given a plan, execute the copy and return a [`CopyIgnoredOutcome`].
//!
//! The plan/run split lets CLI callers wire `--dry-run` (build plan, render,
//! exit) and live runs (build plan, run, render summary) through one set of
//! primitives.

#![allow(clippy::doc_markdown)] // .worktreeinclude, COW are not Rust items

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::copy::{copy_dir_recursive, copy_leaf};
use crate::progress::Progress;
use crate::step::shared::list_and_filter_ignored_entries;

/// A plan describing which entries `step::copy_ignored::run_copy_ignored`
/// would copy from `source` to `destination`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopyIgnoredPlan {
    /// Source worktree path (absolute).
    pub source: PathBuf,
    /// Destination worktree path (absolute).
    pub destination: PathBuf,
    /// Entries the plan would copy. Each `(path, is_dir)` is relative to
    /// `source` after applying the same path stripping as the CLI version.
    pub entries: Vec<(PathBuf, bool)>,
    /// When `true`, source and destination resolve to the same path; the
    /// plan is empty regardless of `entries`.
    pub same_worktree: bool,
}

/// The outcome of executing a [`CopyIgnoredPlan`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CopyIgnoredOutcome {
    /// Number of leaf files successfully copied (recursive copies expand
    /// directories to their constituent files).
    pub files: usize,
    /// Total bytes copied.
    pub bytes: u64,
}

/// Build a [`CopyIgnoredPlan`] from a `(source, destination, worktree_paths,
/// excludes)` quadruple.
///
/// This is the SDK entry point that mirrors the CLI's pre-copy planning:
/// resolves the entries via [`list_and_filter_ignored_entries`], detects the
/// "same worktree" no-op case, and packs everything into a serialisable plan.
///
/// # Errors
///
/// Returns any error from [`list_and_filter_ignored_entries`].
pub fn plan_copy_ignored(
    source: &Path,
    destination: &Path,
    source_context: &str,
    worktree_paths: &[PathBuf],
    exclude_patterns: &[String],
) -> Result<CopyIgnoredPlan> {
    if source == destination {
        return Ok(CopyIgnoredPlan {
            source: source.to_path_buf(),
            destination: destination.to_path_buf(),
            entries: Vec::new(),
            same_worktree: true,
        });
    }
    let entries =
        list_and_filter_ignored_entries(source, source_context, worktree_paths, exclude_patterns)?;
    Ok(CopyIgnoredPlan {
        source: source.to_path_buf(),
        destination: destination.to_path_buf(),
        entries,
        same_worktree: false,
    })
}

/// Execute a [`CopyIgnoredPlan`].
///
/// `force` matches the CLI flag: when `true`, leaf files overwrite existing
/// destination files; when `false`, pre-existing files are skipped.
///
/// `progress` is the [`Progress`] reporter the copy engine notifies; pass
/// [`Progress::disabled`] to suppress.
///
/// # Errors
///
/// Returns any error from `copy_dir_recursive` / `copy_leaf` / `fs::create_dir_all`.
/// The error context names the relative path that failed so CLI callers can
/// surface useful messages.
pub fn run_copy_ignored(
    plan: &CopyIgnoredPlan,
    force: bool,
    progress: &Progress,
) -> Result<CopyIgnoredOutcome> {
    let mut copied_count: usize = 0;
    let mut copied_bytes: u64 = 0;
    if plan.same_worktree {
        return Ok(CopyIgnoredOutcome::default());
    }
    for (src_entry, is_dir) in &plan.entries {
        let relative = src_entry
            .strip_prefix(&plan.source)
            .with_context(|| format!("entry not under source: {}", src_entry.display()))?;
        let dest_entry = plan.destination.join(relative);

        if *is_dir {
            let (n, b) = copy_dir_recursive(
                src_entry,
                &dest_entry,
                Some(&plan.destination),
                force,
                progress,
            )
            .with_context(|| format!("copying directory {}", relative.display()))?;
            copied_count += n;
            copied_bytes += b;
        } else {
            if let Some(parent) = dest_entry.parent() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("creating directory for {}", relative.display()))?;
            }
            if let Some(bytes) = copy_leaf(src_entry, &dest_entry, Some(&plan.destination), force)?
            {
                copied_count += 1;
                copied_bytes += bytes;
                progress.record(bytes);
            }
        }
    }
    Ok(CopyIgnoredOutcome {
        files: copied_count,
        bytes: copied_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn init_repo_with_ignored() -> TempDir {
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
        fs::write(dir.path().join(".gitignore"), "build/\n").unwrap();
        fs::write(dir.path().join("README.md"), "hi\n").unwrap();
        Command::new("git")
            .args(["add", ".gitignore", "README.md"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-q", "-m", "init"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        fs::create_dir_all(dir.path().join("build")).unwrap();
        fs::write(dir.path().join("build/out.txt"), "payload").unwrap();
        dir
    }

    #[test]
    fn same_worktree_plan_is_a_noop() {
        let d = init_repo_with_ignored();
        let plan = plan_copy_ignored(d.path(), d.path(), "test", &[], &[]).unwrap();
        assert!(plan.same_worktree);
        let outcome = run_copy_ignored(&plan, false, &Progress::disabled()).unwrap();
        assert_eq!(outcome.files, 0);
        assert_eq!(outcome.bytes, 0);
    }

    #[test]
    fn plan_lists_ignored_directory_then_runs_copies() {
        let src = init_repo_with_ignored();
        let dst = TempDir::new().unwrap();
        fs::create_dir_all(dst.path()).unwrap();

        let plan = plan_copy_ignored(
            src.path(),
            dst.path(),
            "test",
            &[src.path().to_path_buf()],
            &[],
        )
        .unwrap();
        assert!(!plan.same_worktree);
        assert!(plan.entries.iter().any(|(p, is_dir)| {
            *is_dir && p.file_name().and_then(|n| n.to_str()) == Some("build")
        }));

        let outcome = run_copy_ignored(&plan, true, &Progress::disabled()).unwrap();
        // build/out.txt copied — 1 file, 7 bytes.
        assert!(outcome.files >= 1);
        assert!(dst.path().join("build/out.txt").exists());
        assert_eq!(
            fs::read_to_string(dst.path().join("build/out.txt")).unwrap(),
            "payload"
        );
    }

    #[test]
    fn run_with_excludes_skips_filtered_paths() {
        let src = init_repo_with_ignored();
        // Add a second ignored leaf that the exclude list will skip.
        fs::write(src.path().join("scratch.log"), "noise").unwrap();
        fs::write(src.path().join(".gitignore"), "build/\nscratch.log\n").unwrap();
        // re-init the index
        Command::new("git")
            .args(["add", ".gitignore"])
            .current_dir(src.path())
            .status()
            .unwrap();

        let dst = TempDir::new().unwrap();
        fs::create_dir_all(dst.path()).unwrap();

        let plan = plan_copy_ignored(
            src.path(),
            dst.path(),
            "test",
            &[src.path().to_path_buf()],
            &["scratch.log".to_string()],
        )
        .unwrap();
        assert!(
            !plan
                .entries
                .iter()
                .any(|(p, _)| p.file_name().and_then(|n| n.to_str()) == Some("scratch.log"))
        );
    }
}
