//! Frontmatter parser for CANT DSL documents.
//!
//! Parses the optional `---`-delimited YAML-style frontmatter block at
//! the start of a `.cant` file. Extracts `kind:` and `version:` fields
//! along with any additional properties.

use super::ast::{DocumentKind, Frontmatter, Property, Spanned, StringValue, Value};
use super::error::ParseError;
use super::indent::IndentedLine;
use super::span::Span;

/// Attempts to parse a frontmatter block from the beginning of the line list.
///
/// Returns `None` if the first line is not `---`. Otherwise, consumes lines
/// up to and including the closing `---` and returns a parsed [`Frontmatter`]
/// along with the number of lines consumed.
pub fn parse_frontmatter(
    lines: &[IndentedLine<'_>],
) -> Result<Option<(Frontmatter, usize)>, ParseError> {
    if lines.is_empty() || lines[0].content != "---" {
        return Ok(None);
    }

    let start_offset = lines[0].byte_offset;
    let start_line = lines[0].line_number;

    // Find closing ---
    let mut end_idx = None;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if line.content == "---" {
            end_idx = Some(i);
            break;
        }
    }

    let end_idx = match end_idx {
        Some(idx) => idx,
        None => {
            return Err(ParseError::error(
                "unclosed frontmatter: expected closing `---`",
                Span::new(start_offset, start_offset + 3, start_line, 1),
            ));
        }
    };

    let closing_line = &lines[end_idx];
    let end_offset = closing_line.byte_offset + closing_line.content.len();

    // Parse properties between the delimiters
    let mut properties = Vec::new();
    let mut kind: Option<DocumentKind> = None;
    let mut version: Option<String> = None;

    for line in &lines[1..end_idx] {
        if line.is_blank() || line.is_comment() {
            continue;
        }

        let prop = parse_frontmatter_property(line)?;

        // Extract special fields
        match prop.key.value.as_str() {
            "kind" => {
                kind = parse_document_kind(&prop.value);
            }
            "version" => {
                version = extract_string_value(&prop.value);
            }
            _ => {}
        }

        properties.push(prop);
    }

    let fm = Frontmatter {
        kind,
        version,
        properties,
        span: Span::new(start_offset, end_offset, start_line, 1),
    };

    Ok(Some((fm, end_idx + 1)))
}

/// Parses a single `key: value` line within the frontmatter block.
fn parse_frontmatter_property(line: &IndentedLine<'_>) -> Result<Property, ParseError> {
    let content = line.content;
    let line_span = Span::new(
        line.byte_offset + line.indent,
        line.byte_offset + line.indent + content.len(),
        line.line_number,
        (line.indent as u32) + 1,
    );

    let colon_pos = content.find(':').ok_or_else(|| {
        ParseError::error(
            format!("expected `key: value` in frontmatter, got: {content}"),
            line_span,
        )
    })?;

    let key = content[..colon_pos].trim();
    let value_str = content[colon_pos + 1..].trim();

    if key.is_empty() {
        return Err(ParseError::error("empty key in frontmatter", line_span));
    }

    let key_span = Span::new(
        line.byte_offset + line.indent,
        line.byte_offset + line.indent + key.len(),
        line.line_number,
        (line.indent as u32) + 1,
    );

    let val_offset = line.byte_offset + line.indent + colon_pos + 1;
    let val_col = (line.indent + colon_pos + 2) as u32; // after ": "
    let value = parse_simple_value(value_str, val_offset, line.line_number, val_col);

    Ok(Property {
        key: Spanned {
            value: key.to_string(),
            span: key_span,
        },
        value,
        span: line_span,
    })
}

/// Converts a `Value` to a `DocumentKind` if it matches a known kind string.
///
/// The frontmatter uses kebab-case for multi-word kinds (`model-routing`,
/// `mental-model`) per the CANT style guide, distinct from the Rust
/// PascalCase variant names ([`DocumentKind::ModelRouting`],
/// [`DocumentKind::MentalModel`]).
fn parse_document_kind(value: &Value) -> Option<DocumentKind> {
    let s = extract_string_value(value)?;
    match s.as_str() {
        "agent" => Some(DocumentKind::Agent),
        "skill" => Some(DocumentKind::Skill),
        "hook" => Some(DocumentKind::Hook),
        "workflow" => Some(DocumentKind::Workflow),
        "pipeline" => Some(DocumentKind::Pipeline),
        "config" => Some(DocumentKind::Config),
        "message" => Some(DocumentKind::Message),
        // CleoOS v2 document kinds (ULTRAPLAN §8):
        "protocol" => Some(DocumentKind::Protocol),
        "lifecycle" => Some(DocumentKind::Lifecycle),
        "team" => Some(DocumentKind::Team),
        "tool" => Some(DocumentKind::Tool),
        "model-routing" => Some(DocumentKind::ModelRouting),
        "mental-model" => Some(DocumentKind::MentalModel),
        _ => None,
    }
}

/// Extracts a plain string from a `Value`.
fn extract_string_value(value: &Value) -> Option<String> {
    match value {
        Value::String(sv) => Some(sv.raw.clone()),
        Value::Identifier(id) => Some(id.clone()),
        _ => None,
    }
}

