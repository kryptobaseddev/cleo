// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Path canonicalization, formatting, and equality helpers.
//!
//! The headline function is [`canonicalize_with_parents`], which resolves
//! symlinks on the longest existing prefix of a path even when the path itself
//! does not yet exist. This is essential for computed worktree paths and for
//! validating destination ancestry before `git worktree add` creates the
//! directory.
//!
//! [`format_path_for_display`] returns a user-facing string with `~` shorthand
//! when safe, falling back to POSIX-quoted absolute paths when the result would
//! otherwise be shell-ambiguous.
//!
//! [`paths_match`] is the canonicalization-aware path equality used by the
//! worktree primitives to detect that `/var/...` and `/private/var/...` refer
//! to the same location on macOS.
//!
//! This module is platform-portable. The donor `to_posix_path` Windows
//! cygpath bridge was removed to keep the SDK CLI-deps-free; callers that need
//! Windows POSIX paths should handle that conversion in the consumer crate.

use std::path::{Path, PathBuf};

/// Convert a path to POSIX format.
///
/// On Unix, returns the path unchanged. On Windows the result is also
/// unchanged in this pure-SDK build — the donor's cygpath bridge depended on
/// the CLI shell layer and has been intentionally omitted. Consumers that
/// require Windows-to-POSIX conversion should perform it at the call site.
#[must_use]
pub fn to_posix_path(path: &str) -> String {
    path.to_string()
}

/// Format a filesystem path for user-facing output.
///
/// Replaces the home directory prefix with `~` when safe. Falls back to the
/// path's display string when escaping would be ambiguous.
///
/// The donor's POSIX shell-escape path was removed (relied on the `shell_escape`
/// crate) — for the SDK's needs the un-escaped display form is enough; consumers
/// that build shell snippets should wrap with their own quoting helper.
#[must_use]
pub fn format_path_for_display(path: &Path) -> String {
    if let Some(home) = home_dir()
        && let Ok(stripped) = path.strip_prefix(&home)
    {
        if stripped.as_os_str().is_empty() {
            return "~".to_string();
        }

        // Convert path components to forward-slash form for display portability.
        let rest = to_forward_slash(stripped);
        return format!("~/{rest}");
    }

    to_forward_slash(path)
}

/// Render a path with forward-slash separators (best effort, lossy on
/// non-UTF-8 components — same fallback as the donor's `to_slash_lossy`).
fn to_forward_slash(path: &Path) -> String {
    let mut out = String::new();
    let mut first = true;
    for component in path.components() {
        let comp_str = component.as_os_str().to_string_lossy();
        if first {
            // Root component renders as e.g. "/" on Unix.
            if comp_str == std::path::MAIN_SEPARATOR.to_string() {
                out.push('/');
                first = false;
                continue;
            }
            out.push_str(&comp_str);
            first = false;
        } else {
            if !out.ends_with('/') {
                out.push('/');
            }
            out.push_str(&comp_str);
        }
    }
    if out.is_empty() {
        return path.display().to_string();
    }
    out
}

/// Get the user's home directory.
///
/// Reads `$HOME` on Unix and `%USERPROFILE%` on Windows. Returns `None` when
/// neither is set.
#[must_use]
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                let mut combined = PathBuf::from(drive);
                combined.push(path);
                Some(combined)
            })
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

/// Canonicalize a path, resolving parent symlinks even if the path doesn't exist.
///
/// For existing paths, uses [`std::fs::canonicalize`]. For non-existent paths,
/// canonicalizes the longest existing prefix and appends the remaining
/// components. This handles macOS `/var` → `/private/var` symlinks correctly
/// for computed worktree paths that don't exist yet.
#[must_use]
pub fn canonicalize_with_parents(path: &Path) -> PathBuf {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return canonical;
    }

    let mut existing_prefix = path.to_path_buf();
    let mut suffix_components = Vec::new();

    while !existing_prefix.exists() {
        let (Some(file_name), Some(parent)) =
            (existing_prefix.file_name(), existing_prefix.parent())
        else {
            return path.to_path_buf();
        };
        suffix_components.push(file_name.to_os_string());
        existing_prefix = parent.to_path_buf();
    }

    let canonical_prefix = std::fs::canonicalize(&existing_prefix).unwrap_or(existing_prefix);
    let mut result = canonical_prefix;
    for component in suffix_components.into_iter().rev() {
        result.push(component);
    }
    result
}

