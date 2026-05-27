//! Source location tracking for AST nodes.
//!
//! Every AST node in the CANT DSL includes a [`Span`] for precise source
//! location reporting. This module also provides [`Spanned<T>`] for wrapping
//! values with their source locations.

use serde::{Deserialize, Serialize};

/// Source location span. All byte offsets are relative to the start of the input.
///
/// Spans are used throughout the AST to enable LSP diagnostics, error reporting,
/// and tooling integration. The `line` and `col` fields are 1-based for human
/// readability; `start` and `end` are 0-based byte offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    /// Byte offset of the first character (inclusive).
    pub start: usize,
    /// Byte offset one past the last character (exclusive).
    pub end: usize,
    /// 1-based line number of the start position.
    pub line: u32,
    /// 1-based column number of the start position (in Unicode scalar values).
    pub col: u32,
}

impl Span {
    /// Creates a new span from the given byte offsets and position.
    pub fn new(start: usize, end: usize, line: u32, col: u32) -> Self {
        Self {
            start,
            end,
            line,
            col,
        }
    }

    /// Creates a dummy span used for synthesized nodes or testing.
    pub fn dummy() -> Self {
        Self {
            start: 0,
            end: 0,
            line: 0,
            col: 0,
        }
    }

    /// Merges two spans into one covering both ranges.
    pub fn merge(self, other: Span) -> Span {
        let start = self.start.min(other.start);
        let end = self.end.max(other.end);
        let (line, col) = if self.start <= other.start {
            (self.line, self.col)
        } else {
            (other.line, other.col)
        };
        Span {
            start,
            end,
            line,
            col,
        }
    }
}

/// A value annotated with its source location span.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spanned<T> {
    /// The wrapped value.
    pub value: T,
    /// The source location of this value.
    pub span: Span,
}

impl<T> Spanned<T> {
    /// Creates a new spanned value.
    pub fn new(value: T, span: Span) -> Self {
        Self { value, span }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn span_new() {
        let s = Span::new(0, 10, 1, 1);
        assert_eq!(s.start, 0);
        assert_eq!(s.end, 10);
        assert_eq!(s.line, 1);
        assert_eq!(s.col, 1);
    }

    #[test]
    fn span_dummy() {
        let s = Span::dummy();
        assert_eq!(s.start, 0);
        assert_eq!(s.end, 0);
    }

    #[test]
    fn span_merge_ordered() {
        let a = Span::new(0, 5, 1, 1);
        let b = Span::new(10, 20, 2, 1);
        let m = a.merge(b);
        assert_eq!(m.start, 0);
        assert_eq!(m.end, 20);
        assert_eq!(m.line, 1);
        assert_eq!(m.col, 1);
    }

    #[test]
    fn span_merge_reversed() {
        let a = Span::new(10, 20, 2, 1);
        let b = Span::new(0, 5, 1, 1);
        let m = a.merge(b);
        assert_eq!(m.start, 0);
        assert_eq!(m.end, 20);
        assert_eq!(m.line, 1);
        assert_eq!(m.col, 1);
    }

    #[test]
    fn spanned_value() {
        let s = Spanned::new("hello".to_string(), Span::new(0, 5, 1, 1));
        assert_eq!(s.value, "hello");
        assert_eq!(s.span.start, 0);
    }
}
