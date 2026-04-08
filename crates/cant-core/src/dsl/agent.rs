//! Agent block parser for the CANT DSL.
//!
//! Parses `agent Name:` blocks with properties, permissions, and inline hooks.
//!
//! ```cant
//! agent ops-lead:
//!   model: opus
//!   prompt: "You coordinate operations"
//!   skills: ["ct-deploy", "ct-monitor"]
//!   permissions:
//!     tasks: read, write
//!     session: read
//! ```

use super::ast::{AgentDef, ContextRef, Spanned};
use super::error::ParseError;
use super::hook::parse_hook_block;
use super::indent::{IndentedLine, collect_block};
use super::permission::parse_permissions;
use super::property::parse_property_or_prose;
use super::span::Span;

/// Parses an `agent Name:` block starting at the given line index.
///
/// Returns the parsed [`AgentDef`] and the number of lines consumed.
pub fn parse_agent_block(
    lines: &[IndentedLine<'_>],
    start_idx: usize,
) -> Result<(AgentDef, usize), ParseError> {
    let header = &lines[start_idx];
    let content = header.content;
    let base_offset = header.byte_offset + header.indent;
    let header_span = Span::new(
        base_offset,
        base_offset + content.len(),
        header.line_number,
        (header.indent as u32) + 1,
    );

    // Extract agent name from "agent Name:"
    let after_agent = content
        .strip_prefix("agent ")
        .ok_or_else(|| ParseError::error("expected `agent Name:`", header_span))?;

    let name = after_agent
        .strip_suffix(':')
        .ok_or_else(|| {
            ParseError::error(
                "expected colon after agent name, e.g. `agent Name:`",
                header_span,
            )
        })?
        .trim();

    if name.is_empty() {
        return Err(ParseError::error("empty agent name", header_span));
    }

    let name_offset = base_offset + "agent ".len();
    let name_spanned = Spanned {
        value: name.to_string(),
        span: Span::new(
            name_offset,
            name_offset + name.len(),
            header.line_number,
            (header.indent as u32) + 1 + "agent ".len() as u32,
        ),
    };

    // Collect the indented body block
    let body_lines = collect_block(lines, start_idx + 1, header.indent);
    let total_consumed = 1 + body_lines.len();

    let mut properties = Vec::new();
    let mut permissions = Vec::new();
    let mut context_refs = Vec::new();
    let mut hooks = Vec::new();
    let mut context_sources = Vec::new();
    let mut mental_model = Vec::new();

    let mut i = 0;
    while i < body_lines.len() {
        let line = &body_lines[i];

        if line.is_blank() || line.is_comment() {
            i += 1;
            continue;
        }

        // Check for permissions: sub-block
        if line.content == "permissions:" {
            let perm_lines = collect_block(body_lines, i + 1, line.indent);
            permissions = parse_permissions(perm_lines)?;
            i += 1 + perm_lines.len();
            continue;
        }

        // Check for context: sub-block
        if line.content == "context:" {
            let ctx_lines = collect_block(body_lines, i + 1, line.indent);
            context_refs = parse_context_refs(ctx_lines)?;
            i += 1 + ctx_lines.len();
            continue;
        }

        // Check for context_sources: sub-block (CleoOS v2 — JIT context pull)
        if line.content == "context_sources:" {
            let cs_lines = collect_block(body_lines, i + 1, line.indent);
            let mut inner_i = 0;
            while inner_i < cs_lines.len() {
                let cs_line = &cs_lines[inner_i];
                if cs_line.is_blank() || cs_line.is_comment() {
                    inner_i += 1;
                    continue;
                }
                let (prop, extra) = parse_property_or_prose(cs_lines, inner_i)?;
                context_sources.push(prop);
                inner_i += 1 + extra;
            }
            i += 1 + cs_lines.len();
            continue;
        }

        // Check for mental_model: sub-block (CleoOS v2 — per-agent persistent model)
        if line.content == "mental_model:" {
            let mm_lines = collect_block(body_lines, i + 1, line.indent);
            let mut inner_i = 0;
            while inner_i < mm_lines.len() {
                let mm_line = &mm_lines[inner_i];
                if mm_line.is_blank() || mm_line.is_comment() {
                    inner_i += 1;
                    continue;
                }
                let (prop, extra) = parse_property_or_prose(mm_lines, inner_i)?;
                mental_model.push(prop);
                inner_i += 1 + extra;
            }
            i += 1 + mm_lines.len();
            continue;
        }

        // Check for inline hook: `on EventName:`
        if line.content.starts_with("on ") && line.content.ends_with(':') {
            let (hook, hook_consumed) = parse_hook_block(body_lines, i)?;
            hooks.push(hook);
            i += hook_consumed;
            continue;
        }

        // Regular property (with prose block support)
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

    let agent = AgentDef {
        name: name_spanned,
        properties,
        permissions,
        context_refs,
        hooks,
        context_sources,
        mental_model,
        span: Span::new(
            base_offset,
            end_offset,
            header.line_number,
            (header.indent as u32) + 1,
        ),
    };

    Ok((agent, total_consumed))
}

/// Parses the child lines of a `context:` block into [`ContextRef`] entries.
///
/// Each child line is a bare name or a quoted string representing a context reference.
fn parse_context_refs(lines: &[IndentedLine<'_>]) -> Result<Vec<ContextRef>, ParseError> {
    let mut refs = Vec::new();

    for line in lines {
        if line.is_blank() || line.is_comment() {
            continue;
        }

        let content = line.content;
        let base_offset = line.byte_offset + line.indent;
        let line_span = Span::new(
            base_offset,
            base_offset + content.len(),
            line.line_number,
            (line.indent as u32) + 1,
        );

        // Strip surrounding quotes if present
        let name = if content.starts_with('"') && content.ends_with('"') && content.len() >= 2 {
            content[1..content.len() - 1].to_string()
        } else {
            content.to_string()
        };

        if name.is_empty() {
            return Err(ParseError::error("empty context reference", line_span));
        }

        refs.push(ContextRef {
            name,
            span: line_span,
        });
    }

    Ok(refs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_simple_agent() {
        let input = "agent ops-lead:\n  model: opus\n  persist: true";
        let lines = split_lines(input).unwrap();
        let (agent, consumed) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        assert_eq!(agent.name.value, "ops-lead");
        assert_eq!(agent.properties.len(), 2);
        assert_eq!(agent.properties[0].key.value, "model");
        assert_eq!(agent.properties[1].key.value, "persist");
    }

    #[test]
    fn parse_agent_with_permissions() {
        let input = "agent scanner:\n  model: opus\n  permissions:\n    tasks: read, write\n    session: read";
        let lines = split_lines(input).unwrap();
        let (agent, consumed) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(consumed, 5);
        assert_eq!(agent.name.value, "scanner");
        assert_eq!(agent.properties.len(), 1);
        assert_eq!(agent.permissions.len(), 2);
        assert_eq!(agent.permissions[0].domain, "tasks");
        assert_eq!(agent.permissions[0].access, vec!["read", "write"]);
    }

    #[test]
    fn parse_agent_with_skills_array() {
        let input = "agent deployer:\n  skills: [\"ct-deploy\", \"ct-monitor\"]";
        let lines = split_lines(input).unwrap();
        let (agent, _) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(agent.name.value, "deployer");
        assert_eq!(agent.properties.len(), 1);
        assert_eq!(agent.properties[0].key.value, "skills");
    }

    #[test]
    fn missing_agent_keyword() {
        let input = "skill ops-lead:\n  model: opus";
        let lines = split_lines(input).unwrap();
        let err = parse_agent_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("agent Name:"));
    }

    #[test]
    fn missing_colon_after_name() {
        let input = "agent ops-lead\n  model: opus";
        let lines = split_lines(input).unwrap();
        let err = parse_agent_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("colon"));
    }

    #[test]
    fn empty_agent_name() {
        let input = "agent :\n  model: opus";
        let lines = split_lines(input).unwrap();
        let err = parse_agent_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty agent name"));
    }

    #[test]
    fn agent_with_blank_lines() {
        let input = "agent test:\n  model: opus\n\n  persist: true";
        let lines = split_lines(input).unwrap();
        let (agent, consumed) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        assert_eq!(agent.properties.len(), 2);
    }

    #[test]
    fn agent_followed_by_other_section() {
        let input = "agent a:\n  model: opus\nagent b:\n  model: sonnet";
        let lines = split_lines(input).unwrap();
        let (agent_a, consumed_a) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(consumed_a, 2);
        assert_eq!(agent_a.name.value, "a");

        let (agent_b, consumed_b) = parse_agent_block(&lines, consumed_a).unwrap();
        assert_eq!(consumed_b, 2);
        assert_eq!(agent_b.name.value, "b");
    }

    // ── Context block tests ─────────────────────────────────────────

    #[test]
    fn parse_agent_with_context_block() {
        let input = "agent ops:\n  model: opus\n  context:\n    active-tasks\n    recent-decisions\n    memory-bridge";
        let lines = split_lines(input).unwrap();
        let (agent, consumed) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(consumed, 6);
        assert_eq!(agent.name.value, "ops");
        assert_eq!(agent.properties.len(), 1);
        assert_eq!(agent.context_refs.len(), 3);
        assert_eq!(agent.context_refs[0].name, "active-tasks");
        assert_eq!(agent.context_refs[1].name, "recent-decisions");
        assert_eq!(agent.context_refs[2].name, "memory-bridge");
    }

    #[test]
    fn parse_agent_context_single_ref() {
        let input = "agent scanner:\n  context:\n    memory-bridge";
        let lines = split_lines(input).unwrap();
        let (agent, consumed) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        assert_eq!(agent.context_refs.len(), 1);
        assert_eq!(agent.context_refs[0].name, "memory-bridge");
    }

    #[test]
    fn parse_agent_context_quoted_strings() {
        let input = "agent ops:\n  context:\n    \"active-tasks\"\n    \"memory-bridge\"";
        let lines = split_lines(input).unwrap();
        let (agent, _) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(agent.context_refs.len(), 2);
        assert_eq!(agent.context_refs[0].name, "active-tasks");
        assert_eq!(agent.context_refs[1].name, "memory-bridge");
    }

    #[test]
    fn parse_agent_context_mixed_bare_and_quoted() {
        let input = "agent ops:\n  context:\n    active-tasks\n    \"memory-bridge\"";
        let lines = split_lines(input).unwrap();
        let (agent, _) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(agent.context_refs.len(), 2);
        assert_eq!(agent.context_refs[0].name, "active-tasks");
        assert_eq!(agent.context_refs[1].name, "memory-bridge");
    }

    #[test]
    fn parse_agent_context_with_blank_lines() {
        let input = "agent ops:\n  context:\n    active-tasks\n\n    memory-bridge";
        let lines = split_lines(input).unwrap();
        let (agent, consumed) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(consumed, 5);
        assert_eq!(agent.context_refs.len(), 2);
    }

    #[test]
    fn parse_agent_context_with_comments() {
        let input = "agent ops:\n  context:\n    # primary context\n    active-tasks\n    # secondary\n    memory-bridge";
        let lines = split_lines(input).unwrap();
        let (agent, consumed) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(consumed, 6);
        assert_eq!(agent.context_refs.len(), 2);
        assert_eq!(agent.context_refs[0].name, "active-tasks");
        assert_eq!(agent.context_refs[1].name, "memory-bridge");
    }

    #[test]
    fn parse_agent_context_empty_block() {
        let input = "agent ops:\n  model: opus\n  context:";
        let lines = split_lines(input).unwrap();
        let (agent, consumed) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        assert_eq!(agent.context_refs.len(), 0);
        assert_eq!(agent.properties.len(), 1);
    }

    #[test]
    fn parse_agent_context_and_permissions() {
        let input = "agent ops:\n  model: opus\n  context:\n    active-tasks\n  permissions:\n    tasks: read, write";
        let lines = split_lines(input).unwrap();
        let (agent, consumed) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(consumed, 6);
        assert_eq!(agent.properties.len(), 1);
        assert_eq!(agent.context_refs.len(), 1);
        assert_eq!(agent.context_refs[0].name, "active-tasks");
        assert_eq!(agent.permissions.len(), 1);
        assert_eq!(agent.permissions[0].domain, "tasks");
    }

    #[test]
    fn parse_agent_context_and_hooks() {
        let input = "agent ops:\n  model: opus\n  context:\n    memory-bridge\n  on SessionStart:\n    /checkin @all";
        let lines = split_lines(input).unwrap();
        let (agent, consumed) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(consumed, 6);
        assert_eq!(agent.context_refs.len(), 1);
        assert_eq!(agent.context_refs[0].name, "memory-bridge");
        assert_eq!(agent.hooks.len(), 1);
        assert_eq!(agent.hooks[0].event.value, "SessionStart");
    }

    #[test]
    fn parse_agent_context_has_correct_spans() {
        let input = "agent ops:\n  context:\n    active-tasks";
        let lines = split_lines(input).unwrap();
        let (agent, _) = parse_agent_block(&lines, 0).unwrap();
        assert_eq!(agent.context_refs.len(), 1);
        let ctx = &agent.context_refs[0];
        assert_eq!(ctx.name, "active-tasks");
        assert!(ctx.span.start > 0);
        assert!(ctx.span.end > ctx.span.start);
        assert_eq!(ctx.span.line, 3);
    }

    #[test]
    fn agent_without_context_has_empty_context_refs() {
        let input = "agent ops:\n  model: opus";
        let lines = split_lines(input).unwrap();
        let (agent, _) = parse_agent_block(&lines, 0).unwrap();
        assert!(agent.context_refs.is_empty());
    }
}
