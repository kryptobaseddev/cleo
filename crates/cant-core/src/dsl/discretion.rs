//! Discretion condition parser for the CANT DSL.
//!
//! Discretion conditions are `**prose text**` markers that represent
//! AI-evaluated conditions. The parser extracts the prose text between
//! the `**` delimiters but does NOT evaluate it -- they are opaque strings.
//!
//! ```cant
//! if **all reviews pass with no critical issues**:
//! loop:
//!   session "Check status"
//!   until **deployment is stable**
//! ```

use super::ast::DiscretionCondition;
use super::error::ParseError;
use super::span::Span;

/// Parses a discretion condition from a string that starts with `**` and ends with `**`.
///
/// Returns the parsed [`DiscretionCondition`] with the prose text extracted.
/// The input must be the full condition text including the `**` delimiters.
pub fn parse_discretion(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<DiscretionCondition, ParseError> {
    let span = Span::new(byte_offset, byte_offset + input.len(), line, col);

    if !input.starts_with("**") {
        return Err(ParseError::error(
            "discretion condition must start with `**`",
            span,
        ));
    }

    if !input.ends_with("**") || input.len() < 4 {
        return Err(ParseError::error(
            "discretion condition must end with `**`, e.g. `**prose text**`",
            span,
        ));
    }

    let prose = &input[2..input.len() - 2];

    if prose.trim().is_empty() {
        return Err(ParseError::error(
            "discretion condition must contain non-empty prose text",
            span,
        ));
    }

    Ok(DiscretionCondition {
        prose: prose.to_string(),
        span,
    })
}

/// Returns true if the given string looks like a discretion condition (`**...**`).
pub fn is_discretion(input: &str) -> bool {
    input.starts_with("**") && input.ends_with("**") && input.len() >= 5
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_discretion() {
        let dc = parse_discretion("**all reviews pass**", 0, 1, 1).unwrap();
        assert_eq!(dc.prose, "all reviews pass");
    }

    #[test]
    fn parse_discretion_with_spaces() {
        let dc = parse_discretion("**code quality is acceptable**", 0, 1, 1).unwrap();
        assert_eq!(dc.prose, "code quality is acceptable");
    }

    #[test]
    fn parse_discretion_complex_prose() {
        let dc = parse_discretion(
            "**deployment is stable for 5 minutes with no error spikes**",
            0,
            1,
            1,
        )
        .unwrap();
        assert_eq!(
            dc.prose,
            "deployment is stable for 5 minutes with no error spikes"
        );
    }

    #[test]
    fn parse_discretion_preserves_internal_stars() {
        let dc = parse_discretion("**text with * inside**", 0, 1, 1).unwrap();
        assert_eq!(dc.prose, "text with * inside");
    }

    #[test]
    fn reject_missing_opening() {
        let err = parse_discretion("all reviews pass**", 0, 1, 1).unwrap_err();
        assert!(err.message.contains("start with `**`"));
    }

    #[test]
    fn reject_missing_closing() {
        let err = parse_discretion("**all reviews pass", 0, 1, 1).unwrap_err();
        assert!(err.message.contains("end with `**`"));
    }

    #[test]
    fn reject_empty_prose() {
        let err = parse_discretion("****", 0, 1, 1).unwrap_err();
        assert!(err.message.contains("non-empty prose"));
    }

    #[test]
    fn reject_whitespace_only_prose() {
        let err = parse_discretion("**   **", 0, 1, 1).unwrap_err();
        assert!(err.message.contains("non-empty prose"));
    }

    #[test]
    fn reject_too_short() {
        let err = parse_discretion("**a*", 0, 1, 1).unwrap_err();
        assert!(err.message.contains("end with `**`"));
    }

    #[test]
    fn is_discretion_true() {
        assert!(is_discretion("**something**"));
        assert!(is_discretion("**a b**"));
    }

    #[test]
    fn is_discretion_false() {
        assert!(!is_discretion("something"));
        assert!(!is_discretion("**"));
        assert!(!is_discretion("****"));
        assert!(!is_discretion("*a*"));
    }

    #[test]
    fn span_covers_full_input() {
        let dc = parse_discretion("**test prose**", 10, 5, 3).unwrap();
        assert_eq!(dc.span.start, 10);
        assert_eq!(dc.span.end, 24); // 10 + 14
        assert_eq!(dc.span.line, 5);
        assert_eq!(dc.span.col, 3);
    }

    #[test]
    fn parse_discretion_with_punctuation() {
        let dc = parse_discretion("**is the PR ready? (all checks green)**", 0, 1, 1).unwrap();
        assert_eq!(dc.prose, "is the PR ready? (all checks green)");
    }

    #[test]
    fn parse_discretion_with_numbers() {
        let dc = parse_discretion("**error rate below 0.1% for 10 minutes**", 0, 1, 1).unwrap();
        assert_eq!(dc.prose, "error rate below 0.1% for 10 minutes");
    }
}
