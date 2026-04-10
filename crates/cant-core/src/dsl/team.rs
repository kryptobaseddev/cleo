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
//!
//!   consult-when: "task complexity exceeds single-sprint scope"
//!   stages: [discover, plan, execute, review]
//! ```
//!
//! Sub-blocks (`leads:`, `workers:`, `routing:`) are parsed uniformly as
//! flat properties via the existing property machinery. Hierarchy lint rules
//! (TEAM-001..003) inspect `team.properties` by key.
//!
//! ## Wave 7a Grammar Extensions (ULTRAPLAN §8 + §10.3)
//!
//! Two new sub-fields are supported on `team` blocks:
//!
//! - `consult-when:` — human-readable condition string describing when the
//!   orchestrator should escalate to human-in-the-loop consultation.
//!   Stored in [`TeamDef`] as `consult_when: Option<String>`.
//!
//! - `stages: [...]` — ordered list of stage names this team executes through
//!   (e.g. `[discover, plan, execute, review]`). Stored in [`TeamDef`] as
//!   `stages: Vec<String>`.
//!
//! Both fields are optional and backward-compatible — existing CANT files
//! without them continue to parse correctly. Lint rule `TEAM-002` now
//! additionally checks that lead-role agents carry both sub-fields.

use super::ast::{Spanned, TeamDef, Value};
use super::error::ParseError;
use super::indent::{IndentedLine, collect_block};
use super::property::parse_property_or_prose;
use super::span::Span;

// ── Wave 7a helpers ──────────────────────────────────────────────────────────

/// Extract a single string value from a [`Value`] (string literal or identifier).
fn extract_prop_string(value: &Value) -> Option<String> {
    match value {
        Value::String(sv) => Some(sv.raw.clone()),
        Value::Identifier(id) => Some(id.clone()),
        _ => None,
    }
}

/// Extract an ordered list of string values from a [`Value::Array`].
///
/// Non-string elements (numbers, booleans, nested arrays) are silently skipped
/// so that malformed arrays do not block parsing — lint rules report violations.
fn extract_prop_array_strings(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|v| match v {
                Value::String(sv) => Some(sv.raw.clone()),
                Value::Identifier(id) => Some(id.clone()),
                _ => None,
            })
            .collect(),
        // Single bare identifier treated as a one-element stage list.
        Value::Identifier(id) => vec![id.clone()],
        Value::String(sv) => vec![sv.raw.clone()],
        _ => Vec::new(),
    }
}

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
    let mut consult_when: Option<String> = None;
    let mut stages: Vec<String> = Vec::new();

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

        // Wave 7a: extract `consult-when:` and `stages:` into dedicated fields
        // while still keeping them in `properties` for lint rule key-lookup.
        match prop.key.value.as_str() {
            "consult-when" => {
                consult_when = extract_prop_string(&prop.value);
            }
            "stages" => {
                stages = extract_prop_array_strings(&prop.value);
            }
            _ => {}
        }

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
        consult_when,
        stages,
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

    // ── Wave 7a: consult-when + stages ───────────────────────────────────

    #[test]
    fn team_with_consult_when() {
        let input = concat!(
            "team platform:\n",
            "  orchestrator: cleo-prime\n",
            "  consult-when: \"scope exceeds single sprint\"\n",
        );
        let lines = split_lines(input).unwrap();
        let (team, _) = parse_team_block(&lines, 0).unwrap();
        assert_eq!(
            team.consult_when.as_deref(),
            Some("scope exceeds single sprint")
        );
        // Also present as a regular property for lint-rule key-lookup.
        assert!(
            team.properties
                .iter()
                .any(|p| p.key.value == "consult-when")
        );
    }

    #[test]
    fn team_with_stages() {
        let input = concat!(
            "team platform:\n",
            "  orchestrator: cleo-prime\n",
            "  stages: [discover, plan, execute, review]\n",
        );
        let lines = split_lines(input).unwrap();
        let (team, _) = parse_team_block(&lines, 0).unwrap();
        assert_eq!(team.stages, vec!["discover", "plan", "execute", "review"]);
        assert!(team.properties.iter().any(|p| p.key.value == "stages"));
    }

    #[test]
    fn team_without_consult_when_defaults_none() {
        let input = "team platform:\n  orchestrator: cleo-prime\n";
        let lines = split_lines(input).unwrap();
        let (team, _) = parse_team_block(&lines, 0).unwrap();
        assert!(team.consult_when.is_none());
    }

    #[test]
    fn team_without_stages_defaults_empty() {
        let input = "team platform:\n  orchestrator: cleo-prime\n";
        let lines = split_lines(input).unwrap();
        let (team, _) = parse_team_block(&lines, 0).unwrap();
        assert!(team.stages.is_empty());
    }

    #[test]
    fn team_with_both_consult_when_and_stages() {
        let input = concat!(
            "team engineering:\n",
            "  description: \"Engineering team\"\n",
            "  orchestrator: cleo-prime\n",
            "  consult-when: \"task complexity exceeds single-sprint scope\"\n",
            "  stages: [discover, plan, execute, review]\n",
            "  enforcement: strict\n",
        );
        let lines = split_lines(input).unwrap();
        let (team, consumed) = parse_team_block(&lines, 0).unwrap();
        assert_eq!(consumed, 6);
        assert_eq!(team.name.value, "engineering");
        assert_eq!(
            team.consult_when.as_deref(),
            Some("task complexity exceeds single-sprint scope")
        );
        assert_eq!(team.stages, vec!["discover", "plan", "execute", "review"]);
    }
}
