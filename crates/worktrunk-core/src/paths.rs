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
//! SDK and the `@cleocode/paths` TypeScript SSoT stay byte-for-byte aligned.

#![allow(clippy::doc_markdown)] // CLEO_HOME / SHA-256 are not Rust items

use std::path::PathBuf;

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
/// Algorithm: SHA-256 of the path bytes, truncated to the first
/// [`PROJECT_HASH_LENGTH`] hex characters and lowercased. This is the same
/// truncation used by `computeProjectHash` in `@cleocode/paths` and the
/// historic `branch-lock.ts#resolveAgentWorktreeRoot` — so the Rust value
/// matches the TypeScript value byte-for-byte for any given input.
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
    let mut hasher = Sha256::new();
    hasher.update(project_root.as_bytes());
    let digest = hasher.finalize();
    let hex = format!("{digest:x}");
    hex[..PROJECT_HASH_LENGTH].to_string()
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
            h.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
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
