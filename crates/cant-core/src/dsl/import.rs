//! Import statement parser for the CANT DSL.
//!
//! Parses `@import` statements in two forms:
//! - `@import "./path.cant"` — anonymous import
//! - `@import "name" from "./path.cant"` — named import with alias

use super::ast::ImportStatement;
use super::error::ParseError;
use super::indent::IndentedLine;
use super::span::Span;

/// Parses an `@import` statement from the given line.
///
/// Returns the parsed [`ImportStatement`].
///
/// # Errors
///
/// Returns [`ParseError`] if the line is not a valid import statement.
pub fn parse_import(line: &IndentedLine<'_>) -> Result<ImportStatement, ParseError> {
    let content = line.content;
    let base_offset = line.byte_offset + line.indent;
    let col = (line.indent as u32) + 1;
    let line_span = Span::new(
        base_offset,
        base_offset + content.len(),
        line.line_number,
        col,
    );

    // Handle both "@import <path>" and bare "@import" (with trailing space trimmed)
    let after_import = if let Some(rest) = content.strip_prefix("@import ") {
        rest.trim()
    } else if content == "@import" {
        ""
    } else {
        return Err(ParseError::error("expected `@import`", line_span));
    };

    if after_import.is_empty() {
        return Err(ParseError::error(
            "expected path after `@import`",
            line_span,
        ));
    }

    // Check for `"name" from "path"` form
    if after_import.contains(" from ") {
        return parse_named_import(after_import, base_offset, line.line_number, col, line_span);
    }

    // Simple form: @import "./path.cant"
    let path = extract_quoted_string(after_import).ok_or_else(|| {
        ParseError::error(
            "expected quoted path in import, e.g. `@import \"./path.cant\"`",
            line_span,
        )
    })?;

    Ok(ImportStatement {
        path,
        alias: None,
        span: line_span,
    })
}

/// Parses the `"name" from "./path"` form.
fn parse_named_import(
    input: &str,
    _byte_offset: usize,
    _line: u32,
    _col: u32,
    line_span: Span,
) -> Result<ImportStatement, ParseError> {
    let from_pos = input
        .find(" from ")
        .ok_or_else(|| ParseError::error("expected `from` keyword in named import", line_span))?;

    let alias_part = input[..from_pos].trim();
    let path_part = input[from_pos + 6..].trim();

    // Extract alias — can be a quoted string or bare identifier
    let alias = if alias_part.starts_with('"') && alias_part.ends_with('"') && alias_part.len() >= 2
    {
        alias_part[1..alias_part.len() - 1].to_string()
    } else {
        alias_part.to_string()
    };

    if alias.is_empty() {
        return Err(ParseError::error("empty alias in named import", line_span));
    }

    let path = extract_quoted_string(path_part).ok_or_else(|| {
        ParseError::error(
            "expected quoted path after `from`, e.g. `@import name from \"./path.cant\"`",
            line_span,
        )
    })?;

    Ok(ImportStatement {
        path,
        alias: Some(alias),
        span: line_span,
    })
}

/// Extracts a quoted string value, stripping the surrounding quotes.
fn extract_quoted_string(s: &str) -> Option<String> {
    let s = s.trim();
    if s.starts_with('"') && s.ends_with('"') && s.len() >= 2 {
        Some(s[1..s.len() - 1].to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_simple_import() {
        let input = "@import \"./agents/scanner.cant\"";
        let lines = split_lines(input).unwrap();
        let imp = parse_import(&lines[0]).unwrap();
        assert_eq!(imp.path, "./agents/scanner.cant");
        assert!(imp.alias.is_none());
    }

    #[test]
    fn parse_named_import() {
        let input = "@import scanner from \"./agents/scanner.cant\"";
        let lines = split_lines(input).unwrap();
        let imp = parse_import(&lines[0]).unwrap();
        assert_eq!(imp.path, "./agents/scanner.cant");
        assert_eq!(imp.alias, Some("scanner".to_string()));
    }

    #[test]
    fn parse_named_import_quoted_alias() {
        let input = "@import \"scanner\" from \"./agents/scanner.cant\"";
        let lines = split_lines(input).unwrap();
        let imp = parse_import(&lines[0]).unwrap();
        assert_eq!(imp.path, "./agents/scanner.cant");
        assert_eq!(imp.alias, Some("scanner".to_string()));
    }

    #[test]
    fn missing_path_is_error() {
        let input = "@import ";
        let lines = split_lines(input).unwrap();
        let err = parse_import(&lines[0]).unwrap_err();
        assert!(err.message.contains("path"));
    }

    #[test]
    fn unquoted_path_is_error() {
        let input = "@import ./path.cant";
        let lines = split_lines(input).unwrap();
        let err = parse_import(&lines[0]).unwrap_err();
        assert!(err.message.contains("quoted path"));
    }

    #[test]
    fn named_import_missing_path() {
        let input = "@import scanner from unquoted";
        let lines = split_lines(input).unwrap();
        let err = parse_import(&lines[0]).unwrap_err();
        assert!(err.message.contains("quoted path"));
    }

    #[test]
    fn not_an_import_is_error() {
        let input = "import \"./path.cant\"";
        let lines = split_lines(input).unwrap();
        let err = parse_import(&lines[0]).unwrap_err();
        assert!(err.message.contains("@import"));
    }
}
