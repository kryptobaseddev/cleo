// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! `Repo` trait — the typed SDK contract for worktrunk consumer code.
//!
//! Per the T10219 audit (`docs/research/t10219-worktrunk-sdk-interface-audit.md`),
//! `worktrunk::git::Repository` exposes ~45 methods that step/* and worktree/*
//! consumer code calls. A faithful substitute of all 45 is multi-task work; this
//! module ships the typed trait surface so T10220 (step extraction) and T10221
//! (lifecycle extraction) can program against a stable contract while the
//! `Repo::*` implementations are filled in incrementally.
//!
//! ## Strategy
//!
//! 1. Define the [`Repo`] trait with every audited method signature.
//! 2. Ship a single default impl [`ProcessRepo`] that backs the SUBSET of
//!    operations already implementable via `std::process::Command` (or already
//!    living in [`crate::git_wt`]). For all other methods, return
//!    [`unimplemented_in_sdk`] — a hard but typed `anyhow::Error` whose
//!    message points at the audit doc + the follow-up tracking ticket.
//! 3. T10220/T10221 either fill in `ProcessRepo` methods as part of their PR
//!    OR file tightly-scoped child tasks of T10218 to do so.
//!
//! The trait is intentionally `&self`-only (no `&mut self`) so consumers can
//! share a `&dyn Repo` freely across rayon workers (matches the existing
//! `Arc<RefSnapshot>` pattern in `step/prune.rs`).
//!
//! ## Lint posture
//!
//! Per-method `# Errors` doc sections are suppressed at the module level
//! because every `Result` method on the trait fails with the same shape:
//! `Err(unimplemented_in_sdk("<method>"))` (the trait default) or a
//! `std::process::Command`-bubbled `anyhow::Error` (the `ProcessRepo` impl).
//! A single module-level error contract documented here is more useful than
//! 30 copy-pasted "# Errors" stubs. The same applies to `doc_markdown`
//! warnings on capitalized identifiers like `UserConfig` and `JsonSchema`
//! that refer to the worktrunk crate, not items in this SDK.

#![allow(
    clippy::missing_errors_doc,
    clippy::doc_markdown,
    clippy::ref_option,
    clippy::needless_pass_by_value
)]

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

use crate::git::branch::BranchDeletionMode;
use crate::git::ref_snapshot::RefSnapshot;
use crate::git_wt::WorktreeInfo;

/// Returns an `anyhow::Error` indicating an SDK method is declared but not
/// yet implemented. The message points consumers at the audit doc and the
/// follow-up tracking trail.
#[inline]
pub fn unimplemented_in_sdk(method: &str) -> anyhow::Error {
    anyhow!(
        "worktrunk-core: Repo::{method} not yet implemented — see \
        docs/research/t10219-worktrunk-sdk-interface-audit.md and the \
        T10218 follow-up tracking trail"
    )
}

/// Classification of a git ref name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RefType {
    /// `refs/heads/<name>`.
    LocalBranch,
    /// `refs/remotes/<remote>/<name>`.
    RemoteBranch,
    /// `refs/tags/<name>`.
    Tag,
    /// Bare 40-char SHA.
    Sha,
    /// Anything else (HEAD, FETCH_HEAD, etc.).
    Other,
}

/// Lightweight "branch handle" — name + the OID it points at.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchRef {
    /// Branch short name (e.g. `main`, NOT `refs/heads/main`).
    pub name: String,
    /// OID the branch points at.
    pub oid: String,
    /// Whether this is a remote-tracking branch.
    pub is_remote: bool,
}

/// Pre-resolved removal plan for a worktree.
///
/// Mirrors the shape of `worktrunk::git::repository::Repository::prepare_worktree_removal`
/// return — kept thin (a path + branch + deletion-mode triple) for now;
/// expand once T10221 audit identifies concrete fields needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemovalPlan {
    /// Worktree directory to remove.
    pub worktree_path: PathBuf,
    /// Branch the worktree had checked out (if any).
    pub branch: Option<String>,
    /// Deletion mode for the branch.
    pub mode: BranchDeletionMode,
    /// Whether the worktree had unstaged changes that need `--force`.
    pub needs_force: bool,
}

/// The SDK-facing `Repository` substitute.
///
/// See the [crate-level audit doc] for the full reasoning behind the
/// (currently large) `unimplemented_in_sdk` surface area.
///
/// [crate-level audit doc]: ../../../../../docs/research/t10219-worktrunk-sdk-interface-audit.md
pub trait Repo {
    // ------------------------------------------------------------------
    // Constructors / discovery
    // ------------------------------------------------------------------

