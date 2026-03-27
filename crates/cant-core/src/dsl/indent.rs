//! Indentation tracking for the CANT DSL line-based parser.
//!
//! CANT uses 2-space indentation (like YAML). This module tracks
//! indent levels, detects INDENT/DEDENT transitions, and rejects
//! tabs and inconsistent indentation.

use super::error::ParseError;
use super::span::Span;

/// Standard indent width in spaces.
pub const INDENT_WIDTH: usize = 2;

/// Represents a single source line with its indentation metadata.
#[derive(Debug, Clone)]
pub struct IndentedLine<'a> {
    /// The line content with leading whitespace stripped.
    pub content: &'a str,
    /// Number of leading spaces (0 for unindented lines).
    pub indent: usize,
    /// The 1-based line number in the source.
    pub line_number: u32,
    /// Byte offset of this line's start in the original source.
    pub byte_offset: usize,
}

impl<'a> IndentedLine<'a> {
    /// Returns true if this line is blank (empty or whitespace-only).
    pub fn is_blank(&self) -> bool {
        self.content.is_empty()
    }

    /// Returns true if this line is a comment (starts with `#`).
    pub fn is_comment(&self) -> bool {
        self.content.starts_with('#')
    }
}

/// Splits source content into [`IndentedLine`] entries, validating indentation.
///
/// Returns an error if tabs are found or indentation is not a multiple of [`INDENT_WIDTH`].
pub fn split_lines(content: &str) -> Result<Vec<IndentedLine<'_>>, ParseError> {
    let mut lines = Vec::new();
    let mut byte_offset = 0usize;

    for (idx, raw_line) in content.lines().enumerate() {
        let line_number = (idx as u32) + 1;

        // Check for tabs
        if raw_line.contains('\t') {
            return Err(ParseError::error(
                "tabs are not allowed; use 2-space indentation",
                Span::new(byte_offset, byte_offset + raw_line.len(), line_number, 1),
            ));
        }

        let trimmed = raw_line.trim_start_matches(' ');
        let indent = raw_line.len() - trimmed.len();
        let content_trimmed = trimmed.trim_end();

        // Validate indent is a multiple of INDENT_WIDTH (only for non-blank lines)
        if !content_trimmed.is_empty() && indent % INDENT_WIDTH != 0 {
            return Err(ParseError::error(
                format!(
                    "indentation must be a multiple of {} spaces, found {}",
                    INDENT_WIDTH, indent
                ),
                Span::new(byte_offset, byte_offset + indent, line_number, 1),
            ));
        }

        lines.push(IndentedLine {
            content: content_trimmed,
            indent,
            line_number,
            byte_offset,
        });

        // +1 for the newline character
        byte_offset += raw_line.len() + 1;
    }

    Ok(lines)
}

/// Returns the indent level (number of [`INDENT_WIDTH`] increments).
pub fn indent_level(spaces: usize) -> usize {
    spaces / INDENT_WIDTH
}

/// Collects consecutive lines at an indent level strictly greater than `parent_indent`.
///
/// Returns the slice of lines that form the indented block, starting from `start_idx`.
/// Blank lines within the block are included. The block ends when a non-blank line
/// at `parent_indent` or less is encountered, or at end of input.
pub fn collect_block<'a>(
    lines: &'a [IndentedLine<'a>],
    start_idx: usize,
    parent_indent: usize,
) -> &'a [IndentedLine<'a>] {
    let mut end = start_idx;
    while end < lines.len() {
        let line = &lines[end];
        if line.is_blank() {
            end += 1;
            continue;
        }
        if line.indent <= parent_indent {
            break;
        }
        end += 1;
    }
    &lines[start_idx..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_simple_lines() {
        let input = "line1\n  line2\n    line3";
        let lines = split_lines(input).unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].content, "line1");
        assert_eq!(lines[0].indent, 0);
        assert_eq!(lines[1].content, "line2");
        assert_eq!(lines[1].indent, 2);
        assert_eq!(lines[2].content, "line3");
        assert_eq!(lines[2].indent, 4);
    }

    #[test]
    fn rejects_tabs() {
        let input = "\tindented";
        let err = split_lines(input).unwrap_err();
        assert!(err.message.contains("tabs"));
    }

    #[test]
    fn rejects_odd_indent() {
        let input = "ok\n   bad_indent";
        let err = split_lines(input).unwrap_err();
        assert!(err.message.contains("multiple of 2"));
    }

    #[test]
    fn blank_lines_are_blank() {
        let input = "line1\n\nline3";
        let lines = split_lines(input).unwrap();
        assert_eq!(lines.len(), 3);
        assert!(lines[1].is_blank());
    }

    #[test]
    fn comment_detection() {
        let input = "# this is a comment";
        let lines = split_lines(input).unwrap();
        assert!(lines[0].is_comment());
    }

    #[test]
    fn indent_level_calculation() {
        assert_eq!(indent_level(0), 0);
        assert_eq!(indent_level(2), 1);
        assert_eq!(indent_level(4), 2);
        assert_eq!(indent_level(6), 3);
    }

    #[test]
    fn collect_block_simple() {
        let input = "parent:\n  child1\n  child2\nnext";
        let lines = split_lines(input).unwrap();
        let block = collect_block(&lines, 1, 0);
        assert_eq!(block.len(), 2);
        assert_eq!(block[0].content, "child1");
        assert_eq!(block[1].content, "child2");
    }

    #[test]
    fn collect_block_with_blank_line() {
        let input = "parent:\n  child1\n\n  child2\nnext";
        let lines = split_lines(input).unwrap();
        let block = collect_block(&lines, 1, 0);
        assert_eq!(block.len(), 3);
        assert!(block[1].is_blank());
        assert_eq!(block[2].content, "child2");
    }

    #[test]
    fn collect_block_to_end() {
        let input = "parent:\n  child1\n  child2";
        let lines = split_lines(input).unwrap();
        let block = collect_block(&lines, 1, 0);
        assert_eq!(block.len(), 2);
    }

    #[test]
    fn line_numbers_are_one_based() {
        let input = "a\nb\nc";
        let lines = split_lines(input).unwrap();
        assert_eq!(lines[0].line_number, 1);
        assert_eq!(lines[1].line_number, 2);
        assert_eq!(lines[2].line_number, 3);
    }
}
