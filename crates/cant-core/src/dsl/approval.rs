//! Approval gate parser for the CANT DSL.
//!
//! Parses `approve:` blocks that suspend workflow execution until
//! a human approves or rejects.
//!
//! ```cant
//! approve:
//!   message: "Ready to deploy to production?"
//!   timeout: 24h
//! ```

use super::ast::{ApprovalGate, Statement};
use super::error::ParseError;
use super::indent::{IndentedLine, collect_block};
use super::property::parse_property;
use super::span::Span;

/// Parses an `approve:` block starting at the given line index.
///
/// Returns the parsed [`ApprovalGate`] wrapped in a [`Statement::ApprovalGate`]
/// and the number of lines consumed.
pub fn parse_approval_gate(
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

    if content != "approve:" {
        return Err(ParseError::error("expected `approve:`", header_span));
    }

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

    let end_offset = if body_lines.is_empty() {
        base_offset + content.len()
    } else {
        let last = &body_lines[body_lines.len() - 1];
        last.byte_offset + last.indent + last.content.len()
    };

    let gate = ApprovalGate {
        properties,
        span: Span::new(base_offset, end_offset, header.line_number, col),
    };

    Ok((Statement::ApprovalGate(gate), total_consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::ast::Value;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_simple_approval() {
        let input = "approve:\n  message: \"Ready to deploy?\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_approval_gate(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
        match stmt {
            Statement::ApprovalGate(g) => {
                assert_eq!(g.properties.len(), 1);
                assert_eq!(g.properties[0].key.value, "message");
            }
            other => panic!("expected ApprovalGate, got {:?}", other),
        }
    }

    #[test]
    fn parse_approval_with_timeout() {
        let input = "approve:\n  message: \"Deploy?\"\n  timeout: 24h";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_approval_gate(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        match stmt {
            Statement::ApprovalGate(g) => {
                assert_eq!(g.properties.len(), 2);
                assert_eq!(g.properties[0].key.value, "message");
                assert_eq!(g.properties[1].key.value, "timeout");
            }
            other => panic!("expected ApprovalGate, got {:?}", other),
        }
    }

    #[test]
    fn parse_approval_with_expires() {
        let input = "approve:\n  message: \"Ship it?\"\n  expires: 48h";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_approval_gate(&lines, 0).unwrap();
        match stmt {
            Statement::ApprovalGate(g) => {
                assert_eq!(g.properties.len(), 2);
                assert_eq!(g.properties[1].key.value, "expires");
            }
            other => panic!("expected ApprovalGate, got {:?}", other),
        }
    }

    #[test]
    fn parse_approval_empty_body() {
        let input = "approve:";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_approval_gate(&lines, 0).unwrap();
        assert_eq!(consumed, 1);
        match stmt {
            Statement::ApprovalGate(g) => assert!(g.properties.is_empty()),
            other => panic!("expected ApprovalGate, got {:?}", other),
        }
    }

    #[test]
    fn parse_approval_with_custom_properties() {
        let input = "approve:\n  message: \"Ready?\"\n  timeout: 24h\n  assignee: ops-lead";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_approval_gate(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match stmt {
            Statement::ApprovalGate(g) => {
                assert_eq!(g.properties.len(), 3);
                assert_eq!(g.properties[2].key.value, "assignee");
            }
            other => panic!("expected ApprovalGate, got {:?}", other),
        }
    }

    #[test]
    fn reject_not_approve() {
        let input = "approval:";
        let lines = split_lines(input).unwrap();
        let err = parse_approval_gate(&lines, 0).unwrap_err();
        assert!(err.message.contains("`approve:`"));
    }

    #[test]
    fn parse_approval_skips_blanks() {
        let input = "approve:\n  message: \"Ready?\"\n\n  timeout: 1h";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_approval_gate(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match stmt {
            Statement::ApprovalGate(g) => assert_eq!(g.properties.len(), 2),
            other => panic!("expected ApprovalGate, got {:?}", other),
        }
    }

    #[test]
    fn parse_approval_skips_comments() {
        let input = "approve:\n  # This is a gate\n  message: \"Ship?\"";
        let lines = split_lines(input).unwrap();
        let (stmt, consumed) = parse_approval_gate(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        match stmt {
            Statement::ApprovalGate(g) => {
                assert_eq!(g.properties.len(), 1);
                assert_eq!(g.properties[0].key.value, "message");
            }
            other => panic!("expected ApprovalGate, got {:?}", other),
        }
    }

    #[test]
    fn parse_approval_timeout_duration() {
        let input = "approve:\n  message: \"OK?\"\n  timeout: 30m";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_approval_gate(&lines, 0).unwrap();
        match stmt {
            Statement::ApprovalGate(g) => {
                let timeout = &g.properties[1];
                match &timeout.value {
                    Value::Duration(d) => {
                        assert_eq!(d.amount, 30);
                    }
                    other => panic!("expected Duration, got {:?}", other),
                }
            }
            other => panic!("expected ApprovalGate, got {:?}", other),
        }
    }

    #[test]
    fn span_covers_approval_block() {
        let input = "approve:\n  message: \"Deploy?\"";
        let lines = split_lines(input).unwrap();
        let (stmt, _) = parse_approval_gate(&lines, 0).unwrap();
        match stmt {
            Statement::ApprovalGate(g) => {
                assert_eq!(g.span.start, 0);
                assert_eq!(g.span.line, 1);
            }
            other => panic!("expected ApprovalGate, got {:?}", other),
        }
    }

    #[test]
    fn approval_followed_by_unrelated() {
        let input = "approve:\n  message: \"OK?\"\nlet x = 1";
        let lines = split_lines(input).unwrap();
        let (_, consumed) = parse_approval_gate(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
    }
}
