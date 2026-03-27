//! Session expression parser for the CANT DSL.
//!
//! Parses session invocations which are the ONLY place prose enters a workflow.
//!
//! Two forms:
//! - `session "prompt text"` — inline session with a prompt string
//! - `session: agent-name` — agent-based session
//!
//! Both may have an optional indented properties block:
//! ```cant
//! session "Analyze the code"
//!   context: [active-tasks]
//!   model: opus
//!
//! session: scanner
//!   prompt: "Run security analysis"
//! ```

use super::ast::{Property, SessionExpr, SessionTarget, Statement};
use super::error::ParseError;
use super::indent::{IndentedLine, collect_block};
use super::property::parse_property;
use super::span::Span;

/// Parses a session statement starting at the given line index.
///
/// Returns the parsed [`SessionExpr`] wrapped in a [`Statement::Session`] and the
/// number of lines consumed.
pub fn parse_session_stmt(
    lines: &[IndentedLine<'_>],
    start_idx: usize,
) -> Result<(Statement, usize), ParseError> {
    let header = &lines[start_idx];
    let content = header.content;
    let base_offset = header.byte_offset + header.indent;
    let col = (header.indent as u32) + 1;
    let header_span = Span::new(
        base_offset,
        base_offset + content.len(),
        header.line_number,
        col,
    );

    let after_session = content
        .strip_prefix("session")
        .ok_or_else(|| ParseError::error("expected `session` keyword", header_span))?;

    let target = if after_session.starts_with(": ") || after_session == ":" {
        // Agent-based session: `session: agent-name`
        let agent_name = after_session.strip_prefix(':').unwrap_or("").trim();
        if agent_name.is_empty() {
            return Err(ParseError::error(
                "expected agent name after `session:`, e.g. `session: scanner`",
                header_span,
            ));
        }
        SessionTarget::Agent(agent_name.to_string())
    } else if after_session.starts_with(' ') {
        // Inline session: `session "prompt text"`
        let prompt_str = after_session.trim();
        if prompt_str.is_empty() {
            return Err(ParseError::error(
                "expected prompt string or `: agent-name` after `session`",
                header_span,
            ));
        }
        // Strip surrounding quotes if present
        let prompt =
            if prompt_str.starts_with('"') && prompt_str.ends_with('"') && prompt_str.len() >= 2 {
                prompt_str[1..prompt_str.len() - 1].to_string()
            } else {
                prompt_str.to_string()
            };
        SessionTarget::Prompt(prompt)
    } else {
        return Err(ParseError::error(
            "expected prompt string or `: agent-name` after `session`",
            header_span,
        ));
    };

    // Collect optional properties block
    let prop_lines = collect_block(lines, start_idx + 1, header.indent);
    let total_consumed = 1 + prop_lines.len();

    let mut properties: Vec<Property> = Vec::new();
    for line in prop_lines {
        if line.is_blank() || line.is_comment() {
            continue;
        }
        let prop = parse_property(line)?;
        properties.push(prop);
    }

    let end_offset = if prop_lines.is_empty() {
        base_offset + content.len()
    } else {
        let last = &prop_lines[prop_lines.len() - 1];
        last.byte_offset + last.indent + last.content.len()
    };

    let session = SessionExpr {
        target,
        properties,
        span: Span::new(base_offset, end_offset, header.line_number, col),
    };

    Ok((Statement::Session(session), total_consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_inline_session() {
        let input = "session \"Analyze the code\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_session_stmt(&lines, 0).unwrap();
        assert_eq!(consumed, 1);
        match stmt {
            Statement::Session(s) => {
                match &s.target {
                    SessionTarget::Prompt(p) => assert_eq!(p, "Analyze the code"),
                    other => panic!("expected Prompt, got {:?}", other),
                }
                assert!(s.properties.is_empty());
            }
            other => panic!("expected Session, got {:?}", other),
        }
    }

    #[test]
    fn parse_agent_session() {
        let input = "session: scanner";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_session_stmt(&lines, 0).unwrap();
        assert_eq!(consumed, 1);
        match stmt {
            Statement::Session(s) => match &s.target {
                SessionTarget::Agent(name) => assert_eq!(name, "scanner"),
                other => panic!("expected Agent, got {:?}", other),
            },
            other => panic!("expected Session, got {:?}", other),
        }
    }

    #[test]
    fn parse_session_with_properties() {
        let input = "session \"Run security check\"\n  context: active-tasks\n  model: opus";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_session_stmt(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        match stmt {
            Statement::Session(s) => {
                assert_eq!(s.properties.len(), 2);
                assert_eq!(s.properties[0].key.value, "context");
                assert_eq!(s.properties[1].key.value, "model");
            }
            other => panic!("expected Session, got {:?}", other),
        }
    }

    #[test]
    fn parse_agent_session_with_properties() {
        let input = "session: reviewer\n  prompt: \"Review the PR\"\n  context: checks";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_session_stmt(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        match stmt {
            Statement::Session(s) => {
                match &s.target {
                    SessionTarget::Agent(name) => assert_eq!(name, "reviewer"),
                    other => panic!("expected Agent, got {:?}", other),
                }
                assert_eq!(s.properties.len(), 2);
            }
            other => panic!("expected Session, got {:?}", other),
        }
    }

    #[test]
    fn reject_empty_session() {
        let input = "session";
        let lines = split_lines(input).unwrap();
        let err = parse_session_stmt(&lines, 0).unwrap_err();
        assert!(err.message.contains("expected"));
    }

    #[test]
    fn reject_empty_agent_name() {
        let input = "session: ";
        let lines = split_lines(input).unwrap();
        let err = parse_session_stmt(&lines, 0).unwrap_err();
        assert!(err.message.contains("agent name"));
    }

    #[test]
    fn parse_session_with_blank_property_lines() {
        let input = "session \"Task\"\n  model: opus\n\n  context: data";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_session_stmt(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match stmt {
            Statement::Session(s) => assert_eq!(s.properties.len(), 2),
            other => panic!("expected Session, got {:?}", other),
        }
    }

    #[test]
    fn parse_session_unquoted_prompt() {
        let input = "session analyze-code";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_session_stmt(&lines, 0).unwrap();
        match stmt {
            Statement::Session(s) => match &s.target {
                SessionTarget::Prompt(p) => assert_eq!(p, "analyze-code"),
                other => panic!("expected Prompt, got {:?}", other),
            },
            other => panic!("expected Session, got {:?}", other),
        }
    }

    #[test]
    fn parse_indented_session() {
        let input = "  session \"Inner task\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_session_stmt(&lines, 0).unwrap();
        assert_eq!(consumed, 1);
        match stmt {
            Statement::Session(s) => match &s.target {
                SessionTarget::Prompt(p) => assert_eq!(p, "Inner task"),
                other => panic!("expected Prompt, got {:?}", other),
            },
            other => panic!("expected Session, got {:?}", other),
        }
    }

    #[test]
    fn session_followed_by_non_indented_line() {
        let input = "session \"Task A\"\nsession \"Task B\"";
        let lines = split_lines(input).unwrap();
        let (_, consumed) = parse_session_stmt(&lines, 0).unwrap();
        assert_eq!(consumed, 1);
    }

    #[test]
    fn parse_session_colon_without_space() {
        // "session:" with no space should still be handled
        let input = "session:scanner";
        let lines = split_lines(input).unwrap();
        let err = parse_session_stmt(&lines, 0).unwrap_err();
        assert!(err.message.contains("expected"));
    }

    #[test]
    fn span_covers_session_with_props() {
        let input = "session \"Task\"\n  model: opus";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_session_stmt(&lines, 0).unwrap();
        match stmt {
            Statement::Session(s) => {
                assert_eq!(s.span.start, 0);
                assert!(s.span.end > 0);
                assert_eq!(s.span.line, 1);
            }
            other => panic!("expected Session, got {:?}", other),
        }
    }
}
