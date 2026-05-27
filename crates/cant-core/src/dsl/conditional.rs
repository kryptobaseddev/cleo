//! Conditional parser for the CANT DSL.
//!
//! Parses `if`/`elif`/`else` blocks with support for both regular expression
//! conditions and discretion conditions (`**prose text**`).
//!
//! ```cant
//! if **all reviews pass with no critical issues**:
//!   /done T1234
//! elif status == "partial":
//!   /info @author "Partial pass"
//! else:
//!   /action @author "Address issues"
//! ```

use super::ast::{Condition, Conditional, ElifBranch, Statement};
use super::discretion::{is_discretion, parse_discretion};
use super::error::ParseError;
use super::expression::parse_expression;
use super::indent::{IndentedLine, collect_block};
use super::span::Span;
use super::statement::parse_statement_block;

/// Parses a condition string (either discretion or expression).
///
/// # Errors
///
/// Returns [`ParseError`] if the condition is not a valid discretion or expression.
pub fn parse_condition(
    input: &str,
    byte_offset: usize,
    line: u32,
    col: u32,
) -> Result<Condition, ParseError> {
    if is_discretion(input) {
        let dc = parse_discretion(input, byte_offset, line, col)?;
        Ok(Condition::Discretion(dc))
    } else {
        let expr = parse_expression(input, byte_offset, line, col)?;
        Ok(Condition::Expression(expr))
    }
}

