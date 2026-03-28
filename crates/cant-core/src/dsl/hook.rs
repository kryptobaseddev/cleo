//! Hook block parser for the CANT DSL.
//!
//! Parses `on EventName:` blocks and validates event names against the
//! 16 CAAMP canonical events.
//!
//! ```cant
//! on SessionStart:
//!   /checkin @all
//!   let status = task.status
//! ```

use super::ast::{HookDef, Spanned, is_canonical_event};
use super::error::ParseError;
use super::indent::{IndentedLine, collect_block};
use super::span::Span;
use super::statement::parse_statement_block;

/// Parses an `on EventName:` block starting at the given line index.
///
/// Validates that the event name is one of the 16 CAAMP canonical events.
/// Returns the parsed [`HookDef`] and the number of lines consumed.
pub fn parse_hook_block(
    lines: &[IndentedLine<'_>],
    start_idx: usize,
) -> Result<(HookDef, usize), ParseError> {
    let header = &lines[start_idx];
    let content = header.content;
    let base_offset = header.byte_offset + header.indent;
    let header_span = Span::new(
        base_offset,
        base_offset + content.len(),
        header.line_number,
        (header.indent as u32) + 1,
    );

    // Extract event name from "on EventName:"
    let after_on = content
        .strip_prefix("on ")
        .ok_or_else(|| ParseError::error("expected `on EventName:`", header_span))?;

    let event_name = after_on
        .strip_suffix(':')
        .ok_or_else(|| {
            ParseError::error(
                "expected colon after event name, e.g. `on SessionStart:`",
                header_span,
            )
        })?
        .trim();

    if event_name.is_empty() {
        return Err(ParseError::error("empty event name", header_span));
    }

    // Validate canonical event
    if !is_canonical_event(event_name) {
        return Err(ParseError::error(
            format!(
                "unknown event '{event_name}'; must be a canonical event \
                 (e.g. SessionStart, TaskCompleted, PreToolUse)"
            ),
            header_span,
        ));
    }

    let event_offset = base_offset + "on ".len();
    let event_spanned = Spanned {
        value: event_name.to_string(),
        span: Span::new(
            event_offset,
            event_offset + event_name.len(),
            header.line_number,
            (header.indent as u32) + 1 + "on ".len() as u32,
        ),
    };

    // Collect the indented body block
    let body_lines = collect_block(lines, start_idx + 1, header.indent);
    let total_consumed = 1 + body_lines.len();

    // Use the shared statement block parser which handles multi-line constructs
    // like session statements with property blocks.
    let body = parse_statement_block(body_lines)?;

    // Calculate full span
    let end_offset = if body_lines.is_empty() {
        base_offset + content.len()
    } else {
        let last = &body_lines[body_lines.len() - 1];
        last.byte_offset + last.indent + last.content.len()
    };

    let hook = HookDef {
        event: event_spanned,
        body,
        span: Span::new(
            base_offset,
            end_offset,
            header.line_number,
            (header.indent as u32) + 1,
        ),
    };

    Ok((hook, total_consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::ast::Statement;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_simple_hook() {
        let input = "on SessionStart:\n  /checkin @all";
        let lines = split_lines(input).unwrap();
        let (hook, consumed) = parse_hook_block(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
        assert_eq!(hook.event.value, "SessionStart");
        assert_eq!(hook.body.len(), 1);
        match &hook.body[0] {
            Statement::Directive(d) => {
                assert_eq!(d.verb, "checkin");
                assert_eq!(d.addresses, vec!["all"]);
            }
            other => panic!("expected Directive, got {:?}", other),
        }
    }

    #[test]
    fn parse_hook_with_multiple_statements() {
        let input = "on ResponseComplete:\n  let status = task.status\n  /done T1234 #shipped";
        let lines = split_lines(input).unwrap();
        let (hook, consumed) = parse_hook_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        assert_eq!(hook.body.len(), 2);
        match &hook.body[0] {
            Statement::Binding(b) => assert_eq!(b.name.value, "status"),
            other => panic!("expected Binding, got {:?}", other),
        }
        match &hook.body[1] {
            Statement::Directive(d) => {
                assert_eq!(d.verb, "done");
                assert_eq!(d.task_refs, vec!["T1234"]);
                assert_eq!(d.tags, vec!["shipped"]);
            }
            other => panic!("expected Directive, got {:?}", other),
        }
    }

    #[test]
    fn reject_unknown_event() {
        let input = "on TaskComplete:\n  /done T1234";
        let lines = split_lines(input).unwrap();
        let err = parse_hook_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("unknown event"));
        assert!(err.message.contains("TaskComplete"));
    }

    #[test]
    fn all_canonical_events_accepted() {
        let events = [
            "SessionStart",
            "SessionEnd",
            "PromptSubmit",
            "ResponseComplete",
            "PreToolUse",
            "PostToolUse",
            "PostToolUseFailure",
            "PermissionRequest",
            "SubagentStart",
            "SubagentStop",
            "PreModel",
            "PostModel",
            "PreCompact",
            "PostCompact",
            "Notification",
            "ConfigChange",
        ];

        for event in events {
            let input = format!("on {event}:\n  /ack");
            let lines = split_lines(&input).unwrap();
            let result = parse_hook_block(&lines, 0);
            assert!(result.is_ok(), "event '{event}' should be accepted");
        }
    }

    #[test]
    fn missing_on_keyword() {
        let input = "hook SessionStart:\n  /checkin";
        let lines = split_lines(input).unwrap();
        let err = parse_hook_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("on EventName:"));
    }

    #[test]
    fn missing_colon_after_event() {
        let input = "on SessionStart\n  /checkin";
        let lines = split_lines(input).unwrap();
        let err = parse_hook_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("colon"));
    }

    #[test]
    fn empty_event_name() {
        let input = "on :\n  /checkin";
        let lines = split_lines(input).unwrap();
        let err = parse_hook_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty event name"));
    }

    #[test]
    fn hook_with_comment() {
        let input = "on PreToolUse:\n  # check permissions first\n  /review @ops";
        let lines = split_lines(input).unwrap();
        let (hook, consumed) = parse_hook_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        assert_eq!(hook.body.len(), 2);
        match &hook.body[0] {
            Statement::Comment(c) => assert_eq!(c.text, "check permissions first"),
            other => panic!("expected Comment, got {:?}", other),
        }
    }

    #[test]
    fn hook_empty_body() {
        let input = "on ConfigChange:";
        let lines = split_lines(input).unwrap();
        let (hook, consumed) = parse_hook_block(&lines, 0).unwrap();
        assert_eq!(consumed, 1);
        assert!(hook.body.is_empty());
    }

    #[test]
    fn directive_with_argument() {
        let input = "on SessionEnd:\n  /done T1234 deployment complete";
        let lines = split_lines(input).unwrap();
        let (hook, _) = parse_hook_block(&lines, 0).unwrap();
        match &hook.body[0] {
            Statement::Directive(d) => {
                assert_eq!(d.verb, "done");
                assert_eq!(d.task_refs, vec!["T1234"]);
                assert_eq!(d.argument, Some("deployment complete".to_string()));
            }
            other => panic!("expected Directive, got {:?}", other),
        }
    }

    #[test]
    fn hook_with_session_statement() {
        let input = "on SessionStart:\n  /checkin @all\n  session \"Load canon state\"\n    context: memory-bridge";
        let lines = split_lines(input).unwrap();
        let (hook, consumed) = parse_hook_block(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        assert_eq!(hook.event.value, "SessionStart");
        assert_eq!(hook.body.len(), 2);
        match &hook.body[0] {
            Statement::Directive(d) => assert_eq!(d.verb, "checkin"),
            other => panic!("expected Directive, got {:?}", other),
        }
        match &hook.body[1] {
            Statement::Session(s) => {
                use crate::dsl::ast::SessionTarget;
                match &s.target {
                    SessionTarget::Prompt(p) => assert_eq!(p, "Load canon state"),
                    other => panic!("expected Prompt, got {:?}", other),
                }
                assert_eq!(s.properties.len(), 1);
                assert_eq!(s.properties[0].key.value, "context");
            }
            other => panic!("expected Session, got {:?}", other),
        }
    }

    #[test]
    fn hook_with_bare_session() {
        let input = "on SessionStart:\n  session \"Quick check\"";
        let lines = split_lines(input).unwrap();
        let (hook, consumed) = parse_hook_block(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
        assert_eq!(hook.body.len(), 1);
        match &hook.body[0] {
            Statement::Session(_) => {}
            other => panic!("expected Session, got {:?}", other),
        }
    }
}
