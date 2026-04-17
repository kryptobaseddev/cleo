//! Try/catch/finally parser for the CANT DSL.
//!
//! Parses error handling blocks:
//!
//! ```cant
//! try:
//!   session "Deploy to production"
//! catch err:
//!   /info @ops "Deployment failed: ${err}"
//! finally:
//!   /done T1234
//! ```

use super::ast::{Statement, TryCatch};
use super::error::ParseError;
use super::indent::{IndentedLine, collect_block};
use super::span::Span;
use super::statement::parse_statement_block;

/// Parses a `try:`/`catch:`/`finally:` block starting at the given line index.
///
/// Returns the parsed [`TryCatch`] wrapped in a [`Statement::TryCatch`]
/// and the number of lines consumed.
///
/// # Errors
///
/// Returns [`ParseError`] if the `try:`, `catch:`, or `finally:` clauses are malformed.
pub fn parse_try_catch(
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

    if content != "try:" {
        return Err(ParseError::error("expected `try:`", header_span));
    }

    // Parse try body
    let try_lines = collect_block(lines, start_idx + 1, parent_indent);
    let try_body = parse_statement_block(try_lines)?;
    let mut total_consumed = 1 + try_lines.len();

    let mut catch_name: Option<String> = None;
    let mut catch_body: Option<Vec<Statement>> = None;
    let mut finally_body: Option<Vec<Statement>> = None;

    // Look for catch clause
    let next_idx = start_idx + total_consumed;
    if next_idx < lines.len() {
        let next_line = &lines[next_idx];
        if !next_line.is_blank()
            && next_line.indent == parent_indent
            && (next_line.content.starts_with("catch")
                && (next_line.content == "catch:" || next_line.content.starts_with("catch ")))
        {
            let catch_content = next_line.content;

            // Parse catch header: "catch:" or "catch err:"
            if catch_content == "catch:" {
                // No error binding
            } else if let Some(after_catch) = catch_content.strip_prefix("catch ") {
                let err_name = after_catch
                    .strip_suffix(':')
                    .ok_or_else(|| {
                        let catch_offset = next_line.byte_offset + next_line.indent;
                        ParseError::error(
                            "expected `:` after catch, e.g. `catch err:`",
                            Span::new(
                                catch_offset,
                                catch_offset + catch_content.len(),
                                next_line.line_number,
                                (next_line.indent as u32) + 1,
                            ),
                        )
                    })?
                    .trim();

                if !err_name.is_empty() {
                    catch_name = Some(err_name.to_string());
                }
            }

            let catch_lines = collect_block(lines, next_idx + 1, parent_indent);
            catch_body = Some(parse_statement_block(catch_lines)?);
            total_consumed += 1 + catch_lines.len();
        }
    }

    // Look for finally clause
    let finally_idx = start_idx + total_consumed;
    if finally_idx < lines.len() {
        let finally_line = &lines[finally_idx];
        if !finally_line.is_blank()
            && finally_line.indent == parent_indent
            && finally_line.content == "finally:"
        {
            let fin_lines = collect_block(lines, finally_idx + 1, parent_indent);
            finally_body = Some(parse_statement_block(fin_lines)?);
            total_consumed += 1 + fin_lines.len();
        }
    }

    let end_idx = start_idx + total_consumed - 1;
    let end_offset = if end_idx < lines.len() {
        let last = &lines[end_idx];
        last.byte_offset + last.indent + last.content.len()
    } else {
        base_offset + content.len()
    };

    let tc = TryCatch {
        try_body,
        catch_name,
        catch_body,
        finally_body,
        span: Span::new(base_offset, end_offset, header.line_number, col),
    };

    Ok((Statement::TryCatch(tc), total_consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_try_only() {
        let input = "try:\n  /done T1234";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = super::parse_try_catch(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
        match stmt {
            Statement::TryCatch(tc) => {
                assert_eq!(tc.try_body.len(), 1);
                assert!(tc.catch_name.is_none());
                assert!(tc.catch_body.is_none());
                assert!(tc.finally_body.is_none());
            }
            other => panic!("expected TryCatch, got {other:?}"),
        }
    }

    #[test]
    fn parse_try_catch_basic() {
        let input = "try:\n  /done T1234\ncatch err:\n  /info @ops \"failed\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = super::parse_try_catch(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match stmt {
            Statement::TryCatch(tc) => {
                assert_eq!(tc.try_body.len(), 1);
                assert_eq!(tc.catch_name, Some("err".to_string()));
                assert!(tc.catch_body.is_some());
                assert_eq!(tc.catch_body.unwrap().len(), 1);
                assert!(tc.finally_body.is_none());
            }
            other => panic!("expected TryCatch, got {other:?}"),
        }
    }

    #[test]
    fn parse_try_catch_no_binding() {
        let input = "try:\n  /done T1\ncatch:\n  /info @ops \"fail\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = super::parse_try_catch(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match stmt {
            Statement::TryCatch(tc) => {
                assert!(tc.catch_name.is_none());
                assert!(tc.catch_body.is_some());
            }
            other => panic!("expected TryCatch, got {other:?}"),
        }
    }

    #[test]
    fn parse_try_catch_finally() {
        let input =
            "try:\n  /done T1\ncatch err:\n  /info @ops \"fail\"\nfinally:\n  /checkin @all";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = super::parse_try_catch(&lines, 0).unwrap();
        assert_eq!(consumed, 6);
        match stmt {
            Statement::TryCatch(tc) => {
                assert_eq!(tc.try_body.len(), 1);
                assert_eq!(tc.catch_name, Some("err".to_string()));
                assert!(tc.catch_body.is_some());
                assert!(tc.finally_body.is_some());
                assert_eq!(tc.finally_body.unwrap().len(), 1);
            }
            other => panic!("expected TryCatch, got {other:?}"),
        }
    }

    #[test]
    fn parse_try_finally_no_catch() {
        let input = "try:\n  /done T1\nfinally:\n  /checkin @all";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = super::parse_try_catch(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match stmt {
            Statement::TryCatch(tc) => {
                assert!(tc.catch_body.is_none());
                assert!(tc.finally_body.is_some());
            }
            other => panic!("expected TryCatch, got {other:?}"),
        }
    }

    #[test]
    fn parse_try_multi_statement_bodies() {
        let input = "try:\n  let x = 1\n  /done T1\ncatch err:\n  let y = 2\n  /info @ops \"fail\"\nfinally:\n  /checkin @all\n  /done T2";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = super::parse_try_catch(&lines, 0).unwrap();
        assert_eq!(consumed, 9);
        match stmt {
            Statement::TryCatch(tc) => {
                assert_eq!(tc.try_body.len(), 2);
                assert_eq!(tc.catch_body.as_ref().unwrap().len(), 2);
                assert_eq!(tc.finally_body.as_ref().unwrap().len(), 2);
            }
            other => panic!("expected TryCatch, got {other:?}"),
        }
    }

    #[test]
    fn try_empty_body() {
        let input = "try:";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = super::parse_try_catch(&lines, 0).unwrap();
        assert_eq!(consumed, 1);
        match stmt {
            Statement::TryCatch(tc) => assert!(tc.try_body.is_empty()),
            other => panic!("expected TryCatch, got {other:?}"),
        }
    }

    #[test]
    fn reject_not_try() {
        let input = "catch:";
        let lines = split_lines(input).unwrap();
        let err = super::parse_try_catch(&lines, 0).unwrap_err();
        assert!(err.message.contains("`try:`"));
    }

    #[test]
    fn try_followed_by_unrelated() {
        let input = "try:\n  /done T1\nlet x = 2";
        let lines = split_lines(input).unwrap();
        let (_, consumed) = super::parse_try_catch(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
    }

    #[test]
    fn span_covers_try_catch_finally() {
        let input = "try:\n  /done T1\ncatch:\n  /info @a \"b\"\nfinally:\n  /ack";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = super::parse_try_catch(&lines, 0).unwrap();
        match stmt {
            Statement::TryCatch(tc) => {
                assert_eq!(tc.span.start, 0);
                assert_eq!(tc.span.line, 1);
            }
            other => panic!("expected TryCatch, got {other:?}"),
        }
    }

    #[test]
    fn catch_missing_colon_after_name() {
        let input = "try:\n  /done T1\ncatch err\n  /info @a \"b\"";
        let lines = split_lines(input).unwrap();
        let err = super::parse_try_catch(&lines, 0).unwrap_err();
        assert!(err.message.contains("`:`"));
    }

    #[test]
    fn catch_with_empty_name() {
        let input = "try:\n  /done T1\ncatch :\n  /info @a \"b\"";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = super::parse_try_catch(&lines, 0).unwrap();
        match stmt {
            Statement::TryCatch(tc) => {
                // Empty name after "catch " gets trimmed to empty, so no binding
                assert!(tc.catch_name.is_none());
                assert!(tc.catch_body.is_some());
            }
            other => panic!("expected TryCatch, got {other:?}"),
        }
    }
}
