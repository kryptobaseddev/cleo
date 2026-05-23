// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/worktrunk-core in the CleoCode monorepo.

//! Pure-data git diff parsers (line totals + shortstat / numstat).
//!
//! Pure-Rust SDK extraction of worktrunk's `src/git/diff.rs` per the T10221
//! refactor (ADR-078 separation-of-concerns contract). Owns ONLY the parsing
//! primitives —
//! [`LineDiff`], [`DiffStats`], [`parse_numstat_line`], [`parse_shortstat`].
//! Color rendering of summaries (the donor's `format_summary` using
//! `color_print::cformat!` + `green/red` markup) is intentionally NOT
//! vendored — that's CLI styling, not data. CLI consumers compose color
//! themselves from a `(files, insertions, deletions)` tuple.
//!
//! Inline ANSI-strip is implemented locally so the SDK can drop the
//! `ansi_str` crate from its dependency graph. Reproduces the small subset of
//! `AnsiStr::ansi_strip` the donor used: strip CSI sequences (ESC `[` … cmd)
//! and OSC sequences (ESC `]` … BEL or ESC `\`) before parsing.

/// Line-level diff totals (added/deleted counts) used across git operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct LineDiff {
    /// Number of inserted lines.
    pub added: usize,
    /// Number of deleted lines.
    pub deleted: usize,
}

impl LineDiff {
    /// Parse `git diff --shortstat` output into line totals.
    ///
    /// Shortstat produces a single line like:
    ///   ` 3 files changed, 45 insertions(+), 12 deletions(-)`
    /// with optional parts omitted when zero. Extracts numbers by position
    /// relative to the `(+)` and `(-)` markers, which are locale-independent.
    #[must_use]
    pub fn from_shortstat(output: &str) -> Self {
        parse_shortstat(output).map_or(Self::default(), |(_, ins, del)| Self {
            added: ins,
            deleted: del,
        })
    }

    /// `true` if both insertions and deletions are zero.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.added == 0 && self.deleted == 0
    }
}

impl From<LineDiff> for (usize, usize) {
    fn from(diff: LineDiff) -> Self {
        (diff.added, diff.deleted)
    }
}

impl From<(usize, usize)> for LineDiff {
    fn from(value: (usize, usize)) -> Self {
        Self {
            added: value.0,
            deleted: value.1,
        }
    }
}

/// Diff statistics (files changed, insertions, deletions).
///
/// Public in the SDK — CLI consumers that previously formatted via the
/// donor's `format_summary` should pull `(files, insertions, deletions)`
/// out of this struct and apply their own color rendering. The SDK has no
/// opinion on rendering.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DiffStats {
    /// Number of files changed.
    pub files: usize,
    /// Number of inserted lines.
    pub insertions: usize,
    /// Number of deleted lines.
    pub deletions: usize,
}

impl DiffStats {
    /// Construct stats from `git diff --shortstat` output.
    #[must_use]
    pub fn from_shortstat(output: &str) -> Self {
        parse_shortstat(output).map_or(Self::default(), |(files, ins, del)| Self {
            files,
            insertions: ins,
            deletions: del,
        })
    }
}

/// Parse a git numstat line and extract insertions/deletions.
///
/// Supports standard `git diff --numstat` output as well as `git log`
/// output with `--graph --color=always` prefixes (ANSI escapes are stripped
/// before parsing). Returns `None` for binary entries (which git renders as
/// `-` counts).
#[must_use]
pub fn parse_numstat_line(line: &str) -> Option<(usize, usize)> {
    // Strip ANSI escape sequences (graph coloring contains digits that
    // confuse parsing). Inline strip — see module doc for rationale.
    let stripped = strip_ansi(line);

    // Strip graph prefix (e.g., "| ") and find tab-separated values.
    let trimmed = stripped.trim_start_matches(|c: char| !c.is_ascii_digit() && c != '-');

    let mut parts = trimmed.split('\t');
    let added_str = parts.next()?;
    let deleted_str = parts.next()?;

    // "-" means binary file; line counts are unavailable, so skip.
    if added_str == "-" || deleted_str == "-" {
        return None;
    }

    let added = added_str.parse().ok()?;
    let deleted = deleted_str.parse().ok()?;

    Some((added, deleted))
}