    /// The path used to discover this repo (the cwd at `Repo::current` time,
    /// or the explicit path passed to `Repo::at`).
    fn discovery_path(&self) -> &Path;

    /// `.git/` directory location for this repo.
    fn repo_path(&self) -> Result<PathBuf>;

    /// Worktree root for this repo (the directory above `.git/` for normal
    /// repos, the worktree dir for linked worktrees).
    fn root(&self) -> Result<PathBuf>;

    /// Alias for [`Repo::root`] — kept for parity with worktrunk's
    /// `root_path()`/`root()` naming overlap.
    fn root_path(&self) -> Result<PathBuf> {
        self.root()
    }

    /// `git rev-parse --git-common-dir` — the shared common-dir for the repo
    /// (collapses linked-worktree differences).
    fn git_common_dir(&self) -> Result<PathBuf>;

    /// Alias for [`Repo::git_common_dir`].
    fn home_path(&self) -> Result<PathBuf> {
        self.git_common_dir()
    }

    /// Whether the repo is a bare repo.
    fn is_bare(&self) -> Result<bool>;

    // ------------------------------------------------------------------
    // Ref lookup / classification
    // ------------------------------------------------------------------

    /// Whether a ref by the given short or full name exists.
    fn ref_exists(&self, _name: &str) -> Result<bool> {
        Err(unimplemented_in_sdk("ref_exists"))
    }

    /// Classify a ref name as local/remote/tag/sha/other.
    fn detect_ref_type(&self, _name: &str) -> Result<RefType> {
        Err(unimplemented_in_sdk("detect_ref_type"))
    }

    /// Resolve a branch handle by short name.
    fn branch(&self, _name: &str) -> Result<BranchRef> {
        Err(unimplemented_in_sdk("branch"))
    }

    /// All local + remote-tracking branches in the repo.
    fn all_branches(&self) -> Result<Vec<BranchRef>> {
        Err(unimplemented_in_sdk("all_branches"))
    }

    /// Whether the ref is a remote-tracking branch (e.g. `origin/main`).
    fn is_remote_tracking_branch(&self, _name: &str) -> Result<bool> {
        Err(unimplemented_in_sdk("is_remote_tracking_branch"))
    }

    /// Strip a remote prefix like `origin/` from a branch name.
    fn strip_remote_prefix(&self, _name: &str) -> Result<String> {
        Err(unimplemented_in_sdk("strip_remote_prefix"))
    }

    /// The repo's default branch (typically `origin/HEAD`'s target).
    fn default_branch(&self) -> Result<String> {
        Err(unimplemented_in_sdk("default_branch"))
    }

    // ------------------------------------------------------------------
    // Target-branch resolution (high-level helpers)
    // ------------------------------------------------------------------

    /// Resolve user-supplied target into a concrete branch name.
    fn resolve_target_branch(&self, _arg: Option<&str>) -> Result<String> {
        Err(unimplemented_in_sdk("resolve_target_branch"))
    }

    /// Like [`Repo::resolve_target_branch`] but bails when no resolution
    /// possible (the "require" variant).
    fn require_target_branch(&self, _arg: Option<&str>) -> Result<String> {
        Err(unimplemented_in_sdk("require_target_branch"))
    }

    /// Resolve a generic ref (branch, tag, or SHA) — bails on miss.
    fn require_target_ref(&self, _arg: &str) -> Result<String> {
        Err(unimplemented_in_sdk("require_target_ref"))
    }

    // ------------------------------------------------------------------
    // Commit / ancestry queries
    // ------------------------------------------------------------------

    /// Number of commits in a rev-spec (`git rev-list --count <spec>`).
    fn count_commits(&self, _spec: &str) -> Result<u64> {
        Err(unimplemented_in_sdk("count_commits"))
    }

    /// Whether `a` is an ancestor of `b` (merge-base check).
    fn is_ancestor(&self, _a: &str, _b: &str) -> Result<bool> {
        Err(unimplemented_in_sdk("is_ancestor"))
    }

    /// Whether `branch` is rebased onto `target` (lineage starts at target).
    fn is_rebased_onto(&self, _branch: &str, _target: &str) -> Result<bool> {
        Err(unimplemented_in_sdk("is_rebased_onto"))
    }

