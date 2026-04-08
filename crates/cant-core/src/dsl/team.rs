//! Team block parser for the CANT DSL (CleoOS v2).
//!
//! Parses `team Name:` blocks that declare the 3-tier multi-agent hierarchy
//! (orchestrator / leads / workers) and HITL routing rules per
//! ULTRAPLAN §10.
//!
//! ```cant
//! team platform:
//!   description: "End-to-end product team"
//!   orchestrator: cleo-prime
//!
//!   leads:
//!     engineering: engineering-lead
//!     validation: validation-lead
//!
//!   workers:
//!     engineering: [frontend-dev, backend-dev]
//!
//!   enforcement: strict
//! ```
//!
//! Sub-blocks (`leads:`, `workers:`, `routing:`) are parsed uniformly as
//! flat properties via the existing property machinery. Hierarchy lint rules
//! (TEAM-001..003) inspect `team.properties` by key.

use super::ast::{Spanned, TeamDef};
use super::error::ParseError;
use super::indent::{IndentedLine, collect_block};
use super::property::parse_property_or_prose;
use super::span::Span;

/// Parses a `team Name:` block starting at the given line index.
///
/// Returns the parsed [`TeamDef`] and the number of lines consumed.
///
/// # Errors
///
/// Returns [`ParseError`] if the header is not `team Name:`, the name is
/// empty, or the body contains invalid property lines.
pub fn parse_team_block(
    lines: &[IndentedLine<'_>],
    start_idx: usize,
) -> Result<(TeamDef, usize), ParseError> {
    let header = &lines[start_idx];
    let content = header.content;
    let base_offset = header.byte_offset + header.indent;
    let header_span = Span::new(
        base_offset,
        base_offset + content.len(),
        header.line_number,
        (header.indent as u32) + 1,
    );

    // Extract team name from "team Name:"
    let after_team = content
        .strip_prefix("team ")
        .ok_or_else(|| ParseError::error("expected `team Name:`", header_span))?;

    let name = after_team
        .strip_suffix(':')
        .ok_or_else(|| {
            ParseError::error(
                "expected colon after team name, e.g. `team Name:`",
                header_span,
            )
        })?
        .trim();

    if name.is_empty() {
        return Err(ParseError::error("empty team name", header_span));
    }

    let name_offset = base_offset + "team ".len();
    let name_spanned = Spanned {
        value: name.to_string(),
        span: Span::new(
            name_offset,
            name_offset + name.len(),
            header.line_number,
            (header.indent as u32) + 1 + "team ".len() as u32,
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

        // Sub-blocks like `leads:`, `workers:`, `routing:` are parsed as flat
        // properties via `parse_property_or_prose`. The child lines of those
        // headers are collected and returned as array or prose values by the
        // existing property parser. No dedicated machinery is required.
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

    let team = TeamDef {
        name: name_spanned,
        properties,
        span: Span::new(
            base_offset,
            end_offset,
            header.line_number,
            (header.indent as u32) + 1,
        ),
    };

    Ok((team, total_consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_simple_team() {
        let input = "team platform:\n  description: \"Product team\"\n  orchestrator: cleo-prime";
        let lines = split_lines(input).unwrap();
        let (team, consumed) = parse_team_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        assert_eq!(team.name.value, "platform");
        assert_eq!(team.properties.len(), 2);
        assert_eq!(team.properties[0].key.value, "description");
        assert_eq!(team.properties[1].key.value, "orchestrator");
    }

    #[test]
    fn missing_team_keyword() {
        let input = "agent foo:\n  tier: core";
        let lines = split_lines(input).unwrap();
        let err = parse_team_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("team Name:"));
    }

    #[test]
    fn missing_colon_after_name() {
        let input = "team foo\n  orchestrator: cleo-prime";
        let lines = split_lines(input).unwrap();
        let err = parse_team_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("colon"));
    }

    #[test]
    fn empty_team_name() {
        let input = "team :\n  orchestrator: cleo-prime";
        let lines = split_lines(input).unwrap();
        let err = parse_team_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty team name"));
    }

    #[test]
    fn team_with_orchestrator_property() {
        let input = "team platform:\n  orchestrator: cleo-prime\n  enforcement: strict";
        let lines = split_lines(input).unwrap();
        let (team, _consumed) = parse_team_block(&lines, 0).unwrap();
        assert_eq!(team.properties[0].key.value, "orchestrator");
        assert_eq!(team.properties[1].key.value, "enforcement");
    }
}
