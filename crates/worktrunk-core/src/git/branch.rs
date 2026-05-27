// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Branch deletion semantics.
//!
//! Vendored from `worktrunk::git::remove::BranchDeletionMode` per T10219 (SAGA
//! T10176, Epic T10218, Decision D010). The semantic is a 3-state enum that
//! replaces a two-boolean flag pair (`keep` / `force`) to make valid combinations
//! explicit and prevent invalid combinations (e.g. keep + force).
//!
//! No upstream dependencies; pure data type with helpers.

use serde::{Deserialize, Serialize};

/// Mode controlling how a branch is deleted when its worktree is removed.
///
/// Replaces a two-boolean flag pair (`keep`/`force`) to make the three valid
/// states explicit and prevent invalid combinations (e.g. keep + force).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum BranchDeletionMode {
    /// Keep the branch regardless of merge status (CLI `--no-delete-branch`).
    Keep,
    /// Delete only if integrated into the target branch (default).
    #[default]
    SafeDelete,
    /// Delete the branch even if not merged (CLI `-D`).
    ForceDelete,
}

impl BranchDeletionMode {
    /// Construct from CLI-style flags.
    ///
    /// `keep_branch` takes precedence over `force_delete`.
    ///
    /// # Examples
    ///
    /// ```
    /// use worktrunk_core::git::BranchDeletionMode;
    /// assert_eq!(BranchDeletionMode::from_flags(true, true), BranchDeletionMode::Keep);
    /// assert_eq!(BranchDeletionMode::from_flags(false, true), BranchDeletionMode::ForceDelete);
    /// assert_eq!(BranchDeletionMode::from_flags(false, false), BranchDeletionMode::SafeDelete);
    /// ```
    pub fn from_flags(keep_branch: bool, force_delete: bool) -> Self {
        if keep_branch {
            Self::Keep
        } else if force_delete {
            Self::ForceDelete
        } else {
            Self::SafeDelete
        }
    }

    /// Whether the branch should be kept (never deleted).
    pub fn should_keep(&self) -> bool {
        matches!(self, Self::Keep)
    }

    /// Whether to force-delete even if unmerged.
    pub fn is_force(&self) -> bool {
        matches!(self, Self::ForceDelete)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_safe_delete() {
        assert_eq!(
            BranchDeletionMode::default(),
            BranchDeletionMode::SafeDelete
        );
    }

    #[test]
    fn from_flags_keep_wins_over_force() {
        assert_eq!(
            BranchDeletionMode::from_flags(true, true),
            BranchDeletionMode::Keep
        );
        assert_eq!(
            BranchDeletionMode::from_flags(true, false),
            BranchDeletionMode::Keep
        );
    }

    #[test]
    fn from_flags_force_when_not_keep() {
        assert_eq!(
            BranchDeletionMode::from_flags(false, true),
            BranchDeletionMode::ForceDelete
        );
    }

    #[test]
    fn from_flags_default_safe_delete() {
        assert_eq!(
            BranchDeletionMode::from_flags(false, false),
            BranchDeletionMode::SafeDelete
        );
    }

    #[test]
    fn should_keep_only_for_keep() {
        assert!(BranchDeletionMode::Keep.should_keep());
        assert!(!BranchDeletionMode::SafeDelete.should_keep());
        assert!(!BranchDeletionMode::ForceDelete.should_keep());
    }

    #[test]
    fn is_force_only_for_force_delete() {
        assert!(!BranchDeletionMode::Keep.is_force());
        assert!(!BranchDeletionMode::SafeDelete.is_force());
        assert!(BranchDeletionMode::ForceDelete.is_force());
    }

    #[test]
    fn serde_round_trip() {
        let m = BranchDeletionMode::ForceDelete;
        let json = serde_json::to_string(&m).unwrap();
        let back: BranchDeletionMode = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
