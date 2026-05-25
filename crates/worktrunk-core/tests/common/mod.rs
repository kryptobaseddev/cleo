// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Shared helpers for the parity test suite (T10222).
//!
//! Owns:
//!
//! - [`init_repo`] — create a minimal git repo inside a `TempDir`.
//! - [`commit_all`] — stage everything and commit with a fixed message.
//! - [`add_worktree`] — wrapper around `git worktree add`.
//! - [`wt_binary`] / [`wt_available`] — discovery + opt-out for the donor CLI.
//! - [`run_wt`] — invoke the `wt` binary with structured capture.

#![allow(dead_code)] // Per-module visibility — not every parity test uses every helper.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

/// Initialise an empty git repository in a fresh `TempDir`.
///
/// Configures `user.name` + `user.email` so commits don't fail under CI
/// runners that ship without a global git identity. Disables GPG signing
/// and uses `main` as the initial branch for deterministic refs.
pub fn init_repo() -> TempDir {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path();

    git(path, &["init", "--initial-branch=main"]).expect("git init");
    git(path, &["config", "user.email", "parity@example.com"]).expect("config email");
    git(path, &["config", "user.name", "Parity Tests"]).expect("config name");
    git(path, &["config", "commit.gpgsign", "false"]).expect("config gpgsign");
    git(path, &["config", "tag.gpgsign", "false"]).expect("config tag.gpgsign");

    dir
}

/// `git -C <path> <args...>` — returns an error if the command exits non-zero.
pub fn git(path: &Path, args: &[&str]) -> std::io::Result<Output> {
    let out = Command::new("git").current_dir(path).args(args).output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        return Err(std::io::Error::other(format!(
            "git {} failed in {}: {}",
            args.join(" "),
            path.display(),
            stderr.trim()
        )));
    }
    Ok(out)
}

/// Stage everything in `path` and create a commit with `message`.
pub fn commit_all(path: &Path, message: &str) {
    git(path, &["add", "-A"]).expect("git add");
    git(path, &["commit", "--allow-empty", "-m", message]).expect("git commit");
}

/// Add a linked worktree at `wt_path` checking out `branch`. Creates `branch`
/// off the current `HEAD` if it doesn't exist yet.
pub fn add_worktree(repo_path: &Path, wt_path: &Path, branch: &str) {
    // Try to create+checkout new branch first; fall back to plain checkout if
    // the branch already exists.
    if git(
        repo_path,
        &["worktree", "add", "-b", branch, wt_path.to_str().unwrap()],
    )
    .is_err()
    {
        git(
            repo_path,
            &["worktree", "add", wt_path.to_str().unwrap(), branch],
        )
        .expect("git worktree add (existing branch)");
    }
}

/// Write a file at `<base>/<relative>` with `content`. Creates parent dirs.
pub fn write(base: &Path, relative: &str, content: &str) {
    let path = base.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create dir");
    }
    std::fs::write(path, content).expect("write file");
}

/// Resolve the path to the donor `wt` binary.
///
/// Search order:
/// 1. `WORKTRUNK_WT_BIN` environment variable (highest priority — lets CI
///    point at a built artifact in a non-canonical location).
/// 2. `/mnt/projects/worktrunk/target/release/wt` (canonical local devloop).
/// 3. `/mnt/projects/worktrunk/target/debug/wt` (cheap local build).
/// 4. `wt` on the host `PATH`.
///
/// Returns `None` if none resolve to an existing file.
#[must_use]
pub fn wt_binary() -> Option<PathBuf> {
    if let Ok(env) = std::env::var("WORKTRUNK_WT_BIN") {
        let p = PathBuf::from(env);
        if p.exists() {
            return Some(p);
        }
    }
    for candidate in [
        "/mnt/projects/worktrunk/target/release/wt",
        "/mnt/projects/worktrunk/target/debug/wt",
    ] {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return Some(p);
        }
    }
    // PATH lookup
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let candidate = dir.join("wt");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Convenience predicate — `true` when [`wt_binary`] resolves.
#[must_use]
pub fn wt_available() -> bool {
    wt_binary().is_some()
}

/// Invoke the `wt` binary with `args` and `cwd`. Returns the raw `Output`.
///
/// # Panics
///
/// Panics if the binary cannot be resolved — callers that might run without
/// the binary should gate on [`wt_available`] first (or use `#[ignore]`).
pub fn run_wt(cwd: &Path, args: &[&str]) -> Output {
    let bin = wt_binary().expect("wt binary not available — gate the test with wt_available()");
    Command::new(bin)
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("failed to invoke wt")
}
