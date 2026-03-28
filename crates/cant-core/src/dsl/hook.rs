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

use super::ast::{
    Comment, DirectiveStmt, HookDef, LetBinding, Spanned, Statement, is_canonical_event,
};
use super::error::ParseError;
use super::expression::parse_expression;
use super::indent::{IndentedLine, collect_block};
use super::property::parse_property;
use super::span::Span;

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

    let mut body = Vec::new();

    for line in body_lines {
        if line.is_blank() {
            continue;
        }

        let stmt = parse_statement(line)?;
        body.push(stmt);
    }

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

/// Parses a single statement line within a hook body.
fn parse_statement(line: &IndentedLine<'_>) -> Result<Statement, ParseError> {
    let content = line.content;
    let base_offset = line.byte_offset + line.indent;
    let col = (line.indent as u32) + 1;

    // Comment
    if content.starts_with('#') {
        return Ok(Statement::Comment(Comment {
            text: content[1..].trim().to_string(),
            span: Span::new(
                base_offset,
                base_offset + content.len(),
                line.line_number,
                col,
            ),
        }));
    }

    // Directive: /verb ...
    if content.starts_with('/') {
        return parse_directive_stmt(line);
    }

    // Let/const binding: let name = expr
    if content.starts_with("let ") || content.starts_with("const ") {
        return parse_binding_stmt(line);
    }

    // Property: key: value (if it contains a colon that's not inside quotes)
    if contains_property_colon(content) {
        let prop = parse_property(line)?;
        return Ok(Statement::Property(prop));
    }

    // Bare expression
    let expr = parse_expression(content, base_offset, line.line_number, col)?;
    Ok(Statement::Expression(expr))
}

/// Parses a `/verb @addr T1234 #tag argument` directive statement.
fn parse_directive_stmt(line: &IndentedLine<'_>) -> Result<Statement, ParseError> {
    let content = line.content;
    let base_offset = line.byte_offset + line.indent;
    let span = Span::new(
        base_offset,
        base_offset + content.len(),
        line.line_number,
        (line.indent as u32) + 1,
    );

    let parts: Vec<&str> = content.split_whitespace().collect();
    if parts.is_empty() {
        return Err(ParseError::error("empty directive", span));
    }

    let verb = parts[0][1..].to_string(); // strip leading /
    let mut addresses = Vec::new();
    let mut task_refs = Vec::new();
    let mut tags = Vec::new();
    let mut argument_parts = Vec::new();

    for part in &parts[1..] {
        if part.starts_with('@') && part.len() > 1 {
            addresses.push(part[1..].to_string());
        } else if part.starts_with('T')
            && part.len() > 1
            && part[1..].chars().all(|c| c.is_ascii_digit())
        {
            task_refs.push(part.to_string());
        } else if part.starts_with('#') && part.len() > 1 {
            tags.push(part[1..].to_string());
        } else {
            argument_parts.push(*part);
        }
    }

    let argument = if argument_parts.is_empty() {
        None
    } else {
        Some(argument_parts.join(" "))
    };

    Ok(Statement::Directive(DirectiveStmt {
        verb,
        addresses,
        task_refs,
        tags,
        argument,
        span,
    }))
}

/// Parses a `let name = expression` or `const name = expression` binding statement.
fn parse_binding_stmt(line: &IndentedLine<'_>) -> Result<Statement, ParseError> {
    let content = line.content;
    let base_offset = line.byte_offset + line.indent;
    let col = (line.indent as u32) + 1;
    let stmt_span = Span::new(
        base_offset,
        base_offset + content.len(),
        line.line_number,
        col,
    );

    // Determine if let or const
    let (keyword_len, after_kw) = if content.starts_with("let ") {
        (4, &content[4..])
    } else if content.starts_with("const ") {
        (6, &content[6..])
    } else {
        return Err(ParseError::error(
            "expected `let` or `const` keyword",
            stmt_span,
        ));
    };

    let eq_pos = after_kw.find('=').ok_or_else(|| {
        ParseError::error(
            "expected `=` in binding, e.g. `let name = expression`",
            stmt_span,
        )
    })?;

    let name = after_kw[..eq_pos].trim();
    let expr_str = after_kw[eq_pos + 1..].trim();

    if name.is_empty() {
        return Err(ParseError::error("empty binding name", stmt_span));
    }

    let name_offset = base_offset + keyword_len;
    let name_spanned = Spanned {
        value: name.to_string(),
        span: Span::new(
            name_offset,
            name_offset + name.len(),
            line.line_number,
            col + keyword_len as u32,
        ),
    };

    let expr_offset = base_offset + keyword_len + eq_pos + 1;
    let value = parse_expression(expr_str, expr_offset, line.line_number, col)?;

    Ok(Statement::Binding(LetBinding {
        name: name_spanned,
        value,
        span: stmt_span,
    }))
}

/// Heuristic to detect if a line contains a `key: value` pattern.
///
/// Returns false if the colon is inside a quoted string or is part of `://`.
fn contains_property_colon(s: &str) -> bool {
    let mut in_quotes = false;
    let bytes = s.as_bytes();

    for i in 0..bytes.len() {
        match bytes[i] {
            b'"' => in_quotes = !in_quotes,
            b':' if !in_quotes => {
                // Skip URL-like colons (://)
                if i + 2 < bytes.len() && bytes[i + 1] == b'/' && bytes[i + 2] == b'/' {
                    continue;
                }
                return true;
            }
            _ => {}
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