/// Compare two paths for equality, canonicalizing to handle symlinks and relative paths.
///
/// Returns `true` if the paths resolve to the same location. Handles the case
/// where one path exists and the other doesn't by resolving parent directory
/// symlinks for non-existent paths.
#[must_use]
pub fn paths_match(a: &Path, b: &Path) -> bool {
    canonicalize_with_parents(a) == canonicalize_with_parents(b)
}

#[cfg(test)]
mod tests {
    use super::{
        canonicalize_with_parents, format_path_for_display, home_dir, paths_match, to_posix_path,
    };
    use std::path::PathBuf;

    #[test]
    fn shortens_path_under_home() {
        let Some(home) = home_dir() else {
            return;
        };

        let path = home.join("projects").join("wt");
        let formatted = format_path_for_display(&path);

        assert!(
            formatted.starts_with('~'),
            "Expected tilde prefix, got {formatted}"
        );
        assert!(
            formatted.contains("projects"),
            "Expected child components to remain in output"
        );
        assert!(
            formatted.ends_with("wt"),
            "Expected leaf component to remain in output"
        );
    }

    #[test]
    fn shows_home_as_tilde() {
        let Some(home) = home_dir() else {
            return;
        };

        let formatted = format_path_for_display(&home);
        assert_eq!(formatted, "~");
    }

    #[test]
    fn to_posix_path_leaves_unix_paths_unchanged() {
        assert_eq!(to_posix_path("/tmp/test/repo"), "/tmp/test/repo");
        assert_eq!(to_posix_path("relative/path"), "relative/path");
    }

    #[test]
    fn test_home_dir_returns_valid_path() {
        if let Some(home) = home_dir() {
            assert!(home.is_absolute(), "Home directory should be absolute");
            assert!(home.components().count() > 0, "Home should have components");
        }
    }

    #[test]
    fn test_format_path_outside_home() {
        let path = PathBuf::from("/definitely/not/under/home/dir");
        let result = format_path_for_display(&path);
        assert_eq!(result, "/definitely/not/under/home/dir");
    }

    #[test]
    fn test_paths_match_identical() {
        let path = PathBuf::from("/tmp/test");
        assert!(paths_match(&path, &path));
    }

    #[test]
    fn test_paths_match_different() {
        let a = PathBuf::from("/tmp/foo");
        let b = PathBuf::from("/tmp/bar");
        assert!(!paths_match(&a, &b));
    }

    #[test]
    fn test_canonicalize_with_parents_existing_path() {
        let tmp = std::env::temp_dir();
        let canonical = canonicalize_with_parents(&tmp);
        assert!(canonical.is_absolute());
    }

    #[test]
    fn test_canonicalize_with_parents_degenerate() {
        let canonical = canonicalize_with_parents(std::path::Path::new(""));
        assert_eq!(canonical, PathBuf::from(""));
    }

    #[test]
    fn test_canonicalize_with_parents_nonexistent() {
        let tmp = std::env::temp_dir();
        let nonexistent = tmp.join("nonexistent-test-dir-12345");
        let canonical = canonicalize_with_parents(&nonexistent);

        assert!(canonical.is_absolute());
        assert_eq!(
            canonical.file_name().unwrap().to_str().unwrap(),
            "nonexistent-test-dir-12345"
        );
    }

    #[test]
    fn test_paths_match_existing_vs_nonexistent() {
        let tmp = std::env::temp_dir();

        let existing = tmp.join("wt-core-test-existing");
        std::fs::create_dir_all(&existing).expect("Failed to create test dir");

        let nonexistent = tmp.join("wt-core-test-nonexistent");
        let _ = std::fs::remove_dir_all(&nonexistent);

        assert!(!paths_match(&existing, &nonexistent));

        let canonical = canonicalize_with_parents(&existing);
        assert!(paths_match(&existing, &canonical));

        let _ = std::fs::remove_dir_all(&existing);
    }
}
