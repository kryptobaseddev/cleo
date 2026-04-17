//! Parallel block parser for the CANT DSL.
//!
//! Parses `parallel:` blocks with named arms that execute concurrently.
//!
//! ```cant
//! parallel:
//!   a = session "Task A"
//!   b = session: reviewer
//!     context: a
//!
//! parallel race:
//!   fast = session "Quick check"
//!   slow = session "Deep analysis"
//! ```

use super::ast::{ParallelArm, ParallelBlock, ParallelModifier, Statement};
use super::error::ParseError;
use super::indent::{IndentedLine, collect_block};
use super::session::parse_session_stmt;
use super::span::Span;

/// Parses a `parallel:` block starting at the given line index.
///
/// Returns the parsed [`ParallelBlock`] wrapped in a [`Statement::Parallel`] and
/// the number of lines consumed.
///
/// # Errors
///
/// Returns [`ParseError`] if the parallel block header or any arm body is malformed.
pub fn parse_parallel_block(
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

    // Parse "parallel [modifier]:"
    let after_parallel = content
        .strip_prefix("parallel")
        .ok_or_else(|| ParseError::error("expected `parallel:` block", header_span))?;

    let (modifier, after_mod) = if let Some(rest) = after_parallel.strip_prefix(" race") {
        (Some(ParallelModifier::Race), rest)
    } else if let Some(rest) = after_parallel.strip_prefix(" settle") {
        (Some(ParallelModifier::Settle), rest)
    } else {
        (None, after_parallel)
    };

    if after_mod != ":" {
        return Err(ParseError::error(
            "expected `:` after `parallel` keyword, e.g. `parallel:` or `parallel race:`",
            header_span,
        ));
    }

    // Collect indented body
    let body_lines = collect_block(lines, start_idx + 1, header.indent);
    let total_consumed = 1 + body_lines.len();

    if body_lines.is_empty() {
        return Err(ParseError::error(
            "parallel block must contain at least one arm",
            header_span,
        ));
    }

    let mut arms = Vec::new();
    let mut i = 0;

    while i < body_lines.len() {
        let line = &body_lines[i];

        if line.is_blank() || line.is_comment() {
            i += 1;
            continue;
        }

        let arm_content = line.content;
        let arm_offset = line.byte_offset + line.indent;
        let arm_col = (line.indent as u32) + 1;
        let arm_span = Span::new(
            arm_offset,
            arm_offset + arm_content.len(),
            line.line_number,
            arm_col,
        );

        // Parse "name = session ..." or "name = expression"
        let eq_pos = arm_content.find(" = ").ok_or_else(|| {
            ParseError::error(
                "parallel arm must be `name = session ...` or `name = expression`",
                arm_span,
            )
        })?;

        let arm_name = arm_content[..eq_pos].trim().to_string();
        let arm_value_str = arm_content[eq_pos + 3..].trim();

        if arm_name.is_empty() {
            return Err(ParseError::error("empty parallel arm name", arm_span));
        }

        // Check if the arm value is a session statement
        if arm_value_str.starts_with("session") {
            // Reconstruct as a standalone session line for the session parser
            let session_line = IndentedLine {
                content: arm_value_str,
                indent: line.indent,
                line_number: line.line_number,
                byte_offset: line.byte_offset + eq_pos + 3 + line.indent,
            };

            // Build a mini slice with the session line and any following indented lines
            let mut session_lines = vec![session_line];
            let mut j = i + 1;
            while j < body_lines.len() {
                let next = &body_lines[j];
                if next.is_blank() {
                    j += 1;
                    continue;
                }
                if next.indent <= line.indent {
                    break;
                }
                session_lines.push(IndentedLine {
                    content: next.content,
                    indent: next.indent,
                    line_number: next.line_number,
                    byte_offset: next.byte_offset,
                });
                j += 1;
            }

            let (stmt, session_consumed) = parse_session_stmt(&session_lines, 0)?;

            let arm_end = if session_consumed > 1 {
                let last = &session_lines[session_consumed - 1];
                last.byte_offset + last.indent + last.content.len()
            } else {
                arm_offset + arm_content.len()
            };

            arms.push(ParallelArm {
                name: arm_name,
                body: Box::new(stmt),
                span: Span::new(arm_offset, arm_end, line.line_number, arm_col),
            });

            // Advance past all consumed lines (the arm line + any property lines)
            i += session_consumed;
        } else {
            // Bare expression arm
            let expr = super::expression::parse_expression(
                arm_value_str,
                arm_offset + eq_pos + 3,
                line.line_number,
                arm_col,
            )?;

            arms.push(ParallelArm {
                name: arm_name,
                body: Box::new(Statement::Expression(expr)),
                span: arm_span,
            });
            i += 1;
        }
    }

    if arms.is_empty() {
        return Err(ParseError::error(
            "parallel block must contain at least one arm",
            header_span,
        ));
    }

    let end_offset = if body_lines.is_empty() {
        base_offset + content.len()
    } else {
        let last = &body_lines[body_lines.len() - 1];
        last.byte_offset + last.indent + last.content.len()
    };

    let block = ParallelBlock {
        modifier,
        arms,
        span: Span::new(base_offset, end_offset, header.line_number, col),
    };

    Ok((Statement::Parallel(block), total_consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::ast::SessionTarget;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_simple_parallel() {
        let input = "parallel:\n  a = session \"Task A\"\n  b = session \"Task B\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_parallel_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        match stmt {
            Statement::Parallel(p) => {
                assert!(p.modifier.is_none());
                assert_eq!(p.arms.len(), 2);
                assert_eq!(p.arms[0].name, "a");
                assert_eq!(p.arms[1].name, "b");
            }
            other => panic!("expected Parallel, got {other:?}"),
        }
    }

    #[test]
    fn parse_parallel_race() {
        let input = "parallel race:\n  a = session \"Fast\"\n  b = session \"Slow\"";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_parallel_block(&lines, 0).unwrap();
        match stmt {
            Statement::Parallel(p) => {
                assert_eq!(p.modifier, Some(ParallelModifier::Race));
            }
            other => panic!("expected Parallel, got {other:?}"),
        }
    }

    #[test]
    fn parse_parallel_settle() {
        let input = "parallel settle:\n  a = session \"Check A\"\n  b = session \"Check B\"";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_parallel_block(&lines, 0).unwrap();
        match stmt {
            Statement::Parallel(p) => {
                assert_eq!(p.modifier, Some(ParallelModifier::Settle));
            }
            other => panic!("expected Parallel, got {other:?}"),
        }
    }

    #[test]
    fn parse_parallel_with_agent_sessions() {
        let input = "parallel:\n  a = session: scanner\n  b = session: reviewer";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_parallel_block(&lines, 0).unwrap();
        match stmt {
            Statement::Parallel(p) => {
                assert_eq!(p.arms.len(), 2);
                match &*p.arms[0].body {
                    Statement::Session(s) => match &s.target {
                        SessionTarget::Agent(name) => assert_eq!(name, "scanner"),
                        other => panic!("expected Agent, got {other:?}"),
                    },
                    other => panic!("expected Session, got {other:?}"),
                }
            }
            other => panic!("expected Parallel, got {other:?}"),
        }
    }

    #[test]
    fn parse_parallel_with_expression_arm() {
        let input = "parallel:\n  a = session \"Task\"\n  b = result";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_parallel_block(&lines, 0).unwrap();
        match stmt {
            Statement::Parallel(p) => {
                assert_eq!(p.arms.len(), 2);
                match &*p.arms[1].body {
                    Statement::Expression(_) => {}
                    other => panic!("expected Expression, got {other:?}"),
                }
            }
            other => panic!("expected Parallel, got {other:?}"),
        }
    }

    #[test]
    fn reject_empty_parallel() {
        let input = "parallel:";
        let lines = split_lines(input).unwrap();
        let err = parse_parallel_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("at least one arm"));
    }

    #[test]
    fn reject_missing_colon() {
        let input = "parallel\n  a = session \"Task\"";
        let lines = split_lines(input).unwrap();
        let err = parse_parallel_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("`:`"));
    }

    #[test]
    fn reject_invalid_modifier() {
        let input = "parallel foo:\n  a = session \"Task\"";
        let lines = split_lines(input).unwrap();
        let err = parse_parallel_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("`:`"));
    }

    #[test]
    fn reject_missing_equals_in_arm() {
        let input = "parallel:\n  session \"Task\"";
        let lines = split_lines(input).unwrap();
        let err = parse_parallel_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("name ="));
    }

    #[test]
    fn parse_parallel_skips_blank_lines() {
        let input = "parallel:\n  a = session \"A\"\n\n  b = session \"B\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_parallel_block(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match stmt {
            Statement::Parallel(p) => assert_eq!(p.arms.len(), 2),
            other => panic!("expected Parallel, got {other:?}"),
        }
    }

    #[test]
    fn parse_parallel_arm_with_session_properties() {
        let input =
            "parallel:\n  a = session \"Task A\"\n    context: checks\n  b = session \"Task B\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_parallel_block(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match stmt {
            Statement::Parallel(p) => {
                assert_eq!(p.arms.len(), 2);
                match &*p.arms[0].body {
                    Statement::Session(s) => {
                        assert_eq!(s.properties.len(), 1);
                        assert_eq!(s.properties[0].key.value, "context");
                    }
                    other => panic!("expected Session, got {other:?}"),
                }
            }
            other => panic!("expected Parallel, got {other:?}"),
        }
    }

    #[test]
    fn reject_empty_arm_name() {
        let input = "parallel:\n  = session \"Task\"";
        let lines = split_lines(input).unwrap();
        // This will fail due to empty arm name
        let result = parse_parallel_block(&lines, 0);
        assert!(result.is_err());
    }

    #[test]
    fn span_covers_full_block() {
        let input = "parallel:\n  a = session \"A\"";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_parallel_block(&lines, 0).unwrap();
        match stmt {
            Statement::Parallel(p) => {
                assert_eq!(p.span.start, 0);
                assert_eq!(p.span.line, 1);
            }
            other => panic!("expected Parallel, got {other:?}"),
        }
    }
}