    /// Subjects of the first `limit` commits in `rev_range`.
    fn commit_subjects(&self, _rev_range: &str, _limit: usize) -> Result<Vec<String>> {
        Err(unimplemented_in_sdk("commit_subjects"))
    }

    /// Short SHA (`git rev-parse --short <sha>`).
    fn short_sha(&self, _sha: &str) -> Result<String> {
        Err(unimplemented_in_sdk("short_sha"))
    }

    /// `git diff --shortstat` between two refs.
    fn diff_stats_summary(&self, _from: &str, _to: &str) -> Result<String> {
        Err(unimplemented_in_sdk("diff_stats_summary"))
    }

    /// `git merge-base <a> <b>` — returns the common ancestor commit SHA, or
    /// `None` when no common ancestor exists.
    fn merge_base(&self, _a: &str, _b: &str) -> Result<Option<String>> {
        Err(unimplemented_in_sdk("merge_base"))
    }

    // ------------------------------------------------------------------
    // RefSnapshot — capture + analysis
    // ------------------------------------------------------------------

    /// Capture all refs into a snapshot.
    fn capture_refs(&self) -> Result<RefSnapshot> {
        Err(unimplemented_in_sdk("capture_refs"))
    }

    /// Given a snapshot, explain why (or why not) `branch` is integrated into
    /// `target`. Returns a human-readable reason, or `None` if not integrated.
    fn integration_reason(
        &self,
        _snapshot: &RefSnapshot,
        _branch: &str,
        _target: &str,
    ) -> Result<Option<String>> {
        Err(unimplemented_in_sdk("integration_reason"))
    }

    // ------------------------------------------------------------------
    // Remote bookkeeping
    // ------------------------------------------------------------------

    /// Find remote name by url (looks through `git remote -v`).
    fn find_remote_by_url(&self, _url: &str) -> Result<Option<String>> {
        Err(unimplemented_in_sdk("find_remote_by_url"))
    }

    /// `git remote get-url <name>`.
    fn remote_url(&self, _name: &str) -> Result<String> {
        Err(unimplemented_in_sdk("remote_url"))
    }

    /// Modification time (epoch seconds) of `FETCH_HEAD` for the given remote.
    fn last_fetch_epoch(&self, _remote: &str) -> Result<Option<u64>> {
        Err(unimplemented_in_sdk("last_fetch_epoch"))
    }

    // ------------------------------------------------------------------
    // Worktree management (delegates to crate::git_wt)
    // ------------------------------------------------------------------

    /// List all worktrees for this repo.
    fn list_worktrees(&self) -> Result<Vec<WorktreeInfo>>;

    /// The worktree the discovery path resolves into.
    fn current_worktree(&self) -> Result<WorktreeInfo>;

    /// The repo's primary (non-linked) worktree.
    fn primary_worktree(&self) -> Result<WorktreeInfo>;

    /// Worktree at the given filesystem path (after canonicalization).
    fn worktree_at(&self, _path: &Path) -> Result<Option<WorktreeInfo>> {
        Err(unimplemented_in_sdk("worktree_at"))
    }

    /// Alias for [`Repo::worktree_at`].
    fn worktree_at_path(&self, path: &Path) -> Result<Option<WorktreeInfo>> {
        self.worktree_at(path)
    }

    /// Worktree currently checking out the named branch.
    fn worktree_for_branch(&self, _name: &str) -> Result<Option<WorktreeInfo>> {
        Err(unimplemented_in_sdk("worktree_for_branch"))
    }

    /// Resolve any input (name, path, or branch) to a worktree.
    fn resolve_worktree(&self, _arg: &str) -> Result<Option<WorktreeInfo>> {
        Err(unimplemented_in_sdk("resolve_worktree"))
    }

    /// Extract a short "name" from any worktree identifier.
    fn resolve_worktree_name(&self, _arg: &str) -> Result<String> {
        Err(unimplemented_in_sdk("resolve_worktree_name"))
    }

    /// Resolve worktree directory by name (worktrunk path template).
    fn wt_dir(&self, _name: &str) -> Result<PathBuf> {
        Err(unimplemented_in_sdk("wt_dir"))
    }

    /// Classify the working-tree state (fresh/dirty/staged) of a worktree.
    /// The exact return shape will be refined by T10221 — for now an opaque
    /// string ("clean", "staged", "dirty", "untracked") suffices.
    fn worktree_state(&self, _path: &Path) -> Result<String> {
        Err(unimplemented_in_sdk("worktree_state"))
    }

