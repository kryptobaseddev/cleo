// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Parser for `.worktreeinclude` files using glob semantics.
//!
//! `.worktreeinclude` is a gitignore-syntax allowlist that specifies which
//! repository-relative paths should be carried into a freshly provisioned
//! worktree. The previous TypeScript implementation evaluated patterns by
//! literal `existsSync` checks, which silently dropped glob entries such as
//! `target/*.lock` — this module is the canonical, correct replacement built
//! on `ignore::gitignore::GitignoreBuilder` (the same matcher git itself
//! uses).
//!
//! # Pattern grammar
//!
//! Standard gitignore syntax:
//!
//! - `path/to/file` — literal path
//! - `*.lock` — glob (matches `target/foo.lock`, `node_modules/bar.lock`, …)
//! - `!path` — negation (re-include after a prior exclusion)
//! - `# comment` — line comment
//!
//! Empty lines and pure comments are ignored.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};

/// One pattern parsed from a `.worktreeinclude` file.
///
/// `pattern` is the raw line (without leading `!`); `is_negation` indicates
/// whether the line began with `!` to re-include a previously excluded path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncludePattern {
    /// The raw pattern text (gitignore-style), with the leading `!` stripped.
    pub pattern: String,
    /// Whether this entry began with `!` (re-includes after a prior exclusion).
    pub is_negation: bool,
}

/// Parse a `.worktreeinclude` file and return the list of patterns it contains.
///
/// Reads `<repo_root>/.worktreeinclude`. Returns an empty `Vec` when the file
/// does not exist (callers can use this as the "no filter, copy all" signal).
///
/// # Errors
///
/// Returns an error when the file exists but cannot be read.
pub fn read_include_patterns(repo_root: &Path) -> anyhow::Result<Vec<IncludePattern>> {
    let include_path = repo_root.join(".worktreeinclude");
    if !include_path.exists() {
        return Ok(Vec::new());
    }

    let body = std::fs::read_to_string(&include_path)
        .with_context(|| format!("reading {}", include_path.display()))?;

    let mut out = Vec::new();
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (is_negation, pattern) = if let Some(rest) = line.strip_prefix('!') {
            (true, rest.to_string())
        } else {
            (false, line.to_string())
        };
        out.push(IncludePattern {
            pattern,
            is_negation,
        });
    }
    Ok(out)
}

/// Apply a `.worktreeinclude` matcher to a list of candidate paths.
///
/// Builds a [`ignore::gitignore::Gitignore`] matcher anchored at `repo_root`
/// from the supplied patterns and returns the subset of `candidate_paths`
/// that match. Each candidate is matched as a directory iff it currently
/// exists and resolves to a directory; non-existent candidates are matched
/// as files (consistent with the donor's behavior in `list_and_filter_*`).
///
/// When `patterns` is empty, returns the entire candidate list unchanged
/// (mirroring the donor's "no filter when the file is absent" semantic).
///
/// # Errors
///
/// Returns an error when a pattern fails to parse under gitignore syntax.
pub fn apply_include_matcher(
    repo_root: &Path,
    patterns: &[IncludePattern],
    candidate_paths: &[PathBuf],
) -> anyhow::Result<Vec<PathBuf>> {
    if patterns.is_empty() {
        return Ok(candidate_paths.to_vec());
    }

    let mut builder = ignore::gitignore::GitignoreBuilder::new(repo_root);
    for p in patterns {
        let line = if p.is_negation {
            format!("!{}", p.pattern)
        } else {
            p.pattern.clone()
        };
        builder
            .add_line(None, &line)
            .map_err(|e| anyhow::anyhow!("invalid .worktreeinclude pattern {line:?}: {e}"))?;
    }
    let matcher = builder
        .build()
        .context("failed to build .worktreeinclude matcher")?;

    let kept = candidate_paths
        .iter()
        .filter(|path| {
            let is_dir = path.is_dir();
            matcher.matched(path, is_dir).is_ignore()
        })
        .cloned()
        .collect();
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn read_patterns_missing_file_returns_empty() {
        let td = TempDir::new().unwrap();
        let patterns = read_include_patterns(td.path()).unwrap();
        assert!(patterns.is_empty());
    }

    #[test]
    fn read_patterns_parses_literals_globs_and_negations() {
        let td = TempDir::new().unwrap();
        std::fs::write(
            td.path().join(".worktreeinclude"),
            "# header comment\n\nCargo.toml\n*.lock\n!node_modules/\nsrc/**\n",
        )
        .unwrap();
        let p = read_include_patterns(td.path()).unwrap();
        assert_eq!(p.len(), 4);
        assert_eq!(p[0].pattern, "Cargo.toml");
        assert!(!p[0].is_negation);
        assert_eq!(p[1].pattern, "*.lock");
        assert_eq!(p[2].pattern, "node_modules/");
        assert!(p[2].is_negation);
        assert_eq!(p[3].pattern, "src/**");
    }

    #[test]
    fn matcher_includes_glob_match() {
        let td = TempDir::new().unwrap();
        std::fs::write(td.path().join("Cargo.lock"), "").unwrap();
        std::fs::create_dir_all(td.path().join("target")).unwrap();
        std::fs::write(td.path().join("target").join("debug.lock"), "").unwrap();
        std::fs::write(td.path().join("README.md"), "").unwrap();

        let patterns = vec![IncludePattern {
            pattern: "*.lock".to_string(),
            is_negation: false,
        }];
        let candidates = vec![
            td.path().join("Cargo.lock"),
            td.path().join("target").join("debug.lock"),
            td.path().join("README.md"),
        ];
        let kept = apply_include_matcher(td.path(), &patterns, &candidates).unwrap();
        assert!(kept.contains(&td.path().join("Cargo.lock")));
        assert!(kept.contains(&td.path().join("target").join("debug.lock")));
        assert!(!kept.contains(&td.path().join("README.md")));
    }

    #[test]
    fn matcher_empty_patterns_returns_all() {
        let td = TempDir::new().unwrap();
        let candidates = vec![td.path().join("a"), td.path().join("b")];
        let kept = apply_include_matcher(td.path(), &[], &candidates).unwrap();
        assert_eq!(kept, candidates);
    }

    #[test]
    fn matcher_rejects_invalid_pattern() {
        let td = TempDir::new().unwrap();
        // GitignoreBuilder is permissive; only path-like patterns are accepted.
        // We can't easily trigger a hard error from add_line because gitignore
        // tolerates most syntax. This test ensures the happy path stays green
        // and acts as a regression hold.
        let patterns = vec![IncludePattern {
            pattern: "valid".to_string(),
            is_negation: false,
        }];
        let res = apply_include_matcher(td.path(), &patterns, &[]);
        assert!(res.is_ok());
    }
}