/// Parses a simple value string into a [`Value`] AST node.
///
/// Handles quoted strings, booleans, numbers, and bare identifiers.
pub fn parse_simple_value(s: &str, byte_offset: usize, line: u32, col: u32) -> Value {
    let s = s.trim();

    if s.is_empty() {
        return Value::String(StringValue {
            raw: String::new(),
            double_quoted: false,
            span: Span::new(byte_offset, byte_offset, line, col),
        });
    }

    let span = Span::new(byte_offset, byte_offset + s.len(), line, col);

    // Quoted string
    if s.starts_with('"') && s.ends_with('"') && s.len() >= 2 {
        return Value::String(StringValue {
            raw: s[1..s.len() - 1].to_string(),
            double_quoted: true,
            span,
        });
    }

    // Boolean
    match s {
        "true" => return Value::Boolean(true),
        "false" => return Value::Boolean(false),
        _ => {}
    }

    // Number
    if let Ok(n) = s.parse::<f64>() {
        return Value::Number(n);
    }

    // Bare identifier
    Value::Identifier(s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_basic_frontmatter() {
        let input = "---\nkind: agent\nversion: \"1.0\"\n---\nagent Foo:";
        let lines = split_lines(input).unwrap();
        let result = parse_frontmatter(&lines).unwrap();
        assert!(result.is_some());
        let (fm, consumed) = result.unwrap();
        assert_eq!(consumed, 4);
        assert_eq!(fm.kind, Some(DocumentKind::Agent));
        assert_eq!(fm.version, Some("1.0".to_string()));
        assert_eq!(fm.properties.len(), 2);
    }

    #[test]
    fn no_frontmatter() {
        let input = "agent Foo:\n  model: opus";
        let lines = split_lines(input).unwrap();
        let result = parse_frontmatter(&lines).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn unclosed_frontmatter() {
        let input = "---\nkind: agent\nno closing";
        let lines = split_lines(input).unwrap();
        let err = parse_frontmatter(&lines).unwrap_err();
        assert!(err.message.contains("unclosed frontmatter"));
    }

    #[test]
    fn frontmatter_with_all_kinds() {
        for (kind_str, expected) in [
            ("agent", DocumentKind::Agent),
            ("skill", DocumentKind::Skill),
            ("hook", DocumentKind::Hook),
            ("workflow", DocumentKind::Workflow),
            ("pipeline", DocumentKind::Pipeline),
            ("config", DocumentKind::Config),
            ("message", DocumentKind::Message),
            // CleoOS v2 kinds (ULTRAPLAN §8):
            ("protocol", DocumentKind::Protocol),
            ("lifecycle", DocumentKind::Lifecycle),
            ("team", DocumentKind::Team),
            ("tool", DocumentKind::Tool),
            ("model-routing", DocumentKind::ModelRouting),
            ("mental-model", DocumentKind::MentalModel),
        ] {
            let input = format!("---\nkind: {kind_str}\n---");
            let lines = split_lines(&input).unwrap();
            let (fm, _) = parse_frontmatter(&lines).unwrap().unwrap();
            assert_eq!(fm.kind, Some(expected));
        }
    }

    #[test]
    fn frontmatter_unknown_kind() {
        let input = "---\nkind: unknown_kind\n---";
        let lines = split_lines(input).unwrap();
        let (fm, _) = parse_frontmatter(&lines).unwrap().unwrap();
        assert_eq!(fm.kind, None);
    }

    #[test]
    fn frontmatter_with_extra_properties() {
        let input = "---\nkind: agent\nauthor: \"someone\"\ndebug: true\n---";
        let lines = split_lines(input).unwrap();
        let (fm, consumed) = parse_frontmatter(&lines).unwrap().unwrap();
        assert_eq!(consumed, 5);
        assert_eq!(fm.properties.len(), 3);
    }

    #[test]
    fn frontmatter_blank_lines_skipped() {
        let input = "---\nkind: skill\n\nversion: \"2.0\"\n---";
        let lines = split_lines(input).unwrap();
        let (fm, _) = parse_frontmatter(&lines).unwrap().unwrap();
        assert_eq!(fm.kind, Some(DocumentKind::Skill));
        assert_eq!(fm.version, Some("2.0".to_string()));
    }

    #[test]
    fn parse_simple_value_types() {
        // Boolean
        match parse_simple_value("true", 0, 1, 1) {
            Value::Boolean(v) => assert!(v),
            other => panic!("expected Boolean, got {:?}", other),
        }

        // Number
        match parse_simple_value("42", 0, 1, 1) {
            Value::Number(v) => assert!((v - 42.0).abs() < f64::EPSILON),
            other => panic!("expected Number, got {:?}", other),
        }

        // Quoted string
        match parse_simple_value("\"hello\"", 0, 1, 1) {
            Value::String(sv) => {
                assert_eq!(sv.raw, "hello");
                assert!(sv.double_quoted);
            }
            other => panic!("expected String, got {:?}", other),
        }

        // Identifier
        match parse_simple_value("opus", 0, 1, 1) {
            Value::Identifier(id) => assert_eq!(id, "opus"),
            other => panic!("expected Identifier, got {:?}", other),
        }
    }
}