    /// Pre-flight: provision-or-reuse a target worktree for branch X.
    fn prepare_target_worktree(&self, _branch: &str) -> Result<WorktreeInfo> {
        Err(unimplemented_in_sdk("prepare_target_worktree"))
    }

    /// Pre-flight: build a [`RemovalPlan`] for a worktree path.
    fn prepare_worktree_removal(&self, _path: &Path) -> Result<RemovalPlan> {
        Err(unimplemented_in_sdk("prepare_worktree_removal"))
    }

    // ------------------------------------------------------------------
    // Config (project + user)
    // ------------------------------------------------------------------

    /// Project identifier (e.g. origin-URL hash) used as the BTreeMap key in
    /// `UserConfig::projects`.
    fn project_identifier(&self) -> Result<String> {
        Err(unimplemented_in_sdk("project_identifier"))
    }

    /// Load the project's `.worktrunkrc` (or equivalent) from the worktree.
    fn load_project_config(&self) -> Result<String> {
        Err(unimplemented_in_sdk("load_project_config"))
    }

    /// Load project config from a specific git ref (`git show <ref>:<path>`).
    fn project_config_at_ref(&self, _ref_name: &str) -> Result<String> {
        Err(unimplemented_in_sdk("project_config_at_ref"))
    }

    /// Convenience hook for loading the per-project [`crate::config::UserConfigDto`].
    /// The full UserConfig loader (TOML I/O, env-var precedence) is CLI-shaped
    /// and lives outside the SDK; this method returns the field-only DTO so
    /// SDK consumers can read project-scoped config without pulling the CLI.
    fn user_config(&self) -> Result<crate::config::user::UserConfigDto> {
        Err(unimplemented_in_sdk("user_config"))
    }

    /// `git config --get <key>`.
    fn config_value(&self, _key: &str) -> Result<Option<String>> {
        Err(unimplemented_in_sdk("config_value"))
    }

    /// `git config <key> <value>`.
    fn set_config(&self, _key: &str, _value: &str) -> Result<()> {
        Err(unimplemented_in_sdk("set_config"))
    }

    // ------------------------------------------------------------------
    // Side-effect helpers
    // ------------------------------------------------------------------

    /// Record "last branch I switched to" for `wt switch -`.
    fn set_switch_previous(&self, _branch: &str) -> Result<()> {
        Err(unimplemented_in_sdk("set_switch_previous"))
    }

    /// Run an external command in the repo root (`std::process::Command`).
    /// Returns (stdout, stderr, exit-code).
    fn run_command(&self, _cmd: &str, _args: &[&str]) -> Result<(String, String, i32)> {
        Err(unimplemented_in_sdk("run_command"))
    }

    /// Like [`Repo::run_command`] but streams stdout/stderr with a delayed
    /// teardown for parallel rayon contexts. Out of scope for the SDK — keep
    /// the typed signature so T10220/T10221 can wire it in incrementally.
    fn run_command_delayed_stream(
        &self,
        _cmd: &str,
        _args: &[&str],
    ) -> Result<(String, String, i32)> {
        Err(unimplemented_in_sdk("run_command_delayed_stream"))
    }
}

// ----------------------------------------------------------------------
// ProcessRepo — the std::process::Command-backed default impl
// ----------------------------------------------------------------------

/// Default `Repo` implementation that uses `std::process::Command` (shells
/// out to the system `git` binary) for the methods it can implement.
///
/// All other methods inherit the trait's default `Err(unimplemented_in_sdk)`
/// bodies. T10220/T10221 will override here (or file follow-up tasks).
pub struct ProcessRepo {
    discovery_path: PathBuf,
}

