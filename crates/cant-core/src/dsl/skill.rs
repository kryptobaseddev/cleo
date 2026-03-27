//! Skill block parser for the CANT DSL.
//!
//! Parses `skill Name:` blocks with properties.
//!
//! ```cant
//! skill ct-deploy:
//!   description: "Deployment automation"
//!   tier: core
//! ```

use super::ast::{SkillDef, Spanned};
use super::error::ParseError;
use super::indent::{IndentedLine, collect_block};
use super::property::parse_property;
use super::span::Span;

/// Parses a `skill Name:` block starting at the given line index.
///
/// Returns the parsed [`SkillDef`] and the number of lines consumed.
pub fn parse_skill_block(
    lines: &[IndentedLine<'_>],
    start_idx: usize,
) -> Result<(SkillDef, usize), ParseError> {
    let header = &lines[start_idx];
    let content = header.content;
    let base_offset = header.byte_offset + header.indent;
    let header_span = Span::new(
        base_offset,
        base_offset + content.len(),
        header.line_number,
        (header.indent as u32) + 1,
    );

    // Extract skill name from "skill Name:"
    let after_skill = content
        .strip_prefix("skill ")
        .ok_or_else(|| ParseError::error("expected `skill Name:`", header_span))?;

    let name = after_skill
        .strip_suffix(':')
        .ok_or_else(|| {
            ParseError::error(
                "expected colon after skill name, e.g. `skill Name:`",
                header_span,
            )
        })?
        .trim();

    if name.is_empty() {
        return Err(ParseError::error("empty skill name", header_span));
    }

    let name_offset = base_offset + "skill ".len();
    let name_spanned = Spanned {
        value: name.to_string(),
        span: Span::new(
            name_offset,
            name_offset + name.len(),
            header.line_number,
            (header.indent as u32) + 1 + "skill ".len() as u32,
        ),
    };

    // Collect the indented body block
    let body_lines = collect_block(lines, start_idx + 1, header.indent);
    let total_consumed = 1 + body_lines.len();

    let mut properties = Vec::new();

    for line in body_lines {
        if line.is_blank() || line.is_comment() {
            continue;
        }

        let prop = parse_property(line)?;
        properties.push(prop);
    }

    // Calculate full span
    let end_offset = if body_lines.is_empty() {
        base_offset + content.len()
    } else {
        let last = &body_lines[body_lines.len() - 1];
        last.byte_offset + last.indent + last.content.len()
    };

    let skill = SkillDef {
        name: name_spanned,
        properties,
        span: Span::new(
            base_offset,
            end_offset,
            header.line_number,
            (header.indent as u32) + 1,
        ),
    };

    Ok((skill, total_consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_simple_skill() {
        let input = "skill ct-deploy:\n  description: \"Deployment automation\"\n  tier: core";
        let lines = split_lines(input).unwrap();
        let (skill, consumed) = parse_skill_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        assert_eq!(skill.name.value, "ct-deploy");
        assert_eq!(skill.properties.len(), 2);
        assert_eq!(skill.properties[0].key.value, "description");
        assert_eq!(skill.properties[1].key.value, "tier");
    }

    #[test]
    fn parse_skill_no_body() {
        let input = "skill empty:";
        let lines = split_lines(input).unwrap();
        let (skill, consumed) = parse_skill_block(&lines, 0).unwrap();
        assert_eq!(consumed, 1);
        assert_eq!(skill.name.value, "empty");
        assert!(skill.properties.is_empty());
    }

    #[test]
    fn missing_skill_keyword() {
        let input = "agent foo:\n  tier: core";
        let lines = split_lines(input).unwrap();
        let err = parse_skill_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("skill Name:"));
    }

    #[test]
    fn missing_colon_after_name() {
        let input = "skill foo\n  tier: core";
        let lines = split_lines(input).unwrap();
        let err = parse_skill_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("colon"));
    }

    #[test]
    fn empty_skill_name() {
        let input = "skill :\n  tier: core";
        let lines = split_lines(input).unwrap();
        let err = parse_skill_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty skill name"));
    }

    #[test]
    fn skill_with_blank_lines() {
        let input = "skill monitor:\n  tier: optional\n\n  version: \"1.0\"";
        let lines = split_lines(input).unwrap();
        let (skill, consumed) = parse_skill_block(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        assert_eq!(skill.properties.len(), 2);
    }

    #[test]
    fn skill_followed_by_other_section() {
        let input = "skill a:\n  tier: core\nskill b:\n  tier: optional";
        let lines = split_lines(input).unwrap();
        let (skill_a, consumed_a) = parse_skill_block(&lines, 0).unwrap();
        assert_eq!(consumed_a, 2);
        assert_eq!(skill_a.name.value, "a");

        let (skill_b, consumed_b) = parse_skill_block(&lines, consumed_a).unwrap();
        assert_eq!(consumed_b, 2);
        assert_eq!(skill_b.name.value, "b");
    }
}
