// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Shared discovery primitives used by `step::copy_ignored` and `step::promote`.
//!
//! Extracted from `worktrunk::commands::step::shared` per ADR-078. The CLI
//! version also owned `print_dry_run` (commit-message preview formatting) and
//! `resolve_copy_ignored_config` (TOML loader + UI message). Those two
//! responsibilities are CLI concerns and stay in the CLI binary. The discovery
//! primitives — listing gitignored entries via `git ls-files` and filtering
//! them through `.worktreeinclude` + configured excludes + VCS-metadata
//! excludes + nested-worktree excludes — are pure SDK.

#![allow(clippy::doc_markdown)] // `.worktreeinclude` and VCS markers are not Rust items

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, anyhow, bail};
use ignore::gitignore::GitignoreBuilder;

/// Built-in excludes for `wt step copy-ignored`: VCS metadata + tool-state directories.
///
/// VCS directories contain internal state tied to a specific working
/// directory. Git's own `.git` is implicitly excluded (git ls-files never
/// reports it), but other VCS tools colocated with git need explicit
/// exclusion. Tool-state directories (`.conductor/`, `.worktrees/`, etc.) are
/// project-local state that shouldn't be shared between worktrees.
pub const BUILTIN_COPY_IGNORED_EXCLUDES: &[&str] = &[
    ".bzr/",
    ".conductor/",
    ".entire/",
    ".hg/",
    ".jj/",
    ".pijul/",
    ".sl/",
    ".svn/",
    ".worktrees/",
];

/// List ignored entries via `git ls-files --ignored --exclude-standard -o --directory`.
///
/// The `--directory` flag stops at directory boundaries so the result is a
/// top-level set of ignored files+directories, not a per-file expansion of
/// thousands of leaves.
///
/// Each result is `(absolute_path, is_dir)` where `is_dir` is derived from the
/// trailing slash git emits in porcelain output.
///
/// # Errors
///
/// Returns an error when `git` fails to invoke or exits non-zero. The error
/// includes the failure context string so callers can surface "in worktree X"
/// detail.
pub fn list_ignored_entries(worktree_path: &Path, context: &str) -> Result<Vec<(PathBuf, bool)>> {
    let output = Command::new("git")
        .args([
            "ls-files",
            "--ignored",
            "--exclude-standard",
            "-o",
            "--directory",
        ])
        .current_dir(worktree_path)
        .output()
        .with_context(|| format!("failed to invoke git ls-files ({context})"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("git ls-files failed ({context}): {}", stderr.trim());
    }

    let entries = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| {
            let is_dir = line.ends_with('/');
            let path = worktree_path.join(line.trim_end_matches('/'));
            (path, is_dir)
        })
        .collect();

    Ok(entries)
}

/// Filter raw ignored entries through `.worktreeinclude` + configured excludes
/// + built-in VCS-metadata excludes + nested-worktree paths.
///
/// Combines five steps from the CLI version:
///
/// 1. `.worktreeinclude` filtering — only matching entries if the file exists.
/// 2. `[step.copy-ignored].exclude` filtering — skip entries matching
///    configured patterns.
/// 3. Built-in exclude filtering — always skip VCS metadata and tool-state
///    directories.
/// 4. Nested worktree filtering — exclude entries that contain other
///    worktrees from `worktree_paths`.
///
/// # Errors
///
/// Returns an error if a `.worktreeinclude` line or an `exclude` pattern fails
/// to parse as gitignore syntax.
pub fn filter_ignored_entries(
    worktree_path: &Path,
    entries: Vec<(PathBuf, bool)>,
    worktree_paths: &[PathBuf],
    exclude_patterns: &[String],
) -> Result<Vec<(PathBuf, bool)>> {
    // 1. .worktreeinclude (if present)
    let include_path = worktree_path.join(".worktreeinclude");
    let filtered: Vec<_> = if include_path.exists() {
        let mut builder = GitignoreBuilder::new(worktree_path);
        if let Some(err) = builder.add(&include_path) {
            // Normalise OS-native separators to forward slashes for
            // consistent error messages cross-platform.
            return Err(anyhow!(
                ".worktreeinclude parse error: {}",
                err.to_string().replace('\\', "/")
            ));
        }
        let matcher = builder
            .build()
            .context("building .worktreeinclude matcher")?;
        entries
            .into_iter()
            .filter(|(path, is_dir)| matcher.matched(path, *is_dir).is_ignore())
            .collect()
    } else {
        entries
    };

    // 2. Configured exclude patterns
    let exclude_matcher = if exclude_patterns.is_empty() {
        None
    } else {
        let mut builder = GitignoreBuilder::new(worktree_path);
        for pattern in exclude_patterns {
            builder.add_line(None, pattern).map_err(|err| {
                anyhow!("invalid [step.copy-ignored].exclude pattern {pattern:?}: {err}")
            })?;
        }
        Some(
            builder
                .build()
                .context("building copy-ignored exclude matcher")?,
        )
    };

    // 3 + 4 + 5: apply exclude matcher, built-in excludes, nested-worktree skip
    Ok(filtered
        .into_iter()
        .filter(|(path, is_dir)| {
            if let Some(ref matcher) = exclude_matcher {
                let relative = path.strip_prefix(worktree_path).unwrap_or(path.as_path());
                if matcher.matched(relative, *is_dir).is_ignore() {
                    return false;
                }
            }
            if *is_dir
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|name| {
                        BUILTIN_COPY_IGNORED_EXCLUDES
                            .iter()
                            .any(|pat| pat.trim_end_matches('/') == name)
                    })
            {
                return false;
            }
            !worktree_paths
                .iter()
                .any(|wt_path| wt_path != worktree_path && wt_path.starts_with(path))
        })
        .collect())
}