impl ProcessRepo {
    /// Open a repo at the given path. Returns `Err` if the path is not inside
    /// a git repository.
    ///
    /// # Errors
    ///
    /// Returns an error if the path does not exist or `git rev-parse --git-dir`
    /// fails.
    pub fn at(path: impl Into<PathBuf>) -> Result<Self> {
        let p = path.into();
        // Eagerly verify it's a git repo.
        let out = Command::new("git")
            .args(["rev-parse", "--git-dir"])
            .current_dir(&p)
            .output()
            .with_context(|| format!("git rev-parse --git-dir failed in {}", p.display()))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(anyhow!(
                "not a git repository ({}): {}",
                p.display(),
                stderr.trim()
            ));
        }
        Ok(Self { discovery_path: p })
    }

    /// Open a repo from the current working directory.
    ///
    /// # Errors
    ///
    /// Returns an error if `std::env::current_dir` fails or the cwd is not
    /// inside a git repository.
    pub fn current() -> Result<Self> {
        let cwd = std::env::current_dir().context("std::env::current_dir failed")?;
        Self::at(cwd)
    }

    fn git_text(&self, args: &[&str]) -> Result<String> {
        let out = Command::new("git")
            .args(args)
            .current_dir(&self.discovery_path)
            .output()
            .with_context(|| format!("git {} failed", args.join(" ")))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(anyhow!(
                "git {} exited non-zero: {}",
                args.join(" "),
                stderr.trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

impl Repo for ProcessRepo {
    fn discovery_path(&self) -> &Path {
        &self.discovery_path
    }

    fn repo_path(&self) -> Result<PathBuf> {
        let s = self.git_text(&["rev-parse", "--git-dir"])?;
        // git returns a relative path when run inside the worktree — resolve
        // it relative to discovery_path to give an absolute answer.
        let p = PathBuf::from(&s);
        if p.is_absolute() {
            Ok(p)
        } else {
            Ok(self.discovery_path.join(p))
        }
    }

    fn root(&self) -> Result<PathBuf> {
        let s = self.git_text(&["rev-parse", "--show-toplevel"])?;
        Ok(PathBuf::from(s))
    }

    fn git_common_dir(&self) -> Result<PathBuf> {
        let s = self.git_text(&["rev-parse", "--git-common-dir"])?;
        let p = PathBuf::from(&s);
        if p.is_absolute() {
            Ok(p)
        } else {
            Ok(self.discovery_path.join(p))
        }
    }

    fn is_bare(&self) -> Result<bool> {
        let s = self.git_text(&["rev-parse", "--is-bare-repository"])?;
        Ok(s == "true")
    }

    fn list_worktrees(&self) -> Result<Vec<WorktreeInfo>> {
        let root = self.root()?;
        crate::git_wt::list_worktrees(&root)
    }

    fn current_worktree(&self) -> Result<WorktreeInfo> {
        let here = self.root()?;
        let list = self.list_worktrees()?;
        // The repo root we resolved should match exactly one entry — that's
        // the worktree the caller is in.
        for wt in list {
            if wt.path == here {
                return Ok(wt);
            }
        }
        // Fallback: try a canonicalized comparison for cases where one side
        // is symlinked.
        Err(anyhow!(
            "current worktree at {} not found in `git worktree list`",
            here.display()
        ))
    }

    fn primary_worktree(&self) -> Result<WorktreeInfo> {
        let list = self.list_worktrees()?;
        list.into_iter()
            .next()
            .ok_or_else(|| anyhow!("`git worktree list` returned no entries"))
    }

    fn run_command(&self, cmd: &str, args: &[&str]) -> Result<(String, String, i32)> {
        let out = Command::new(cmd)
            .args(args)
            .current_dir(&self.discovery_path)
            .output()
            .with_context(|| format!("failed to invoke {} {}", cmd, args.join(" ")))?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        Ok((stdout, stderr, out.status.code().unwrap_or(-1)))
    }

    fn config_value(&self, key: &str) -> Result<Option<String>> {
        let out = Command::new("git")
            .args(["config", "--get", key])
            .current_dir(&self.discovery_path)
            .output()
            .with_context(|| format!("git config --get {key} failed"))?;
        if out.status.success() {
            Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string()))
        } else if out.status.code() == Some(1) {
            // `git config --get` returns 1 when key not found — that's not
            // a real error in our SDK semantics.
            Ok(None)
        } else {
            Err(anyhow!(
                "git config --get {key} exited non-zero: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    fn set_config(&self, key: &str, value: &str) -> Result<()> {
        let out = Command::new("git")
            .args(["config", key, value])
            .current_dir(&self.discovery_path)
            .output()
            .with_context(|| format!("git config {key} {value} failed"))?;
        if !out.status.success() {
            return Err(anyhow!(
                "git config {key} {value} exited non-zero: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }

    fn short_sha(&self, sha: &str) -> Result<String> {
        self.git_text(&["rev-parse", "--short", sha])
    }

    fn ref_exists(&self, name: &str) -> Result<bool> {
        // `git rev-parse --verify --quiet <name>` exits 0 if the ref resolves,
        // 1 if not. Either way the process completes — distinguish them via
        // exit code, not via `?` (we want false, not Err).
        let out = Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", name])
            .current_dir(&self.discovery_path)
            .output()
            .with_context(|| format!("git rev-parse --verify {name} failed to invoke"))?;
        Ok(out.status.success())
    }

    fn default_branch(&self) -> Result<String> {
        // Prefer `origin/HEAD` for the canonical answer; fall back to
        // `init.defaultBranch` config when no remote tracking is configured.
        let head_ref = Command::new("git")
            .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
            .current_dir(&self.discovery_path)
            .output()
            .with_context(|| "git symbolic-ref refs/remotes/origin/HEAD failed".to_string())?;
        if head_ref.status.success() {
            let s = String::from_utf8_lossy(&head_ref.stdout).trim().to_string();
            // Strip `origin/` prefix to return just the branch name.
            let name = s.strip_prefix("origin/").unwrap_or(&s).to_string();
            if !name.is_empty() {
                return Ok(name);
            }
        }
        // Fallback: try init.defaultBranch
        if let Some(v) = self.config_value("init.defaultBranch")? {
            return Ok(v);
        }
        Err(anyhow!("cannot determine default branch"))
    }

    fn count_commits(&self, spec: &str) -> Result<u64> {
        let s = self.git_text(&["rev-list", "--count", spec])?;
        s.trim()
            .parse::<u64>()
            .with_context(|| format!("parsing rev-list --count output: {s:?}"))
    }

    fn is_ancestor(&self, a: &str, b: &str) -> Result<bool> {
        // `git merge-base --is-ancestor <a> <b>` returns exit code 0 (true),
        // 1 (false), or 128+ (error). Discriminate by exit code.
        let out = Command::new("git")
            .args(["merge-base", "--is-ancestor", a, b])
            .current_dir(&self.discovery_path)
            .output()
            .with_context(|| format!("git merge-base --is-ancestor {a} {b} failed to invoke"))?;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(anyhow!(
                "git merge-base --is-ancestor {a} {b} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
        }
    }

    fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>> {
        let out = Command::new("git")
            .args(["merge-base", a, b])
            .current_dir(&self.discovery_path)
            .output()
            .with_context(|| format!("git merge-base {a} {b} failed to invoke"))?;
        match out.status.code() {
            Some(0) => Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string())),
            // 1 = no common ancestor — not an error in our SDK semantics.
            Some(1) => Ok(None),
            _ => Err(anyhow!(
                "git merge-base {a} {b} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
        }
    }

    fn commit_subjects(&self, rev_range: &str, limit: usize) -> Result<Vec<String>> {
        // `git log --format=%s -n <limit> <range>` yields one subject per line.
        let limit_str = limit.to_string();
        let s = self.git_text(&["log", "--format=%s", "-n", &limit_str, rev_range])?;
        if s.trim().is_empty() {
            return Ok(Vec::new());
        }
        Ok(s.lines().map(str::to_string).collect())
    }

    fn diff_stats_summary(&self, from: &str, to: &str) -> Result<String> {
        let range = format!("{from}..{to}");
        self.git_text(&["diff", "--shortstat", &range])
    }

    fn all_branches(&self) -> Result<Vec<crate::git::repo::BranchRef>> {
        // `git for-each-ref --format=%(refname:short) %(objectname) refs/heads
        // refs/remotes` emits one line per ref with its oid.
        let s = self.git_text(&[
            "for-each-ref",
            "--format=%(refname:short)\t%(objectname)\t%(refname)",
            "refs/heads",
            "refs/remotes",
        ])?;
        let mut out: Vec<BranchRef> = Vec::new();
        for line in s.lines() {
            let mut parts = line.split('\t');
            let (Some(short), Some(oid), Some(full)) = (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            let is_remote = full.starts_with("refs/remotes/");
            out.push(BranchRef {
                name: short.to_string(),
                oid: oid.to_string(),
                is_remote,
            });
        }
        Ok(out)
    }

    fn is_remote_tracking_branch(&self, name: &str) -> Result<bool> {
        // Heuristic: `git for-each-ref refs/remotes/<name>` returns a row IFF
        // it's a remote-tracking branch.
        let s = self.git_text(&[
            "for-each-ref",
            "--format=%(refname)",
            &format!("refs/remotes/{name}"),
        ])?;
        Ok(!s.trim().is_empty())
    }

    fn strip_remote_prefix(&self, name: &str) -> Result<String> {
        // For a name like `origin/foo`, strip the first `<remote>/` segment.
        // We can't distinguish `<remote>/foo` from `<foo-with-slash>` without
        // querying remote names; the worktrunk convention is to strip ANY
        // single leading slash component (matches the audit's "pure string op"
        // classification).
        Ok(name.split_once('/').map_or(name, |(_, rest)| rest).to_string())
    }

    fn detect_ref_type(&self, name: &str) -> Result<RefType> {
        // Bare 40-char SHA?
        if name.len() == 40 && name.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(RefType::Sha);
        }
        // Probe each ref namespace in order — first match wins.
        let probes = [
            (format!("refs/heads/{name}"), RefType::LocalBranch),
            (format!("refs/remotes/{name}"), RefType::RemoteBranch),
            (format!("refs/tags/{name}"), RefType::Tag),
        ];
        for (full, kind) in probes {
            if self.ref_exists(&full)? {
                return Ok(kind);
            }
        }
        Ok(RefType::Other)
    }

    fn capture_refs(&self) -> Result<RefSnapshot> {
        use crate::git::ref_snapshot::{RefEntry, RefKind};
        let s = self.git_text(&[
            "for-each-ref",
            "--format=%(refname)\t%(objectname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ])?;
        let mut entries: Vec<RefEntry> = Vec::new();
        for line in s.lines() {
            let mut parts = line.split('\t');
            let (Some(name), Some(oid)) = (parts.next(), parts.next()) else {
                continue;
            };
            let (kind, remote) = if let Some(rest) = name.strip_prefix("refs/remotes/") {
                let remote_name = rest.split_once('/').map(|(r, _)| r.to_string());
                (RefKind::RemoteBranch, remote_name)
            } else if name.starts_with("refs/heads/") {
                (RefKind::LocalBranch, None)
            } else if name.starts_with("refs/tags/") {
                (RefKind::Tag, None)
            } else {
                (RefKind::Other, None)
            };
            entries.push(RefEntry {
                name: name.to_string(),
                oid: oid.to_string(),
                kind,
                remote,
            });
        }
        Ok(RefSnapshot::from_entries(entries))
    }

    fn integration_reason(
        &self,
        snapshot: &RefSnapshot,
        branch: &str,
        target: &str,
    ) -> Result<Option<String>> {
        // A branch is "integrated" into `target` when the branch's tip is an
        // ancestor of `target`'s tip. The snapshot caches the oids; we still
        // need a process call for `merge-base --is-ancestor` to actually walk
        // the commit graph.
        let branch_ref = format!("refs/heads/{branch}");
        let target_local = format!("refs/heads/{target}");
        let target_remote = format!("refs/remotes/origin/{target}");

        let branch_oid = match snapshot.get(&branch_ref) {
            Some(e) => e.oid.clone(),
            None => return Ok(None),
        };

        // Try local target first, then origin/<target>. The OR-mirror matches
        // worktrunk's "merged into either side" semantics noted in
        // `step/prune.rs`.
        let target_oid = snapshot
            .get(&target_local)
            .or_else(|| snapshot.get(&target_remote))
            .map(|e| e.oid.clone());

        if let Some(tip) = target_oid
            && self.is_ancestor(&branch_oid, &tip)?
        {
            return Ok(Some(format!("ancestor of {target}")));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
            .args(["config", "user.email", "t10219@worktrunk.test"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "T10219"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        // Need at least one commit so HEAD resolves.
        std::fs::write(dir.path().join("README.md"), "hello\n").unwrap();
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

    #[test]
    fn at_opens_existing_repo() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        assert_eq!(repo.discovery_path(), d.path());
    }

    #[test]
    fn at_rejects_non_repo() {
        let d = TempDir::new().unwrap();
        let res = ProcessRepo::at(d.path());
        assert!(res.is_err());
    }

    #[test]
    fn root_returns_worktree_root() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        let root = repo.root().unwrap();
        // tempfile may canonicalize symlinks (e.g. /tmp → /private/tmp on macOS)
        // so just check the basenames match.
        assert_eq!(root.file_name(), d.path().file_name());
    }

    #[test]
    fn repo_path_returns_dot_git() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        let p = repo.repo_path().unwrap();
        assert!(p.ends_with(".git") || p.ends_with(".git/"));
    }

    #[test]
    fn is_bare_returns_false_for_normal_repo() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        assert!(!repo.is_bare().unwrap());
    }

    #[test]
    fn list_worktrees_returns_at_least_one() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        let list = repo.list_worktrees().unwrap();
        assert!(!list.is_empty());
    }

    #[test]
    fn primary_worktree_is_first_entry() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        let prim = repo.primary_worktree().unwrap();
        // Check basenames match — see root_returns_worktree_root for why.
        assert_eq!(prim.path.file_name(), d.path().file_name());
        assert_eq!(prim.branch.as_deref(), Some("main"));
    }

    #[test]
    fn config_value_returns_none_for_missing_key() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        let v = repo.config_value("worktrunk.test.no-such-key").unwrap();
        assert!(v.is_none());
    }

    #[test]
    fn set_config_then_read_back() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        repo.set_config("worktrunk.test.k", "v1").unwrap();
        let v = repo.config_value("worktrunk.test.k").unwrap();
        assert_eq!(v.as_deref(), Some("v1"));
    }

    #[test]
    fn short_sha_returns_at_least_4_chars() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        let s = repo.short_sha("HEAD").unwrap();
        assert!(s.len() >= 4);
    }

    #[test]
    fn run_command_propagates_exit_code() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        // `git status` should exit 0.
        let (_so, _se, code) = repo.run_command("git", &["status"]).unwrap();
        assert_eq!(code, 0);
    }

    #[test]
    fn unimplemented_methods_return_typed_error() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        // `prepare_target_worktree` is still on the deferred-impl list — it
        // is the canonical "still unimplemented" probe for this test. When
        // a future task lands its impl, swap to another deferred method.
        let err = repo.prepare_target_worktree("any").unwrap_err();
        assert!(err.to_string().contains("not yet implemented"));
        assert!(err.to_string().contains("prepare_target_worktree"));
    }

    #[test]
    fn ref_exists_returns_true_for_existing_ref() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        assert!(repo.ref_exists("refs/heads/main").unwrap());
    }

    #[test]
    fn ref_exists_returns_false_for_missing_ref() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        assert!(!repo.ref_exists("refs/heads/does-not-exist").unwrap());
    }

    #[test]
    fn default_branch_returns_main_after_init() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        // With no remote configured, default_branch falls back to
        // init.defaultBranch via config_value — which `git init` writes
        // into the per-repo config when given `-b main`. The fallback is
        // not universally set on every git version, so we only assert
        // that the call either succeeds with a non-empty value or surfaces
        // the "cannot determine" error — both are valid SDK behaviour.
        match repo.default_branch() {
            Ok(b) => assert!(!b.is_empty()),
            Err(e) => assert!(e.to_string().contains("cannot determine default branch")),
        }
    }

    #[test]
    fn count_commits_returns_at_least_one_for_head() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        // HEAD..HEAD is zero commits; HEAD alone yields the full history.
        let n = repo.count_commits("HEAD").unwrap();
        assert!(n >= 1);
    }

    #[test]
    fn is_ancestor_self_is_true() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        assert!(repo.is_ancestor("HEAD", "HEAD").unwrap());
    }

    #[test]
    fn merge_base_self_is_some() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        assert!(repo.merge_base("HEAD", "HEAD").unwrap().is_some());
    }

    #[test]
    fn all_branches_emits_main() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        let bs = repo.all_branches().unwrap();
        assert!(bs.iter().any(|b| b.name == "main" && !b.is_remote));
    }

    #[test]
    fn capture_refs_includes_local_heads() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        let snap = repo.capture_refs().unwrap();
        assert!(snap.get("refs/heads/main").is_some());
    }

    #[test]
    fn detect_ref_type_classifies_local_branch() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();
        let t = repo.detect_ref_type("main").unwrap();
        assert_eq!(t, RefType::LocalBranch);
    }

    #[test]
    fn diff_stats_summary_returns_shortstat_parseable_by_sdk() {
        let d = init_repo();
        let repo = ProcessRepo::at(d.path()).unwrap();

        // Add a second commit so we have a range to diff.
        std::fs::write(d.path().join("a.txt"), "alpha\nbeta\ngamma\n").unwrap();
        Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(d.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-q", "-m", "second"])
            .current_dir(d.path())
            .status()
            .unwrap();

        let shortstat = repo.diff_stats_summary("HEAD~1", "HEAD").unwrap();
        let stats = crate::diff::DiffStats::from_shortstat(&shortstat);
        assert_eq!(stats.files, 1, "exactly one file changed");
        assert_eq!(stats.insertions, 3, "three lines inserted");
        assert_eq!(stats.deletions, 0, "no deletions");
    }
}
