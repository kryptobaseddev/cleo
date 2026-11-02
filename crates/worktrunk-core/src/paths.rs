// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Path-derivation primitives for CLEO worktrees.
//!
//! Rust mirror of the algorithms in `@cleocode/paths/worktree-paths.ts`. The
//! TypeScript package owns the SSoT for path conventions across CLEO; this
//! module exposes the same algorithms inside the Rust SDK so consumers
//! (notably `step::relocate` and future `cleo orchestrate spawn` Rust
//! callers) avoid forking the hash function or worktree-root layout.
//!
//! Folded scope from T10207: `step::relocate` previously rebuilt the
//! project-hash → worktree-root mapping ad hoc. Centralising it here lets the
//! SDK and the `@cleocode/paths` TypeScript SSoT agree on the same hash for
//! the same project, including its canonicalisation (T14130).

#![allow(clippy::doc_markdown)] // CLEO_HOME / SHA-256 are not Rust items

use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// Subdirectory under `cleoHome` that holds project-scoped worktree roots.
///
/// Matches `WORKTREES_SUBDIR` in `@cleocode/paths/worktree-paths.ts`.
pub const WORKTREES_SUBDIR: &str = "worktrees";

/// Truncated length (hex chars) of the project hash.
///
/// Matches `PROJECT_HASH_LENGTH` in `@cleocode/paths/worktree-paths.ts`.
pub const PROJECT_HASH_LENGTH: usize = 16;

/// Compute a stable 16-character project hash from an absolute project-root path.
///
/// Algorithm, as `computeProjectHash` in `@cleocode/paths` (T14130):
///
/// 1. Canonicalise the path: resolve it through the filesystem (symlinks,
///    `..`; T11023), falling back to the path as given when it does not exist.
/// 2. A linked git worktree (`<main>/.git/worktrees/<name>`) hashes as the
///    main checkout that owns it (T14126); a submodule or a bare repository's
///    worktree hashes as itself.
/// 3. SHA-256 of the canonical path's bytes, truncated to the first
///    [`PROJECT_HASH_LENGTH`] lowercase hex characters.
///
/// So a symlinked path, or a command run inside a task worktree, names the
/// same `<cleo_home>/worktrees/<hash>/` as the TypeScript side.
///
/// # Examples
///
/// ```
/// use worktrunk_core::paths::compute_project_hash;
///
/// let h = compute_project_hash("/mnt/projects/cleocode");
/// assert_eq!(h.len(), 16);
/// assert!(h.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
/// ```
#[must_use]
pub fn compute_project_hash(project_root: &str) -> String {
    let canonical = canonical_project_root(project_root);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    let digest = hasher.finalize();
    let hex = format!("{digest:x}");
    hex[..PROJECT_HASH_LENGTH].to_string()
}

/// The path `compute_project_hash` hashes (T14130): the real path, or the
/// path as given when it cannot be resolved; then, for a linked git
/// worktree, its owning main checkout. Mirrors `computeProjectHash` and
/// `linkedWorktreeOwner` in `@cleocode/paths/worktree-paths.ts`.
fn canonical_project_root(project_root: &str) -> String {
    let real = real_path(Path::new(project_root)).unwrap_or_else(|| project_root.to_string());
    linked_worktree_owner(Path::new(&real)).unwrap_or(real)
}

/// `realpath`, as a string, or `None` when the path cannot be resolved.
fn real_path(path: &Path) -> Option<String> {
    let resolved = std::fs::canonicalize(path).ok()?;
    let text = resolved.to_string_lossy().into_owned();
    // Windows canonicalises to a verbatim `\\?\` path; Node's realpath does not.
    Some(
        text.strip_prefix(r"\\?\")
            .map_or(text.clone(), str::to_string),
    )
}

/// The main checkout that owns the linked git worktree at `dir`, or `None`
/// (T14126). Only the `<main>/.git/worktrees/<name>` gitlink layout counts.
fn linked_worktree_owner(dir: &Path) -> Option<String> {
    // A directory `.git` (a main checkout) fails to read as a file: not linked.
    let content = std::fs::read_to_string(dir.join(".git")).ok()?;
    let target = content
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))?
        .trim();
    if target.is_empty() {
        return None;
    }
    let gitdir = normalize(&dir.join(target));
    let worktrees = gitdir.parent()?;
    if worktrees.file_name()? != "worktrees" {
        return None;
    }
    let common = worktrees.parent()?;
    if common.file_name()? != ".git" {
        return None;
    }
    real_path(common.parent()?)
}

/// Lexically resolve `.` and `..`, as Node's `path.resolve` does.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve the worktrees root directory for a given project hash.
///
/// Result: `<cleo_home>/worktrees/<project_hash>/`.
///
/// The `cleo_home` argument is supplied by the caller because the SDK
/// deliberately does NOT take a dependency on `env-paths` resolution
/// (that is owned by the `@cleocode/paths` TS SSoT). CLI callers pass the
/// value resolved by `paths::getCleoHome()`; tests pass a tmpdir.
///
/// Matches `resolveWorktreeRootForHash` in `@cleocode/paths`.
#[must_use]
pub fn resolve_worktree_root_for_hash(cleo_home: &str, project_hash: &str) -> PathBuf {
    PathBuf::from(cleo_home)
        .join(WORKTREES_SUBDIR)
        .join(project_hash)
}

/// Resolve the worktree directory for a specific task ID.
///
/// Result: `<cleo_home>/worktrees/<project_hash>/<task_id>/`.
///
/// Matches `resolveTaskWorktreePath` in `@cleocode/paths`.
#[must_use]
pub fn resolve_task_worktree_path(cleo_home: &str, project_hash: &str, task_id: &str) -> PathBuf {
    resolve_worktree_root_for_hash(cleo_home, project_hash).join(task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_hash_is_16_lowercase_hex_chars() {
        let h = compute_project_hash("/some/path");
        assert_eq!(h.len(), PROJECT_HASH_LENGTH);
        assert!(
            h.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "hash {h} should be lowercase hex"
        );
    }

    #[test]
    fn project_hash_is_deterministic() {
        let a = compute_project_hash("/mnt/projects/cleocode");
        let b = compute_project_hash("/mnt/projects/cleocode");
        assert_eq!(a, b);
    }

    #[test]
    fn project_hash_differs_for_different_inputs() {
        let a = compute_project_hash("/mnt/projects/cleocode");
        let b = compute_project_hash("/mnt/projects/worktrunk");
        assert_ne!(a, b);
    }

    #[test]
    fn project_hash_matches_ts_known_value() {
        // The TypeScript implementation in @cleocode/paths/worktree-paths.ts
        // computes SHA-256 of the path bytes and slices `.slice(0, 16)`. For
        // the CleoCode project root, the spawn prompt locks the value to
        // `1e3146b7352ba279`. This test pins the algorithm against the same
        // canonical input.
        assert_eq!(
            compute_project_hash("/mnt/projects/cleocode"),
            "1e3146b7352ba279"
        );
    }

    #[test]
    fn resolve_worktree_root_for_hash_joins_segments() {
        let p = resolve_worktree_root_for_hash("/home/u/.local/share/cleo", "abc123");
        assert!(p.ends_with("worktrees/abc123") || p.ends_with("worktrees\\abc123"));
    }

    #[test]
    fn resolve_task_worktree_path_appends_task_id() {
        let p = resolve_task_worktree_path("/home/u/.local/share/cleo", "abc123", "T1234");
        assert!(p.ends_with("worktrees/abc123/T1234") || p.ends_with("worktrees\\abc123\\T1234"));
    }
}
