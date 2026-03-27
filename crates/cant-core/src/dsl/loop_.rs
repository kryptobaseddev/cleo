//! Loop construct parsers for the CANT DSL.
//!
//! Parses three loop forms:
//! - `repeat N:` — fixed count loop
//! - `for name in collection:` — iteration loop
//! - `loop: ... until condition` — unbounded loop with termination condition
//!
//! ```cant
//! repeat 3:
//!   session "Retry the operation"
//!
//! for item in tasks:
//!   session "Process ${item}"
//!
//! loop:
//!   session "Check status"
//!   until **deployment is stable**
//! ```

use super::ast::{ForLoop, LoopUntil, RepeatLoop, Spanned, Statement};
use super::conditional::parse_condition;
use super::error::ParseError;
use super::expression::parse_expression;
use super::indent::{IndentedLine, collect_block};
use super::span::Span;
use super::statement::parse_statement_block;

/// Parses a `repeat N:` loop starting at the given line index.
///
/// Returns the parsed [`RepeatLoop`] wrapped in a [`Statement::Repeat`]
/// and the number of lines consumed.
pub fn parse_repeat(
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

    let after_repeat = content
        .strip_prefix("repeat ")
        .ok_or_else(|| ParseError::error("expected `repeat N:`", header_span))?;

    let count_str = after_repeat
        .strip_suffix(':')
        .ok_or_else(|| {
            ParseError::error(
                "expected `:` after repeat count, e.g. `repeat 3:`",
                header_span,
            )
        })?
        .trim();

    if count_str.is_empty() {
        return Err(ParseError::error(
            "expected count expression after `repeat`",
            header_span,
        ));
    }

    let count_offset = base_offset + "repeat ".len();
    let count = parse_expression(count_str, count_offset, header.line_number, col + 7)?;

    let body_lines = collect_block(lines, start_idx + 1, header.indent);
    let body = parse_statement_block(body_lines)?;
    let total_consumed = 1 + body_lines.len();

    let end_offset = if body_lines.is_empty() {
        base_offset + content.len()
    } else {
        let last = &body_lines[body_lines.len() - 1];
        last.byte_offset + last.indent + last.content.len()
    };

    let repeat = RepeatLoop {
        count,
        body,
        span: Span::new(base_offset, end_offset, header.line_number, col),
    };

    Ok((Statement::Repeat(repeat), total_consumed))
}

/// Parses a `for name in collection:` loop starting at the given line index.
///
/// Returns the parsed [`ForLoop`] wrapped in a [`Statement::ForLoop`]
/// and the number of lines consumed.
pub fn parse_for_loop(
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

    let after_for = content
        .strip_prefix("for ")
        .ok_or_else(|| ParseError::error("expected `for name in collection:`", header_span))?;

    let after_for_trimmed = after_for.strip_suffix(':').ok_or_else(|| {
        ParseError::error(
            "expected `:` at end of for loop, e.g. `for item in tasks:`",
            header_span,
        )
    })?;

    // Find " in " keyword
    let in_pos = after_for_trimmed.find(" in ").ok_or_else(|| {
        ParseError::error(
            "expected `in` keyword in for loop, e.g. `for item in collection:`",
            header_span,
        )
    })?;

    let var_name = after_for_trimmed[..in_pos].trim();
    let iter_str = after_for_trimmed[in_pos + 4..].trim();

    if var_name.is_empty() {
        return Err(ParseError::error(
            "empty variable name in for loop",
            header_span,
        ));
    }

    if iter_str.is_empty() {
        return Err(ParseError::error(
            "empty iterable expression in for loop",
            header_span,
        ));
    }

    let var_offset = base_offset + "for ".len();
    let variable = Spanned {
        value: var_name.to_string(),
        span: Span::new(
            var_offset,
            var_offset + var_name.len(),
            header.line_number,
            col + 4,
        ),
    };

    let iter_offset = base_offset + "for ".len() + in_pos + 4;
    let iterable = parse_expression(iter_str, iter_offset, header.line_number, col)?;

    let body_lines = collect_block(lines, start_idx + 1, header.indent);
    let body = parse_statement_block(body_lines)?;
    let total_consumed = 1 + body_lines.len();

    let end_offset = if body_lines.is_empty() {
        base_offset + content.len()
    } else {
        let last = &body_lines[body_lines.len() - 1];
        last.byte_offset + last.indent + last.content.len()
    };

    let for_loop = ForLoop {
        variable,
        iterable,
        body,
        span: Span::new(base_offset, end_offset, header.line_number, col),
    };

    Ok((Statement::ForLoop(for_loop), total_consumed))
}