/// Compose [`list_ignored_entries`] + [`filter_ignored_entries`] into the
/// canonical "list and filter" SDK entry point.
///
/// This is the function the CLI handlers actually call — exposed as a
/// one-liner so consumers don't have to chain two SDK calls.
///
/// # Errors
///
/// See [`list_ignored_entries`] and [`filter_ignored_entries`].
pub fn list_and_filter_ignored_entries(
    worktree_path: &Path,
    context: &str,
    worktree_paths: &[PathBuf],
    exclude_patterns: &[String],
) -> Result<Vec<(PathBuf, bool)>> {
    let raw = list_ignored_entries(worktree_path, context)?;
    filter_ignored_entries(worktree_path, raw, worktree_paths, exclude_patterns)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "t10220@worktrunk.test"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "T10220"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        // gitignore + a tracked README so the repo isn't bare
        fs::write(dir.path().join(".gitignore"), "build/\n*.log\n").unwrap();
        fs::write(dir.path().join("README.md"), "hello\n").unwrap();
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
        dir
    }

    #[test]
    fn list_ignored_entries_picks_up_gitignored_dirs() {
        let d = init_repo();
        // Create some gitignored content
        fs::create_dir_all(d.path().join("build/obj")).unwrap();
        fs::write(d.path().join("build/obj/a.o"), "").unwrap();
        fs::write(d.path().join("app.log"), "").unwrap();

        let entries = list_ignored_entries(d.path(), "test").unwrap();
        let names: Vec<_> = entries
            .iter()
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|n| n == "build"));
        assert!(names.iter().any(|n| n == "app.log"));
    }

    #[test]
    fn filter_skips_builtin_vcs_metadata() {
        let d = init_repo();
        // .jj/ is on the built-in excludes list
        fs::create_dir_all(d.path().join(".jj")).unwrap();
        fs::write(d.path().join(".jj/info"), "").unwrap();

        let entries = list_ignored_entries(d.path(), "test").unwrap();
        let filtered =
            filter_ignored_entries(d.path(), entries, &[d.path().to_path_buf()], &[]).unwrap();
        // .jj should be stripped
        assert!(
            !filtered
                .iter()
                .any(|(p, _)| p.file_name().and_then(|n| n.to_str()) == Some(".jj"))
        );
    }

    #[test]
    fn filter_respects_configured_excludes() {
        let d = init_repo();
        fs::create_dir_all(d.path().join("build/obj")).unwrap();
        fs::write(d.path().join("build/obj/a.o"), "").unwrap();
        fs::write(d.path().join("app.log"), "").unwrap();

        let entries = list_ignored_entries(d.path(), "test").unwrap();
        let filtered = filter_ignored_entries(
            d.path(),
            entries,
            &[d.path().to_path_buf()],
            &["*.log".to_string()],
        )
        .unwrap();
        assert!(
            !filtered
                .iter()
                .any(|(p, _)| p.file_name().and_then(|n| n.to_str()) == Some("app.log"))
        );
    }

    #[test]
    fn filter_accepts_well_formed_patterns() {
        let d = init_repo();
        let entries = list_ignored_entries(d.path(), "test").unwrap();
        // Well-formed glob — should not error and must round-trip through
        // the builder. The `ignore` crate is permissive about character
        // class syntax so we can't reliably test the negative path without
        // version pinning.
        let res = filter_ignored_entries(
            d.path(),
            entries,
            &[d.path().to_path_buf()],
            &["**/.cache/**".to_string()],
        );
        assert!(
            res.is_ok(),
            "well-formed pattern should be accepted: {res:?}"
        );
    }
}