/// Parses an `if`/`elif`/`else` conditional starting at the given line index.
///
/// Returns the parsed [`Conditional`] wrapped in a [`Statement::Conditional`]
/// and the number of lines consumed.
///
/// # Errors
///
/// Returns [`ParseError`] if the conditional header or any branch body is malformed.
pub fn parse_conditional(
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
    let parent_indent = header.indent;

    // Parse "if condition:"
    let after_if = content
        .strip_prefix("if ")
        .ok_or_else(|| ParseError::error("expected `if condition:`", header_span))?;

    let cond_str = after_if
        .strip_suffix(':')
        .ok_or_else(|| {
            ParseError::error(
                "expected `:` after condition, e.g. `if condition:`",
                header_span,
            )
        })?
        .trim();

    if cond_str.is_empty() {
        return Err(ParseError::error("empty condition", header_span));
    }

    let cond_offset = base_offset + "if ".len();
    let condition = parse_condition(cond_str, cond_offset, header.line_number, col + 3)?;

    // Parse then body
    let then_lines = collect_block(lines, start_idx + 1, parent_indent);
    let then_body = parse_statement_block(then_lines)?;
    let mut total_consumed = 1 + then_lines.len();

    // Parse elif/else branches
    let mut elif_branches = Vec::new();
    let mut else_body = None;

    loop {
        let next_idx = start_idx + total_consumed;
        if next_idx >= lines.len() {
            break;
        }

        let next_line = &lines[next_idx];
        if next_line.is_blank() {
            // Skip blank lines between if/elif/else at the same indent level
            // but only if they're followed by elif/else
            let peek = next_idx + 1;
            if peek < lines.len() {
                let peek_line = &lines[peek];
                if peek_line.indent == parent_indent
                    && (peek_line.content.starts_with("elif ")
                        || peek_line.content.starts_with("else:"))
                {
                    total_consumed += 1;
                    continue;
                }
            }
            break;
        }

        if next_line.indent != parent_indent {
            break;
        }

        // Check for elif
        if next_line.content.starts_with("elif ") {
            let elif_content = next_line.content;
            let elif_offset = next_line.byte_offset + next_line.indent;
            let elif_col = (next_line.indent as u32) + 1;
            let elif_span = Span::new(
                elif_offset,
                elif_offset + elif_content.len(),
                next_line.line_number,
                elif_col,
            );

            let after_elif = elif_content
                .strip_prefix("elif ")
                .ok_or_else(|| ParseError::error("expected `elif condition:`", elif_span))?;

            let elif_cond_str = after_elif
                .strip_suffix(':')
                .ok_or_else(|| ParseError::error("expected `:` after elif condition", elif_span))?
                .trim();

            if elif_cond_str.is_empty() {
                return Err(ParseError::error("empty elif condition", elif_span));
            }

            let elif_cond_offset = elif_offset + "elif ".len();
            let elif_condition = parse_condition(
                elif_cond_str,
                elif_cond_offset,
                next_line.line_number,
                elif_col + 5,
            )?;

            let elif_body_lines = collect_block(lines, next_idx + 1, parent_indent);
            let elif_body_stmts = parse_statement_block(elif_body_lines)?;

            let elif_end = if elif_body_lines.is_empty() {
                elif_offset + elif_content.len()
            } else {
                let last = &elif_body_lines[elif_body_lines.len() - 1];
                last.byte_offset + last.indent + last.content.len()
            };

            elif_branches.push(ElifBranch {
                condition: elif_condition,
                body: elif_body_stmts,
                span: Span::new(elif_offset, elif_end, next_line.line_number, elif_col),
            });

            total_consumed += 1 + elif_body_lines.len();
            continue;
        }

        // Check for else
        if next_line.content == "else:" {
            let else_body_lines = collect_block(lines, next_idx + 1, parent_indent);
            let else_stmts = parse_statement_block(else_body_lines)?;
            else_body = Some(else_stmts);
            total_consumed += 1 + else_body_lines.len();
            break;
        }

        // Not an elif or else -- stop
        break;
    }

    // Calculate end offset
    let end_idx = start_idx + total_consumed - 1;
    let end_offset = if end_idx < lines.len() {
        let last = &lines[end_idx];
        last.byte_offset + last.indent + last.content.len()
    } else {
        base_offset + content.len()
    };

    let cond = Conditional {
        condition,
        then_body,
        elif_branches,
        else_body,
        span: Span::new(base_offset, end_offset, header.line_number, col),
    };

    Ok((Statement::Conditional(cond), total_consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::ast::Condition;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_simple_if() {
        let input = "if status == \"done\":\n  /done T1234";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_conditional(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
        match stmt {
            Statement::Conditional(c) => {
                match &c.condition {
                    Condition::Expression(_) => {}
                    other => panic!("expected Expression, got {other:?}"),
                }
                assert_eq!(c.then_body.len(), 1);
                assert!(c.elif_branches.is_empty());
                assert!(c.else_body.is_none());
            }
            other => panic!("expected Conditional, got {other:?}"),
        }
    }

    #[test]
    fn parse_if_with_discretion() {
        let input = "if **all reviews pass**:\n  /done T1234";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_conditional(&lines, 0).unwrap();
        match stmt {
            Statement::Conditional(c) => match &c.condition {
                Condition::Discretion(dc) => assert_eq!(dc.prose, "all reviews pass"),
                other => panic!("expected Discretion, got {other:?}"),
            },
            other => panic!("expected Conditional, got {other:?}"),
        }
    }

    #[test]
    fn parse_if_else() {
        let input = "if status == \"done\":\n  /done T1234\nelse:\n  /info @all \"Not done\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_conditional(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match stmt {
            Statement::Conditional(c) => {
                assert_eq!(c.then_body.len(), 1);
                assert!(c.elif_branches.is_empty());
                assert!(c.else_body.is_some());
                assert_eq!(c.else_body.unwrap().len(), 1);
            }
            other => panic!("expected Conditional, got {other:?}"),
        }
    }

    #[test]
    fn parse_if_elif_else() {
        let input = "if a == 1:\n  /info @all \"one\"\nelif a == 2:\n  /info @all \"two\"\nelse:\n  /info @all \"other\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_conditional(&lines, 0).unwrap();
        assert_eq!(consumed, 6);
        match stmt {
            Statement::Conditional(c) => {
                assert_eq!(c.then_body.len(), 1);
                assert_eq!(c.elif_branches.len(), 1);
                assert!(c.else_body.is_some());
            }
            other => panic!("expected Conditional, got {other:?}"),
        }
    }

    #[test]
    fn parse_if_multiple_elifs() {
        let input = "if a == 1:\n  /info @a \"1\"\nelif a == 2:\n  /info @a \"2\"\nelif a == 3:\n  /info @a \"3\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_conditional(&lines, 0).unwrap();
        assert_eq!(consumed, 6);
        match stmt {
            Statement::Conditional(c) => {
                assert_eq!(c.elif_branches.len(), 2);
                assert!(c.else_body.is_none());
            }
            other => panic!("expected Conditional, got {other:?}"),
        }
    }

    #[test]
    fn parse_if_discretion_elif_else() {
        let input = "if **task looks good**:\n  /done T1234\nelif **needs minor fixes**:\n  /review @author\nelse:\n  /blocked T1234";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_conditional(&lines, 0).unwrap();
        match stmt {
            Statement::Conditional(c) => {
                match &c.condition {
                    Condition::Discretion(dc) => assert_eq!(dc.prose, "task looks good"),
                    other => panic!("expected Discretion, got {other:?}"),
                }
                assert_eq!(c.elif_branches.len(), 1);
                match &c.elif_branches[0].condition {
                    Condition::Discretion(dc) => assert_eq!(dc.prose, "needs minor fixes"),
                    other => panic!("expected Discretion, got {other:?}"),
                }
                assert!(c.else_body.is_some());
            }
            other => panic!("expected Conditional, got {other:?}"),
        }
    }

    #[test]
    fn reject_missing_colon() {
        let input = "if status == \"done\"\n  /done T1234";
        let lines = split_lines(input).unwrap();
        let err = parse_conditional(&lines, 0).unwrap_err();
        assert!(err.message.contains("`:`"));
    }

    #[test]
    fn reject_empty_condition() {
        let input = "if :\n  /done T1234";
        let lines = split_lines(input).unwrap();
        let err = parse_conditional(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty condition"));
    }

    #[test]
    fn parse_if_only_no_body_ok() {
        let input = "if x == 1:";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_conditional(&lines, 0).unwrap();
        assert_eq!(consumed, 1);
        match stmt {
            Statement::Conditional(c) => assert!(c.then_body.is_empty()),
            other => panic!("expected Conditional, got {other:?}"),
        }
    }

    #[test]
    fn parse_if_multi_statement_body() {
        let input = "if x == 1:\n  let a = 1\n  /done T1234\n  /info @all \"done\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_conditional(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match stmt {
            Statement::Conditional(c) => assert_eq!(c.then_body.len(), 3),
            other => panic!("expected Conditional, got {other:?}"),
        }
    }

    #[test]
    fn parse_condition_expression() {
        let cond = parse_condition("x == 1", 0, 1, 1).unwrap();
        match cond {
            Condition::Expression(_) => {}
            other => panic!("expected Expression condition, got {other:?}"),
        }
    }

    #[test]
    fn parse_condition_discretion() {
        let cond = parse_condition("**all good**", 0, 1, 1).unwrap();
        match cond {
            Condition::Discretion(dc) => assert_eq!(dc.prose, "all good"),
            other => panic!("expected Discretion condition, got {other:?}"),
        }
    }

    #[test]
    fn if_followed_by_unrelated_line() {
        let input = "if x == 1:\n  /done T1234\nlet y = 2";
        let lines = split_lines(input).unwrap();
        let (_, consumed) = parse_conditional(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
    }

    #[test]
    fn span_covers_if_else() {
        let input = "if x:\n  /done T1\nelse:\n  /info @a \"b\"";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_conditional(&lines, 0).unwrap();
        match stmt {
            Statement::Conditional(c) => {
                assert_eq!(c.span.start, 0);
                assert_eq!(c.span.line, 1);
            }
            other => panic!("expected Conditional, got {other:?}"),
        }
    }

    #[test]
    fn reject_elif_empty_condition() {
        let input = "if x == 1:\n  /done T1\nelif :\n  /done T2";
        let lines = split_lines(input).unwrap();
        let err = parse_conditional(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty elif condition"));
    }
}
