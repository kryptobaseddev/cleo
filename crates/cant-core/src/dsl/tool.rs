//! Tool block parser for the CANT DSL (CleoOS v2).
//!
//! Parses `tool Name:` blocks that declare LLM-callable tools beyond the
//! built-in dispatcher tools (per ULTRAPLAN §8).
//!
//! ```cant
//! tool dispatch_worker:
//!   description: "Spawn a worker subagent with a task assignment"
//!   tier: lead
//!   input:
//!     agent: "Name of the worker agent to spawn"
//!     task_id: "Task ID to assign"
//! ```
//!
//! Like team blocks, sub-blocks (`input:`, `output:`, `permissions:`,
//! `schema:`) are parsed uniformly as flat properties.

use super::ast::{Spanned, ToolDef};
use super::error::ParseError;
use super::indent::{IndentedLine, collect_block};
use super::property::parse_property_or_prose;
use super::span::Span;

/// Parses a `tool Name:` block starting at the given line index.
///
/// Returns the parsed [`ToolDef`] and the number of lines consumed.
///
/// # Errors
///
/// Returns [`ParseError`] if the header is not `tool Name:`, the name is
/// empty, or the body contains invalid property lines.
pub fn parse_tool_block(
    lines: &[IndentedLine<'_>],
    start_idx: usize,
) -> Result<(ToolDef, usize), ParseError> {
    let header = &lines[start_idx];
    let content = header.content;
    let base_offset = header.byte_offset + header.indent;
    let header_span = Span::new(
        base_offset,
        base_offset + content.len(),
        header.line_number,
        (header.indent as u32) + 1,
    );

    // Extract tool name from "tool Name:"
    let after_tool = content
        .strip_prefix("tool ")
        .ok_or_else(|| ParseError::error("expected `tool Name:`", header_span))?;

    let name = after_tool
        .strip_suffix(':')
        .ok_or_else(|| {
            ParseError::error(
                "expected colon after tool name, e.g. `tool Name:`",
                header_span,
            )
        })?
        .trim();

    if name.is_empty() {
        return Err(ParseError::error("empty tool name", header_span));
    }

    let name_offset = base_offset + "tool ".len();
    let name_spanned = Spanned {
        value: name.to_string(),
        span: Span::new(
            name_offset,
            name_offset + name.len(),
            header.line_number,
            (header.indent as u32) + 1 + "tool ".len() as u32,
        ),
    };

    // Collect the indented body block
    let body_lines = collect_block(lines, start_idx + 1, header.indent);
    let total_consumed = 1 + body_lines.len();

    let mut properties = Vec::new();

    let mut i = 0;
    while i < body_lines.len() {
        let line = &body_lines[i];

        if line.is_blank() || line.is_comment() {
            i += 1;
            continue;
        }

        let (prop, extra) = parse_property_or_prose(body_lines, i)?;
        properties.push(prop);
        i += 1 + extra;
    }

    // Calculate full span
    let end_offset = if body_lines.is_empty() {
        base_offset + content.len()
    } else {
        let last = &body_lines[body_lines.len() - 1];
        last.byte_offset + last.indent + last.content.len()
    };

    let tool = ToolDef {
        name: name_spanned,
        properties,
        span: Span::new(
            base_offset,
            end_offset,
            header.line_number,
            (header.indent as u32) + 1,
        ),
    };

    Ok((tool, total_consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_simple_tool() {
        let input =
            "tool dispatch_worker:\n  description: \"Spawn a subagent\"\n  tier: lead";
        let lines = split_lines(input).unwrap();
        let (tool, consumed) = parse_tool_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        assert_eq!(tool.name.value, "dispatch_worker");
        assert_eq!(tool.properties.len(), 2);
        assert_eq!(tool.properties[0].key.value, "description");
        assert_eq!(tool.properties[1].key.value, "tier");
    }

    #[test]
    fn missing_tool_keyword() {
        let input = "agent foo:\n  tier: core";
        let lines = split_lines(input).unwrap();
        let err = parse_tool_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("tool Name:"));
    }

    #[test]
    fn missing_colon() {
        let input = "tool dispatch_worker\n  description: \"x\"";
        let lines = split_lines(input).unwrap();
        let err = parse_tool_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("colon"));
    }

    #[test]
    fn empty_tool_name() {
        let input = "tool :\n  description: \"x\"";
        let lines = split_lines(input).unwrap();
        let err = parse_tool_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty tool name"));
    }

    #[test]
    fn tool_with_description() {
        let input = "tool query_brain:\n  description: \"Search the brain\"";
        let lines = split_lines(input).unwrap();
        let (tool, _consumed) = parse_tool_block(&lines, 0).unwrap();
        assert_eq!(tool.name.value, "query_brain");
        assert_eq!(tool.properties.len(), 1);
        assert_eq!(tool.properties[0].key.value, "description");
    }
}
