//! Binding parser for CANT DSL `let` and `const` statements.
//!
//! Parses top-level bindings:
//! - `let name = expression`
//! - `const name = expression`

use super::ast::{LetBinding, Spanned};
use super::error::ParseError;
use super::expression::parse_expression;
use super::indent::IndentedLine;
use super::span::Span;

/// Parses a `let` or `const` binding from the given line.
///
/// Returns the parsed [`LetBinding`].
///
/// # Errors
///
/// Returns [`ParseError`] if the line is not a valid binding statement.
pub fn parse_binding(line: &IndentedLine<'_>) -> Result<LetBinding, ParseError> {
    let content = line.content;
    let base_offset = line.byte_offset + line.indent;
    let col = (line.indent as u32) + 1;
    let line_span = Span::new(
        base_offset,
        base_offset + content.len(),
        line.line_number,
        col,
    );

    // Determine keyword length
    let keyword_len = if content.starts_with("let ") {
        4
    } else if content.starts_with("const ") {
        6
    } else {
        return Err(ParseError::error(
            "expected `let` or `const` keyword",
            line_span,
        ));
    };

    let after_kw = &content[keyword_len..];

    let eq_pos = after_kw.find('=').ok_or_else(|| {
        ParseError::error(
            "expected `=` in binding, e.g. `let name = expression`",
            line_span,
        )
    })?;

    let name = after_kw[..eq_pos].trim();
    let expr_str = after_kw[eq_pos + 1..].trim();

    if name.is_empty() {
        return Err(ParseError::error("empty binding name", line_span));
    }

    if expr_str.is_empty() {
        return Err(ParseError::error(
            "expected expression after `=`",
            line_span,
        ));
    }

    let name_offset = base_offset + keyword_len;
    let name_spanned = Spanned {
        value: name.to_string(),
        span: Span::new(
            name_offset,
            name_offset + name.len(),
            line.line_number,
            col + keyword_len as u32,
        ),
    };

    let expr_offset = base_offset + keyword_len + eq_pos + 1;
    let expr_col = col + (keyword_len + eq_pos + 1) as u32;
    let value = parse_expression(expr_str, expr_offset, line.line_number, expr_col)?;

    Ok(LetBinding {
        name: name_spanned,
        value,
        span: line_span,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::ast::Expression;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_let_binding() {
        let input = "let status = task.status";
        let lines = split_lines(input).unwrap();
        let binding = parse_binding(&lines[0]).unwrap();
        assert_eq!(binding.name.value, "status");
        match &binding.value {
            Expression::PropertyAccess(pa) => assert_eq!(pa.property, "status"),
            other => panic!("expected PropertyAccess, got {other:?}"),
        }
    }

    #[test]
    fn parse_const_binding() {
        let input = "const threshold = 42";
        let lines = split_lines(input).unwrap();
        let binding = parse_binding(&lines[0]).unwrap();
        assert_eq!(binding.name.value, "threshold");
        match &binding.value {
            Expression::Number(n) => assert!((n.value - 42.0).abs() < f64::EPSILON),
            other => panic!("expected Number, got {other:?}"),
        }
    }

    #[test]
    fn parse_let_with_string() {
        let input = "let greeting = \"hello world\"";
        let lines = split_lines(input).unwrap();
        let binding = parse_binding(&lines[0]).unwrap();
        assert_eq!(binding.name.value, "greeting");
        match &binding.value {
            Expression::String(_) => {}
            other => panic!("expected String, got {other:?}"),
        }
    }

    #[test]
    fn parse_let_with_boolean() {
        let input = "let active = true";
        let lines = split_lines(input).unwrap();
        let binding = parse_binding(&lines[0]).unwrap();
        match &binding.value {
            Expression::Boolean(b) => assert!(b.value),
            other => panic!("expected Boolean, got {other:?}"),
        }
    }

    #[test]
    fn missing_equals_is_error() {
        let input = "let status task.status";
        let lines = split_lines(input).unwrap();
        let err = parse_binding(&lines[0]).unwrap_err();
        assert!(err.message.contains("="));
    }

    #[test]
    fn empty_name_is_error() {
        let input = "let  = value";
        let lines = split_lines(input).unwrap();
        let err = parse_binding(&lines[0]).unwrap_err();
        assert!(err.message.contains("empty binding name"));
    }

    #[test]
    fn empty_expression_is_error() {
        let input = "let name =";
        let lines = split_lines(input).unwrap();
        let err = parse_binding(&lines[0]).unwrap_err();
        assert!(err.message.contains("expression"));
    }

    #[test]
    fn not_a_binding_is_error() {
        let input = "var x = 42";
        let lines = split_lines(input).unwrap();
        let err = parse_binding(&lines[0]).unwrap_err();
        assert!(err.message.contains("let"));
    }

    #[test]
    fn indented_binding() {
        let input = "  let x = 10";
        let lines = split_lines(input).unwrap();
        let binding = parse_binding(&lines[0]).unwrap();
        assert_eq!(binding.name.value, "x");
    }
}
