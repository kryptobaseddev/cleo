//! Property parser for CANT DSL `key: value` lines.
//!
//! Parses property lines that appear in agent, skill, and other block
//! definitions. Supports string, number, boolean, identifier, duration,
//! and array value types.

use super::ast::{DurationUnit, DurationValue, Property, Spanned, StringValue, Value};
use super::error::ParseError;
use super::indent::IndentedLine;
use super::span::Span;

/// Parses a `key: value` line into a [`Property`] AST node.
///
/// The line content should already have its leading whitespace stripped
/// (available via `IndentedLine.content`).
pub fn parse_property(line: &IndentedLine<'_>) -> Result<Property, ParseError> {
    let content = line.content;
    let base_offset = line.byte_offset + line.indent;
    let line_span = Span::new(
        base_offset,
        base_offset + content.len(),
        line.line_number,
        (line.indent as u32) + 1,
    );

    let colon_pos = content.find(':').ok_or_else(|| {
        ParseError::error(format!("expected `key: value`, got: {content}"), line_span)
    })?;

    let key = content[..colon_pos].trim();
    let value_str = content[colon_pos + 1..].trim();

    if key.is_empty() {
        return Err(ParseError::error("empty property key", line_span));
    }

    let key_span = Span::new(
        base_offset,
        base_offset + key.len(),
        line.line_number,
        (line.indent as u32) + 1,
    );

    let val_start = base_offset + colon_pos + 1;
    let val_col = (line.indent + colon_pos + 2) as u32;
    let value = parse_value(value_str, val_start, line.line_number, val_col)?;

    Ok(Property {
        key: Spanned {
            value: key.to_string(),
            span: key_span,
        },
        value,
        span: line_span,
    })
}

/// Parses a value string into a [`Value`] AST node.
///
/// Handles:
/// - Quoted strings: `"text"`
/// - Booleans: `true`, `false`
/// - Numbers: `42`, `3.14`
/// - Durations: `30s`, `5m`, `2h`, `1d`
/// - Arrays: `[a, b, c]` or `["x", "y"]`
/// - Bare identifiers: `opus`
pub fn parse_value(s: &str, byte_offset: usize, line: u32, col: u32) -> Result<Value, ParseError> {
    let s = s.trim();

    if s.is_empty() {
        return Ok(Value::String(StringValue {
            raw: String::new(),
            double_quoted: false,
            span: Span::new(byte_offset, byte_offset, line, col),
        }));
    }

    let span = Span::new(byte_offset, byte_offset + s.len(), line, col);

    // Quoted string
    if s.starts_with('"') && s.ends_with('"') && s.len() >= 2 {
        return Ok(Value::String(StringValue {
            raw: s[1..s.len() - 1].to_string(),
            double_quoted: true,
            span,
        }));
    }

    // Array
    if s.starts_with('[') && s.ends_with(']') {
        return parse_array_value(s, byte_offset, line, col);
    }

    // Boolean
    match s {
        "true" => return Ok(Value::Boolean(true)),
        "false" => return Ok(Value::Boolean(false)),
        _ => {}
    }

    // Duration (must check before number since "30s" starts with digits)
    if let Some(dur) = try_parse_duration(s, byte_offset, line, col) {
        return Ok(Value::Duration(dur));
    }

    // Number
    if let Ok(n) = s.parse::<f64>() {
        return Ok(Value::Number(n));
    }

    // Bare identifier
    Ok(Value::Identifier(s.to_string()))
}

/// Tries to parse a duration value like `30s`, `5m`, `2h`, `1d`.
fn try_parse_duration(s: &str, byte_offset: usize, line: u32, col: u32) -> Option<DurationValue> {
    if s.len() < 2 {
        return None;
    }

    let last = s.as_bytes()[s.len() - 1];
    let unit = match last {
        b's' => DurationUnit::Seconds,
        b'm' => DurationUnit::Minutes,
        b'h' => DurationUnit::Hours,
        b'd' => DurationUnit::Days,
        _ => return None,
    };

    let amount_str = &s[..s.len() - 1];
    let amount = amount_str.parse::<u64>().ok()?;

    Some(DurationValue {
        amount,
        unit,
        span: Span::new(byte_offset, byte_offset + s.len(), line, col),
    })
}

/// Parses an array value `[a, b, c]`.
fn parse_array_value(
    s: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Value, ParseError> {
    let inner = s[1..s.len() - 1].trim();

    if inner.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }

    let elements = split_array_elements(inner);
    let mut values = Vec::new();

    for elem in elements {
        let elem = elem.trim();
        // Determine offset for element within the array
        let elem_offset = byte_offset + 1; // approximate
        let value = parse_value(elem, elem_offset, line, col + 1)?;
        values.push(value);
    }

    Ok(Value::Array(values))
}

