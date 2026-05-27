// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! `CopyIgnoredConfig` — gitignore-style exclude list for `wt step copy-ignored`.
//!
//! Vendored from `worktrunk::config::sections::CopyIgnoredConfig`. The original
//! derives `JsonSchema` (from the `schemars` crate); the SDK version drops
//! that derive because `schemars` is a CLI-facing concern (config schema
//! generation lives in the CLI binary, not the SDK).

use serde::{Deserialize, Serialize};

/// Configuration for the `step copy-ignored` operation.
///
/// Holds a list of gitignore-style patterns that should be excluded when
/// `step copy-ignored` walks the worktree.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CopyIgnoredConfig {
    /// Gitignore-style patterns to exclude from `step copy-ignored`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<String>,
}

impl CopyIgnoredConfig {
    /// Construct a fresh config with the given excludes.
    pub fn new(exclude: Vec<String>) -> Self {
        Self { exclude }
    }

    /// Merge this config with another, deduplicating excludes (preserving
    /// `self`'s order and appending only patterns new in `other`).
    pub fn merged_with(&self, other: &Self) -> Self {
        let mut exclude = self.exclude.clone();
        for pattern in &other.exclude {
            if !exclude.contains(pattern) {
                exclude.push(pattern.clone());
            }
        }
        Self { exclude }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_empty() {
        let c = CopyIgnoredConfig::default();
        assert!(c.exclude.is_empty());
    }

    #[test]
    fn merged_with_appends_new_patterns() {
        let a = CopyIgnoredConfig::new(vec!["**/*.log".into(), "tmp/".into()]);
        let b = CopyIgnoredConfig::new(vec!["tmp/".into(), "node_modules/".into()]);
        let merged = a.merged_with(&b);
        assert_eq!(
            merged.exclude,
            vec![
                "**/*.log".to_string(),
                "tmp/".into(),
                "node_modules/".into()
            ]
        );
    }

    #[test]
    fn merged_with_preserves_self_order() {
        let a = CopyIgnoredConfig::new(vec!["a".into(), "b".into()]);
        let b = CopyIgnoredConfig::new(vec!["b".into(), "a".into()]);
        let merged = a.merged_with(&b);
        assert_eq!(merged.exclude, vec!["a".to_string(), "b".into()]);
    }

    #[test]
    fn serde_round_trip() {
        let c = CopyIgnoredConfig::new(vec!["**/*.log".into()]);
        let j = serde_json::to_string(&c).unwrap();
        let back: CopyIgnoredConfig = serde_json::from_str(&j).unwrap();
        assert_eq!(c, back);
    }
}