/// Parse `git diff --shortstat` output into `(files, insertions, deletions)`.
///
/// The format is: ` N file(s) changed, N insertion(s)(+), N deletion(s)(-)`
/// with optional parts omitted when zero. The `(+)` and `(-)` markers are
/// hardcoded in git's C source (`diff.c`) and not subject to localization.
#[must_use]
pub fn parse_shortstat(output: &str) -> Option<(usize, usize, usize)> {
    let line = output.trim();
    if line.is_empty() {
        return None;
    }

    let mut files = 0;
    let mut insertions = 0;
    let mut deletions = 0;

    // Split on commas: "N file(s) changed", "N insertion(s)(+)", "N deletion(s)(-)"
    for (i, part) in line.split(',').enumerate() {
        let num = part
            .split_whitespace()
            .find_map(|w| w.parse::<usize>().ok())
            .unwrap_or(0);

        if i == 0 {
            files = num;
        } else if part.contains("(+)") {
            insertions = num;
        } else if part.contains("(-)") {
            deletions = num;
        }
    }

    Some((files, insertions, deletions))
}

/// Strip ANSI CSI (`ESC [ … cmd`) and OSC (`ESC ] … BEL|ESC \`) sequences
/// from `s`.
///
/// Limited to the subset the donor's `ansi_str::AnsiStr::ansi_strip` needed
/// for parsing `git log --graph --color=always` output. Not a general-purpose
/// terminal-escape stripper — designed for parsing, not display.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        // ESC seen. Inspect the next char to classify the sequence.
        match chars.next() {
            None => {
                // Trailing lone ESC — preserve nothing (matches ansi_str behavior).
                break;
            }
            Some('[') => {
                // CSI: parameter bytes 0x30-0x3F, intermediate 0x20-0x2F, final 0x40-0x7E.
                for ch in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&ch) {
                        break;
                    }
                }
            }
            Some(']') => {
                // OSC: terminated by BEL (0x07) or ST (ESC \).
                while let Some(ch) = chars.next() {
                    if ch == '\x07' {
                        break;
                    }
                    if ch == '\x1b' {
                        // ST = ESC \
                        if let Some('\\') = chars.peek() {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            Some(_) => {
                // Two-byte ESC sequence (e.g. ESC = for keypad mode); already
                // consumed the second byte by calling chars.next() above.
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // LineDiff ----------------------------------------------------------------

    #[test]
    fn line_diff_is_empty() {
        assert!(LineDiff::default().is_empty());
        assert!(
            !LineDiff {
                added: 5,
                deleted: 0
            }
            .is_empty()
        );
        assert!(
            !LineDiff {
                added: 0,
                deleted: 5
            }
            .is_empty()
        );
    }

    #[test]
    fn line_diff_tuple_roundtrip() {
        let diff: LineDiff = (10, 5).into();
        assert_eq!(diff.added, 10);
        assert_eq!(diff.deleted, 5);
        let tuple: (usize, usize) = diff.into();
        assert_eq!(tuple, (10, 5));
    }

    // parse_numstat_line ------------------------------------------------------

    #[test]
    fn parse_numstat_line_basic() {
        let result = parse_numstat_line("10\t5\tfile.rs");
        assert_eq!(result, Some((10, 5)));
    }

    #[test]
    fn parse_numstat_line_insertions_only() {
        let result = parse_numstat_line("15\t0\tfile.rs");
        assert_eq!(result, Some((15, 0)));
    }

    #[test]
    fn parse_numstat_line_deletions_only() {
        let result = parse_numstat_line("0\t8\tfile.rs");
        assert_eq!(result, Some((0, 8)));
    }

    #[test]
    fn parse_numstat_line_binary_file() {
        let result = parse_numstat_line("-\t-\timage.png");
        assert_eq!(result, None);
    }

    #[test]
    fn parse_numstat_line_with_graph_prefix() {
        // Plain graph prefix
        let result = parse_numstat_line("| 10\t5\tfile.rs");
        assert_eq!(result, Some((10, 5)));

        // First numstat line after commit has "* | " prefix
        let result = parse_numstat_line("* | 11\t0\tCargo.toml");
        assert_eq!(result, Some((11, 0)));

        // Subsequent numstat lines have "| " prefix
        let result = parse_numstat_line("| 17\t3\tsrc/main.rs");
        assert_eq!(result, Some((17, 3)));

        // With ANSI colors (--color=always adds escape codes to graph)
        // ESC[31m = red, ESC[m = reset
        let esc = '\x1b';
        let ansi_colored = format!("{esc}[31m|{esc}[m 11\t0\tCargo.toml");
        let result = parse_numstat_line(&ansi_colored);
        assert_eq!(result, Some((11, 0)));
    }

    #[test]
    fn parse_numstat_line_not_numstat() {
        assert_eq!(parse_numstat_line("* abc1234 Fix bug"), None);
        assert_eq!(parse_numstat_line(""), None);
        assert_eq!(parse_numstat_line("regular text"), None);
    }

    // parse_shortstat / DiffStats / LineDiff::from_shortstat ------------------

    #[test]
    fn parse_shortstat_all_parts() {
        let output = " 23 files changed, 624 insertions(+), 160 deletions(-)";
        let (files, ins, del) = parse_shortstat(output).unwrap();
        assert_eq!(files, 23);
        assert_eq!(ins, 624);
        assert_eq!(del, 160);
    }

    #[test]
    fn parse_shortstat_insertions_only() {
        let output = " 1 file changed, 6 insertions(+)";
        let (files, ins, del) = parse_shortstat(output).unwrap();
        assert_eq!(files, 1);
        assert_eq!(ins, 6);
        assert_eq!(del, 0);
    }

    #[test]
    fn parse_shortstat_deletions_only() {
        let output = " 2 files changed, 10 deletions(-)";
        let (files, ins, del) = parse_shortstat(output).unwrap();
        assert_eq!(files, 2);
        assert_eq!(ins, 0);
        assert_eq!(del, 10);
    }

    #[test]
    fn parse_shortstat_empty() {
        assert_eq!(parse_shortstat(""), None);
        assert_eq!(parse_shortstat("  "), None);
        assert_eq!(parse_shortstat("\n"), None);
    }

    #[test]
    fn parse_shortstat_single_file_singular() {
        let output = " 1 file changed, 1 insertion(+), 1 deletion(-)";
        let (files, ins, del) = parse_shortstat(output).unwrap();
        assert_eq!(files, 1);
        assert_eq!(ins, 1);
        assert_eq!(del, 1);
    }

    #[test]
    fn line_diff_from_shortstat() {
        let output = " 5 files changed, 100 insertions(+), 50 deletions(-)";
        let diff = LineDiff::from_shortstat(output);
        assert_eq!(diff.added, 100);
        assert_eq!(diff.deleted, 50);
    }

    #[test]
    fn line_diff_from_shortstat_empty() {
        let diff = LineDiff::from_shortstat("");
        assert!(diff.is_empty());
    }

    #[test]
    fn diff_stats_from_shortstat() {
        let output = " 3 files changed, 45 insertions(+), 12 deletions(-)";
        let stats = DiffStats::from_shortstat(output);
        assert_eq!(stats.files, 3);
        assert_eq!(stats.insertions, 45);
        assert_eq!(stats.deletions, 12);
    }

    #[test]
    fn diff_stats_from_shortstat_empty() {
        let stats = DiffStats::from_shortstat("");
        assert_eq!(stats.files, 0);
        assert_eq!(stats.insertions, 0);
        assert_eq!(stats.deletions, 0);
    }

    // strip_ansi --------------------------------------------------------------

    #[test]
    fn strip_ansi_drops_csi_sequences() {
        let esc = '\x1b';
        let input = format!("{esc}[31mred{esc}[0m plain");
        assert_eq!(strip_ansi(&input), "red plain");
    }

    #[test]
    fn strip_ansi_drops_osc_terminated_by_bel() {
        let esc = '\x1b';
        let bel = '\x07';
        let input = format!("a{esc}]0;titlewith;semicolons{bel}b");
        assert_eq!(strip_ansi(&input), "ab");
    }

    #[test]
    fn strip_ansi_drops_osc_terminated_by_st() {
        let esc = '\x1b';
        let input = format!("a{esc}]0;title{esc}\\b");
        assert_eq!(strip_ansi(&input), "ab");
    }

    #[test]
    fn strip_ansi_preserves_text_without_escapes() {
        assert_eq!(strip_ansi("plain text"), "plain text");
    }
}