/// Splits array elements by commas, respecting quoted strings.
fn split_array_elements(s: &str) -> Vec<&str> {
    let mut elements = Vec::new();
    let mut start = 0;
    let mut in_quotes = false;
    let bytes = s.as_bytes();

    for i in 0..bytes.len() {
        match bytes[i] {
            b'"' => in_quotes = !in_quotes,
            b',' if !in_quotes => {
                elements.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }

    // Last element
    if start <= s.len() {
        elements.push(&s[start..]);
    }

    elements
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::indent::split_lines;

    fn make_line(content: &str) -> IndentedLine<'_> {
        IndentedLine {
            content,
            indent: 0,
            line_number: 1,
            byte_offset: 0,
        }
    }

    #[test]
    fn parse_string_property() {
        let line = make_line("model: \"gpt-4\"");
        let prop = parse_property(&line).unwrap();
        assert_eq!(prop.key.value, "model");
        match &prop.value {
            Value::String(sv) => {
                assert_eq!(sv.raw, "gpt-4");
                assert!(sv.double_quoted);
            }
            other => panic!("expected String, got {:?}", other),
        }
    }

    #[test]
    fn parse_identifier_property() {
        let line = make_line("model: opus");
        let prop = parse_property(&line).unwrap();
        assert_eq!(prop.key.value, "model");
        match &prop.value {
            Value::Identifier(id) => assert_eq!(id, "opus"),
            other => panic!("expected Identifier, got {:?}", other),
        }
    }

    #[test]
    fn parse_boolean_property() {
        let line = make_line("persist: true");
        let prop = parse_property(&line).unwrap();
        match &prop.value {
            Value::Boolean(v) => assert!(*v),
            other => panic!("expected Boolean, got {:?}", other),
        }
    }

    #[test]
    fn parse_number_property() {
        let line = make_line("max_tokens: 4096");
        let prop = parse_property(&line).unwrap();
        match &prop.value {
            Value::Number(v) => assert!((v - 4096.0).abs() < f64::EPSILON),
            other => panic!("expected Number, got {:?}", other),
        }
    }

    #[test]
    fn parse_duration_seconds() {
        let line = make_line("timeout: 30s");
        let prop = parse_property(&line).unwrap();
        match &prop.value {
            Value::Duration(d) => {
                assert_eq!(d.amount, 30);
                assert_eq!(d.unit, DurationUnit::Seconds);
            }
            other => panic!("expected Duration, got {:?}", other),
        }
    }

    #[test]
    fn parse_duration_minutes() {
        let line = make_line("interval: 5m");
        let prop = parse_property(&line).unwrap();
        match &prop.value {
            Value::Duration(d) => {
                assert_eq!(d.amount, 5);
                assert_eq!(d.unit, DurationUnit::Minutes);
            }
            other => panic!("expected Duration, got {:?}", other),
        }
    }

    #[test]
    fn parse_duration_hours() {
        let line = make_line("retention: 24h");
        let prop = parse_property(&line).unwrap();
        match &prop.value {
            Value::Duration(d) => {
                assert_eq!(d.amount, 24);
                assert_eq!(d.unit, DurationUnit::Hours);
            }
            other => panic!("expected Duration, got {:?}", other),
        }
    }

    #[test]
    fn parse_duration_days() {
        let line = make_line("expiry: 7d");
        let prop = parse_property(&line).unwrap();
        match &prop.value {
            Value::Duration(d) => {
                assert_eq!(d.amount, 7);
                assert_eq!(d.unit, DurationUnit::Days);
            }
            other => panic!("expected Duration, got {:?}", other),
        }
    }

    #[test]
    fn parse_array_property() {
        let line = make_line("skills: [\"deploy\", \"monitor\"]");
        let prop = parse_property(&line).unwrap();
        match &prop.value {
            Value::Array(arr) => {
                assert_eq!(arr.len(), 2);
            }
            other => panic!("expected Array, got {:?}", other),
        }
    }

    #[test]
    fn parse_empty_array() {
        let line = make_line("tags: []");
        let prop = parse_property(&line).unwrap();
        match &prop.value {
            Value::Array(arr) => assert!(arr.is_empty()),
            other => panic!("expected empty Array, got {:?}", other),
        }
    }

    #[test]
    fn missing_colon_is_error() {
        let line = make_line("not a property");
        let err = parse_property(&line).unwrap_err();
        assert!(err.message.contains("key: value"));
    }

    #[test]
    fn empty_key_is_error() {
        let line = make_line(": value");
        let err = parse_property(&line).unwrap_err();
        assert!(err.message.contains("empty"));
    }

    #[test]
    fn property_from_split_lines() {
        let input = "  model: opus";
        let lines = split_lines(input).unwrap();
        let prop = parse_property(&lines[0]).unwrap();
        assert_eq!(prop.key.value, "model");
    }
}
