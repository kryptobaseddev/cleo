//! Expression parser for the CANT DSL.
//!
//! Parses the intentionally minimal expression language:
//! variable references, property access, string literals with interpolation,
//! numbers, booleans, task refs, addresses, arrays, comparisons, and
//! boolean operators (`and`, `or`, `not`).

use super::ast::{
    AddressExpr, ArrayExpr, BooleanExpr, ComparisonExpr, ComparisonOp, DurationExpr, DurationUnit,
    Expression, InterpolationExpr, LogicalExpr, LogicalOp, NameExpr, NegationExpr, NumberExpr,
    PropertyAccessExpr, StringExpr, StringSegment, TaskRefExpr,
};
use super::error::ParseError;
use super::span::Span;

/// Parses an expression string into an [`Expression`] AST node.
///
/// This is the top-level entry point for expression parsing. It handles
/// boolean operators (`and`, `or`) at the lowest precedence.
///
/// # Errors
///
/// Returns [`ParseError`] if the expression is syntactically invalid.
pub fn parse_expression(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Expression, ParseError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(ParseError::error(
            "empty expression",
            Span::new(byte_offset, byte_offset, line, col),
        ));
    }

    parse_logical_or(input, byte_offset, line, col)
}

/// Parses `or` expressions (lowest precedence).
fn parse_logical_or(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Expression, ParseError> {
    // Split on ` or ` — ensure it's surrounded by spaces to avoid matching in identifiers
    if let Some(pos) = find_keyword_operator(input, " or ") {
        let left_str = &input[..pos];
        let right_str = &input[pos + 4..];
        let left = parse_logical_and(left_str.trim(), byte_offset, line, col)?;
        let right_offset = byte_offset + pos + 4;
        let right = parse_logical_or(right_str.trim(), right_offset, line, col + (pos as u32) + 4)?;
        let span = Span::new(byte_offset, byte_offset + input.len(), line, col);
        return Ok(Expression::Logical(LogicalExpr {
            left: Box::new(left),
            op: LogicalOp::Or,
            right: Box::new(right),
            span,
        }));
    }

    parse_logical_and(input, byte_offset, line, col)
}

/// Parses `and` expressions.
fn parse_logical_and(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Expression, ParseError> {
    if let Some(pos) = find_keyword_operator(input, " and ") {
        let left_str = &input[..pos];
        let right_str = &input[pos + 5..];
        let left = parse_not(left_str.trim(), byte_offset, line, col)?;
        let right_offset = byte_offset + pos + 5;
        let right =
            parse_logical_and(right_str.trim(), right_offset, line, col + (pos as u32) + 5)?;
        let span = Span::new(byte_offset, byte_offset + input.len(), line, col);
        return Ok(Expression::Logical(LogicalExpr {
            left: Box::new(left),
            op: LogicalOp::And,
            right: Box::new(right),
            span,
        }));
    }

    parse_not(input, byte_offset, line, col)
}

/// Parses `not` prefix expressions.
fn parse_not(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Expression, ParseError> {
    if let Some(stripped) = input.strip_prefix("not ") {
        let rest = stripped.trim();
        let operand = parse_comparison(rest, byte_offset + 4, line, col + 4)?;
        let span = Span::new(byte_offset, byte_offset + input.len(), line, col);
        return Ok(Expression::Negation(NegationExpr {
            operand: Box::new(operand),
            span,
        }));
    }

    parse_comparison(input, byte_offset, line, col)
}

/// Parses comparison expressions (`==`, `!=`, `<`, `>`, `>=`, `<=`).
fn parse_comparison(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Expression, ParseError> {
    // Find comparison operator (outside quotes)
    let ops: &[(&str, ComparisonOp)] = &[
        ("==", ComparisonOp::Eq),
        ("!=", ComparisonOp::Ne),
        (">=", ComparisonOp::Ge),
        ("<=", ComparisonOp::Le),
        (">", ComparisonOp::Gt),
        ("<", ComparisonOp::Lt),
    ];

    for (op_str, op) in ops {
        if let Some(pos) = find_operator_outside_quotes(input, op_str) {
            let left_str = input[..pos].trim();
            let right_str = input[pos + op_str.len()..].trim();
            let left = parse_primary(left_str, byte_offset, line, col)?;
            let right_offset = byte_offset + pos + op_str.len();
            let right = parse_primary(
                right_str,
                right_offset,
                line,
                col + (pos as u32) + (op_str.len() as u32),
            )?;
            let span = Span::new(byte_offset, byte_offset + input.len(), line, col);
            return Ok(Expression::Comparison(ComparisonExpr {
                left: Box::new(left),
                op: *op,
                right: Box::new(right),
                span,
            }));
        }
    }

    parse_primary(input, byte_offset, line, col)
}

/// Parses primary (atomic) expressions: literals, names, property access, etc.
fn parse_primary(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Expression, ParseError> {
    let input = input.trim();
    let span = Span::new(byte_offset, byte_offset + input.len(), line, col);

    if input.is_empty() {
        return Err(ParseError::error("expected expression", span));
    }

    // String literal
    if input.starts_with('"') && input.ends_with('"') && input.len() >= 2 {
        return parse_string_expr(input, byte_offset, line, col);
    }

    // Array
    if input.starts_with('[') && input.ends_with(']') {
        return parse_array_expr(input, byte_offset, line, col);
    }

    // Task reference: T followed by digits
    if input.starts_with('T') && input.len() > 1 && input[1..].chars().all(|c| c.is_ascii_digit()) {
        return Ok(Expression::TaskRef(TaskRefExpr {
            id: input.to_string(),
            span,
        }));
    }

    // Address: @name
    if input.starts_with('@') && input.len() > 1 {
        return Ok(Expression::Address(AddressExpr {
            name: input[1..].to_string(),
            span,
        }));
    }

    // Boolean
    if input == "true" {
        return Ok(Expression::Boolean(BooleanExpr { value: true, span }));
    }
    if input == "false" {
        return Ok(Expression::Boolean(BooleanExpr { value: false, span }));
    }

    // Duration: digits followed by s/m/h/d
    if input.len() >= 2 {
        let last = input.as_bytes()[input.len() - 1];
        if matches!(last, b's' | b'm' | b'h' | b'd') {
            if let Ok(amount) = input[..input.len() - 1].parse::<u64>() {
                let unit = match last {
                    b's' => DurationUnit::Seconds,
                    b'm' => DurationUnit::Minutes,
                    b'h' => DurationUnit::Hours,
                    b'd' => DurationUnit::Days,
                    _ => unreachable!(),
                };
                return Ok(Expression::Duration(DurationExpr { amount, unit, span }));
            }
        }
    }

    // Number
    if let Ok(n) = input.parse::<f64>() {
        return Ok(Expression::Number(NumberExpr { value: n, span }));
    }

    // Property access: a.b.c
    if input.contains('.') && is_valid_dotted_name(input) {
        return parse_property_access(input, byte_offset, line, col);
    }

    // Name/identifier
    if is_valid_identifier(input) {
        return Ok(Expression::Name(NameExpr {
            name: input.to_string(),
            span,
        }));
    }

    Err(ParseError::error(
        format!("unrecognized expression: {input}"),
        span,
    ))
}

/// Parses a quoted string expression, handling `${expr}` interpolation.
fn parse_string_expr(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Expression, ParseError> {
    let inner = &input[1..input.len() - 1];
    let span = Span::new(byte_offset, byte_offset + input.len(), line, col);

    let segments = parse_string_segments(inner, byte_offset + 1, line, col + 1)?;

    Ok(Expression::String(StringExpr { segments, span }))
}

/// Parses the interior of a double-quoted string into segments.
///
/// Handles `${expr}` interpolation (single-pass, no nesting per T07).
fn parse_string_segments(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Vec<StringSegment>, ParseError> {
    let mut segments = Vec::new();
    let mut current_literal = String::new();
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            // Flush current literal
            if !current_literal.is_empty() {
                segments.push(StringSegment::Literal(std::mem::take(&mut current_literal)));
            }

            // Find closing }
            let expr_start = i + 2;
            let mut depth = 1;
            let mut j = expr_start;
            while j < bytes.len() && depth > 0 {
                match bytes[j] {
                    b'{' => depth += 1,
                    b'}' => depth -= 1,
                    _ => {}
                }
                if depth > 0 {
                    j += 1;
                }
            }

            if depth != 0 {
                return Err(ParseError::error(
                    "unclosed interpolation `${...}`",
                    Span::new(
                        byte_offset + i,
                        byte_offset + bytes.len(),
                        line,
                        col + (i as u32),
                    ),
                ));
            }

            let expr_str = &input[expr_start..j];
            let expr_offset = byte_offset + expr_start;
            let expr = parse_expression(expr_str, expr_offset, line, col + (expr_start as u32))?;

            segments.push(StringSegment::Interpolation(Expression::Interpolation(
                InterpolationExpr {
                    expression: Box::new(expr),
                    span: Span::new(byte_offset + i, byte_offset + j + 1, line, col + (i as u32)),
                },
            )));

            i = j + 1;
        } else if bytes[i] == b'\\' && i + 1 < bytes.len() {
            // Escape sequence
            match bytes[i + 1] {
                b'n' => current_literal.push('\n'),
                b't' => current_literal.push('\t'),
                b'\\' => current_literal.push('\\'),
                b'"' => current_literal.push('"'),
                b'$' => current_literal.push('$'),
                _ => {
                    current_literal.push('\\');
                    current_literal.push(bytes[i + 1] as char);
                }
            }
            i += 2;
        } else {
            current_literal.push(bytes[i] as char);
            i += 1;
        }
    }

    // Flush remaining literal
    if !current_literal.is_empty() {
        segments.push(StringSegment::Literal(current_literal));
    }

    Ok(segments)
}

/// Parses an array expression `[a, b, c]`.
fn parse_array_expr(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Expression, ParseError> {
    let inner = input[1..input.len() - 1].trim();
    let span = Span::new(byte_offset, byte_offset + input.len(), line, col);

    if inner.is_empty() {
        return Ok(Expression::Array(ArrayExpr {
            elements: Vec::new(),
            span,
        }));
    }

    let parts = split_array_parts(inner);
    let mut elements = Vec::new();

    for part in parts {
        let part = part.trim();
        let elem = parse_expression(part, byte_offset + 1, line, col + 1)?;
        elements.push(elem);
    }

    Ok(Expression::Array(ArrayExpr { elements, span }))
}

/// Parses a dotted property access like `a.b.c` into nested `PropertyAccess` nodes.
fn parse_property_access(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Expression, ParseError> {
    let parts: Vec<&str> = input.split('.').collect();
    let span = Span::new(byte_offset, byte_offset + input.len(), line, col);

    if parts.len() < 2 {
        return Ok(Expression::Name(NameExpr {
            name: input.to_string(),
            span,
        }));
    }

    let first_span = Span::new(byte_offset, byte_offset + parts[0].len(), line, col);
    let mut expr = Expression::Name(NameExpr {
        name: parts[0].to_string(),
        span: first_span,
    });

    let mut offset = byte_offset + parts[0].len() + 1; // +1 for the dot
    for part in &parts[1..] {
        expr = Expression::PropertyAccess(PropertyAccessExpr {
            object: Box::new(expr),
            property: part.to_string(),
            span: Span::new(byte_offset, offset + part.len(), line, col),
        });
        offset += part.len() + 1;
    }

    Ok(expr)
}

/// Finds a keyword operator (like ` and ` or ` or `) outside of quoted strings.
fn find_keyword_operator(input: &str, keyword: &str) -> Option<usize> {
    let mut in_quotes = false;
    let bytes = input.as_bytes();
    let kw_bytes = keyword.as_bytes();

    if bytes.len() < kw_bytes.len() {
        return None;
    }

    for i in 0..=bytes.len() - kw_bytes.len() {
        if bytes[i] == b'"' {
            in_quotes = !in_quotes;
            continue;
        }
        if !in_quotes && &bytes[i..i + kw_bytes.len()] == kw_bytes {
            return Some(i);
        }
    }

    None
}

/// Finds a comparison operator outside of quoted strings.
fn find_operator_outside_quotes(input: &str, op: &str) -> Option<usize> {
    let mut in_quotes = false;
    let bytes = input.as_bytes();
    let op_bytes = op.as_bytes();

    if bytes.len() < op_bytes.len() {
        return None;
    }

    for i in 0..=bytes.len() - op_bytes.len() {
        if bytes[i] == b'"' {
            in_quotes = !in_quotes;
            continue;
        }
        if !in_quotes && &bytes[i..i + op_bytes.len()] == op_bytes {
            // For single-char ops (< >), make sure we're not part of <=, >=, !=, ==
            if op.len() == 1 && i + 1 < bytes.len() && bytes[i + 1] == b'=' {
                continue;
            }
            return Some(i);
        }
    }

    None
}

/// Splits array elements by commas, respecting quoted strings.
fn split_array_parts(s: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut in_quotes = false;
    let mut bracket_depth = 0;
    let bytes = s.as_bytes();

    for i in 0..bytes.len() {
        match bytes[i] {
            b'"' => in_quotes = !in_quotes,
            b'[' if !in_quotes => bracket_depth += 1,
            b']' if !in_quotes => bracket_depth -= 1,
            b',' if !in_quotes && bracket_depth == 0 => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }

    if start <= s.len() {
        parts.push(&s[start..]);
    }

    parts
}

/// Checks if a string is a valid CANT identifier.
fn is_valid_identifier(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}

/// Checks if a string is a valid dotted name (`a.b.c`).
fn is_valid_dotted_name(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() >= 2 && parts.iter().all(|p| is_valid_identifier(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_name() {
        let expr = parse_expression("status", 0, 1, 1).unwrap();
        match expr {
            Expression::Name(n) => assert_eq!(n.name, "status"),
            other => panic!("expected Name, got {other:?}"),
        }
    }

    #[test]
    fn parse_dotted_name() {
        let expr = parse_expression("task.status", 0, 1, 1).unwrap();
        match expr {
            Expression::PropertyAccess(pa) => {
                assert_eq!(pa.property, "status");
            }
            other => panic!("expected PropertyAccess, got {other:?}"),
        }
    }

    #[test]
    fn parse_deeply_dotted_name() {
        let expr = parse_expression("a.b.c", 0, 1, 1).unwrap();
        match expr {
            Expression::PropertyAccess(pa) => {
                assert_eq!(pa.property, "c");
                match *pa.object {
                    Expression::PropertyAccess(inner) => {
                        assert_eq!(inner.property, "b");
                    }
                    other => panic!("expected inner PropertyAccess, got {other:?}"),
                }
            }
            other => panic!("expected PropertyAccess, got {other:?}"),
        }
    }

    #[test]
    fn parse_string_literal() {
        let expr = parse_expression("\"hello world\"", 0, 1, 1).unwrap();
        match expr {
            Expression::String(s) => {
                assert_eq!(s.segments.len(), 1);
                match &s.segments[0] {
                    StringSegment::Literal(text) => assert_eq!(text, "hello world"),
                    other => panic!("expected Literal segment, got {other:?}"),
                }
            }
            other => panic!("expected String, got {other:?}"),
        }
    }

    #[test]
    fn parse_string_with_interpolation() {
        let expr = parse_expression("\"hello ${name}\"", 0, 1, 1).unwrap();
        match expr {
            Expression::String(s) => {
                assert_eq!(s.segments.len(), 2);
                match &s.segments[0] {
                    StringSegment::Literal(text) => assert_eq!(text, "hello "),
                    other => panic!("expected Literal, got {other:?}"),
                }
                match &s.segments[1] {
                    StringSegment::Interpolation(_) => {}
                    other => panic!("expected Interpolation, got {other:?}"),
                }
            }
            other => panic!("expected String, got {other:?}"),
        }
    }

    #[test]
    fn parse_number() {
        let expr = parse_expression("42", 0, 1, 1).unwrap();
        match expr {
            Expression::Number(n) => assert!((n.value - 42.0).abs() < f64::EPSILON),
            other => panic!("expected Number, got {other:?}"),
        }
    }

    #[test]
    fn parse_float() {
        // Use 2.5 instead of 3.14 to avoid clippy::approx_constant lint
        // (the test just needs any float — the specific value doesn't matter).
        let expr = parse_expression("2.5", 0, 1, 1).unwrap();
        match expr {
            Expression::Number(n) => assert!((n.value - 2.5).abs() < f64::EPSILON),
            other => panic!("expected Number, got {other:?}"),
        }
    }

    #[test]
    fn parse_boolean_true() {
        let expr = parse_expression("true", 0, 1, 1).unwrap();
        match expr {
            Expression::Boolean(b) => assert!(b.value),
            other => panic!("expected Boolean true, got {other:?}"),
        }
    }

    #[test]
    fn parse_boolean_false() {
        let expr = parse_expression("false", 0, 1, 1).unwrap();
        match expr {
            Expression::Boolean(b) => assert!(!b.value),
            other => panic!("expected Boolean false, got {other:?}"),
        }
    }

    #[test]
    fn parse_task_ref() {
        let expr = parse_expression("T1234", 0, 1, 1).unwrap();
        match expr {
            Expression::TaskRef(t) => assert_eq!(t.id, "T1234"),
            other => panic!("expected TaskRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_address() {
        let expr = parse_expression("@ops-lead", 0, 1, 1).unwrap();
        match expr {
            Expression::Address(a) => assert_eq!(a.name, "ops-lead"),
            other => panic!("expected Address, got {other:?}"),
        }
    }

    #[test]
    fn parse_empty_array() {
        let expr = parse_expression("[]", 0, 1, 1).unwrap();
        match expr {
            Expression::Array(a) => assert!(a.elements.is_empty()),
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_with_elements() {
        let expr = parse_expression("[\"a\", \"b\", \"c\"]", 0, 1, 1).unwrap();
        match expr {
            Expression::Array(a) => assert_eq!(a.elements.len(), 3),
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn parse_comparison_eq() {
        let expr = parse_expression("status == \"done\"", 0, 1, 1).unwrap();
        match expr {
            Expression::Comparison(c) => {
                assert_eq!(c.op, ComparisonOp::Eq);
            }
            other => panic!("expected Comparison, got {other:?}"),
        }
    }

    #[test]
    fn parse_comparison_ne() {
        let expr = parse_expression("x != y", 0, 1, 1).unwrap();
        match expr {
            Expression::Comparison(c) => assert_eq!(c.op, ComparisonOp::Ne),
            other => panic!("expected Comparison, got {other:?}"),
        }
    }

    #[test]
    fn parse_comparison_gt() {
        let expr = parse_expression("a > b", 0, 1, 1).unwrap();
        match expr {
            Expression::Comparison(c) => assert_eq!(c.op, ComparisonOp::Gt),
            other => panic!("expected Comparison, got {other:?}"),
        }
    }

    #[test]
    fn parse_comparison_ge() {
        let expr = parse_expression("a >= b", 0, 1, 1).unwrap();
        match expr {
            Expression::Comparison(c) => assert_eq!(c.op, ComparisonOp::Ge),
            other => panic!("expected Comparison, got {other:?}"),
        }
    }

    #[test]
    fn parse_logical_and() {
        let expr = parse_expression("a and b", 0, 1, 1).unwrap();
        match expr {
            Expression::Logical(l) => assert_eq!(l.op, LogicalOp::And),
            other => panic!("expected Logical And, got {other:?}"),
        }
    }

    #[test]
    fn parse_logical_or() {
        let expr = parse_expression("a or b", 0, 1, 1).unwrap();
        match expr {
            Expression::Logical(l) => assert_eq!(l.op, LogicalOp::Or),
            other => panic!("expected Logical Or, got {other:?}"),
        }
    }

    #[test]
    fn parse_not() {
        let expr = parse_expression("not active", 0, 1, 1).unwrap();
        match expr {
            Expression::Negation(n) => match *n.operand {
                Expression::Name(name) => assert_eq!(name.name, "active"),
                other => panic!("expected Name inside not, got {other:?}"),
            },
            other => panic!("expected Negation, got {other:?}"),
        }
    }

    #[test]
    fn parse_duration_expr() {
        let expr = parse_expression("30s", 0, 1, 1).unwrap();
        match expr {
            Expression::Duration(d) => {
                assert_eq!(d.amount, 30);
                assert_eq!(d.unit, DurationUnit::Seconds);
            }
            other => panic!("expected Duration, got {other:?}"),
        }
    }

    #[test]
    fn empty_expression_is_error() {
        let err = parse_expression("", 0, 1, 1).unwrap_err();
        assert!(err.message.contains("empty"));
    }

    #[test]
    fn escape_sequences_in_string() {
        let expr = parse_expression("\"line1\\nline2\"", 0, 1, 1).unwrap();
        match expr {
            Expression::String(s) => match &s.segments[0] {
                StringSegment::Literal(text) => assert_eq!(text, "line1\nline2"),
                other => panic!("expected Literal, got {other:?}"),
            },
            other => panic!("expected String, got {other:?}"),
        }
    }
}