/// Parses a `loop: ... until condition` loop starting at the given line index.
///
/// The `until` line must appear as the LAST non-blank line in the loop body
/// at the same indent level as other body statements.
///
/// Returns the parsed [`LoopUntil`] wrapped in a [`Statement::LoopUntil`]
/// and the number of lines consumed.
pub fn parse_loop_until(
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

    if content != "loop:" {
        return Err(ParseError::error("expected `loop:`", header_span));
    }

    let body_lines = collect_block(lines, start_idx + 1, header.indent);
    let total_consumed = 1 + body_lines.len();

    if body_lines.is_empty() {
        return Err(ParseError::error(
            "loop block must contain body statements and an `until` condition",
            header_span,
        ));
    }

    // Find the last non-blank line — it must be the `until` line
    let mut until_idx = None;
    for (i, line) in body_lines.iter().enumerate().rev() {
        if !line.is_blank() {
            if line.content.starts_with("until ") || line.content == "until" {
                until_idx = Some(i);
            }
            break;
        }
    }

    let until_idx = until_idx.ok_or_else(|| {
        ParseError::error("loop block must end with `until condition`", header_span)
    })?;

    let until_line = &body_lines[until_idx];
    let until_content = until_line.content;
    let until_offset = until_line.byte_offset + until_line.indent;
    let until_col = (until_line.indent as u32) + 1;

    let cond_str = until_content
        .strip_prefix("until ")
        .unwrap_or_else(|| &until_content["until".len()..])
        .trim();

    if cond_str.is_empty() {
        return Err(ParseError::error(
            "empty condition after `until`",
            Span::new(
                until_offset,
                until_offset + until_content.len(),
                until_line.line_number,
                until_col,
            ),
        ));
    }

    let cond_offset = until_offset + "until ".len();
    let condition = parse_condition(cond_str, cond_offset, until_line.line_number, until_col + 6)?;

    // Parse body statements (everything before the until line)
    let body_stmts = parse_statement_block(&body_lines[..until_idx])?;

    let end_offset = until_offset + until_content.len();

    let loop_until = LoopUntil {
        body: body_stmts,
        condition,
        span: Span::new(base_offset, end_offset, header.line_number, col),
    };

    Ok((Statement::LoopUntil(loop_until), total_consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::ast::Condition;
    use crate::dsl::indent::split_lines;

    // ── repeat tests ────────────────────────────────────────────────

    #[test]
    fn parse_simple_repeat() {
        let input = "repeat 3:\n  /info @all \"retry\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_repeat(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
        match stmt {
            Statement::Repeat(r) => {
                assert_eq!(r.body.len(), 1);
            }
            other => panic!("expected Repeat, got {:?}", other),
        }
    }

    #[test]
    fn parse_repeat_with_expression() {
        let input = "repeat count:\n  /done T1";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_repeat(&lines, 0).unwrap();
        match stmt {
            Statement::Repeat(_) => {}
            other => panic!("expected Repeat, got {:?}", other),
        }
    }

    #[test]
    fn parse_repeat_multi_body() {
        let input = "repeat 2:\n  let x = 1\n  /done T1234";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_repeat(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        match stmt {
            Statement::Repeat(r) => assert_eq!(r.body.len(), 2),
            other => panic!("expected Repeat, got {:?}", other),
        }
    }

    #[test]
    fn reject_repeat_missing_colon() {
        let input = "repeat 3\n  /done T1";
        let lines = split_lines(input).unwrap();
        let err = parse_repeat(&lines, 0).unwrap_err();
        assert!(err.message.contains("`:`"));
    }

    #[test]
    fn reject_repeat_empty_count() {
        let input = "repeat :";
        let lines = split_lines(input).unwrap();
        let err = parse_repeat(&lines, 0).unwrap_err();
        assert!(err.message.contains("count expression"));
    }

    // ── for loop tests ──────────────────────────────────────────────

    #[test]
    fn parse_simple_for() {
        let input = "for item in tasks:\n  /done item";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_for_loop(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
        match stmt {
            Statement::ForLoop(f) => {
                assert_eq!(f.variable.value, "item");
                assert_eq!(f.body.len(), 1);
            }
            other => panic!("expected ForLoop, got {:?}", other),
        }
    }

    #[test]
    fn parse_for_with_property_access() {
        let input = "for task in project.tasks:\n  /info @all task";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_for_loop(&lines, 0).unwrap();
        match stmt {
            Statement::ForLoop(f) => assert_eq!(f.variable.value, "task"),
            other => panic!("expected ForLoop, got {:?}", other),
        }
    }

    #[test]
    fn reject_for_missing_in() {
        let input = "for item tasks:\n  /done T1";
        let lines = split_lines(input).unwrap();
        let err = parse_for_loop(&lines, 0).unwrap_err();
        assert!(err.message.contains("`in`"));
    }

    #[test]
    fn reject_for_empty_variable() {
        let input = "for  in tasks:\n  /done T1";
        let lines = split_lines(input).unwrap();
        let err = parse_for_loop(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty variable"));
    }

    #[test]
    fn reject_for_empty_iterable() {
        let input = "for item in :\n  /done T1";
        let lines = split_lines(input).unwrap();
        let err = parse_for_loop(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty iterable"));
    }

    #[test]
    fn reject_for_missing_colon() {
        let input = "for item in tasks\n  /done T1";
        let lines = split_lines(input).unwrap();
        let err = parse_for_loop(&lines, 0).unwrap_err();
        assert!(err.message.contains("`:`"));
    }

    // ── loop until tests ────────────────────────────────────────────

    #[test]
    fn parse_simple_loop_until() {
        let input = "loop:\n  /info @all \"checking\"\n  until status == \"done\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_loop_until(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        match stmt {
            Statement::LoopUntil(lu) => {
                assert_eq!(lu.body.len(), 1);
                match &lu.condition {
                    Condition::Expression(_) => {}
                    other => panic!("expected Expression condition, got {:?}", other),
                }
            }
            other => panic!("expected LoopUntil, got {:?}", other),
        }
    }

    #[test]
    fn parse_loop_until_with_discretion() {
        let input = "loop:\n  /info @all \"checking\"\n  until **deployment is stable**";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_loop_until(&lines, 0).unwrap();
        match stmt {
            Statement::LoopUntil(lu) => match &lu.condition {
                Condition::Discretion(dc) => assert_eq!(dc.prose, "deployment is stable"),
                other => panic!("expected Discretion condition, got {:?}", other),
            },
            other => panic!("expected LoopUntil, got {:?}", other),
        }
    }

    #[test]
    fn parse_loop_until_multi_body() {
        let input = "loop:\n  let x = 1\n  /info @all \"check\"\n  until x == 10";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_loop_until(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match stmt {
            Statement::LoopUntil(lu) => assert_eq!(lu.body.len(), 2),
            other => panic!("expected LoopUntil, got {:?}", other),
        }
    }

    #[test]
    fn reject_loop_without_until() {
        let input = "loop:\n  /info @all \"forever\"";
        let lines = split_lines(input).unwrap();
        let err = parse_loop_until(&lines, 0).unwrap_err();
        assert!(err.message.contains("until"));
    }

    #[test]
    fn reject_empty_loop() {
        let input = "loop:";
        let lines = split_lines(input).unwrap();
        let err = parse_loop_until(&lines, 0).unwrap_err();
        assert!(err.message.contains("body statements"));
    }

    #[test]
    fn reject_loop_empty_condition() {
        let input = "loop:\n  /info @all \"check\"\n  until ";
        let lines = split_lines(input).unwrap();
        let err = parse_loop_until(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty condition"));
    }

    #[test]
    fn span_covers_repeat() {
        let input = "repeat 5:\n  /done T1";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_repeat(&lines, 0).unwrap();
        match stmt {
            Statement::Repeat(r) => {
                assert_eq!(r.span.start, 0);
                assert_eq!(r.span.line, 1);
            }
            other => panic!("expected Repeat, got {:?}", other),
        }
    }

    #[test]
    fn span_covers_for_loop() {
        let input = "for x in items:\n  /done x";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_for_loop(&lines, 0).unwrap();
        match stmt {
            Statement::ForLoop(f) => {
                assert_eq!(f.span.start, 0);
                assert_eq!(f.span.line, 1);
            }
            other => panic!("expected ForLoop, got {:?}", other),
        }
    }
}
