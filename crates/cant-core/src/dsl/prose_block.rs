//! Prose block parser for the CANT DSL pipe-then-indent syntax.
//!
//! A prose block begins with `|` as the property value, followed by
//! indented content lines. The block terminates on dedent (a line at
//! the same or lesser indentation as the property key).
//!
//! ```cant
//! tone: |
//!   You are calm and precise.
//!   Never use jargon.
//! ```

use super::ast::ProseBlock;
use super::error::ParseError;
use super::indent::IndentedLine;
use super::span::Span;

/// Parses a prose block from the lines following a `key: |` property.
///
/// The `key_line_idx` should point to the line containing `key: |`.
/// The `lines` slice should contain the full document (or at least the
/// block's parent scope). The `key_indent` is the indentation of the
/// key line itself.
///
/// Returns the parsed [`ProseBlock`] and the number of additional lines
/// consumed (not counting the key line itself).
///
/// # Errors
///
/// Returns [`ParseError`] if the prose block has no content lines.
pub fn parse_prose_block(
    lines: &[IndentedLine<'_>],
    key_line_idx: usize,
    key_indent: usize,
) -> Result<(ProseBlock, usize), ParseError> {
    let key_line = &lines[key_line_idx];
    let pipe_offset = key_line.byte_offset + key_line.indent + key_line.content.len() - 1;

    let mut content_lines: Vec<(usize, &str)> = Vec::new();
    let mut consumed = 0;
    let mut idx = key_line_idx + 1;

    while idx < lines.len() {
        let line = &lines[idx];

        // Blank lines within the block are preserved
        if line.is_blank() {
            content_lines.push((0, ""));
            consumed += 1;
            idx += 1;
            continue;
        }

        // Dedent terminates the block
        if line.indent <= key_indent {
            break;
        }

        content_lines.push((line.indent, line.content));
        consumed += 1;
        idx += 1;
    }

    // Strip trailing blank lines
    while content_lines.last().is_some_and(|(_, s)| s.is_empty()) {
        content_lines.pop();
        // Don't reduce consumed — those blank lines are still consumed from the stream
    }

    // If no content lines, return an empty prose block
    if content_lines.is_empty() {
        return Ok((
            ProseBlock {
                lines: Vec::new(),
                span: Span::new(
                    pipe_offset,
                    pipe_offset + 1,
                    key_line.line_number,
                    (key_line.indent as u32) + key_line.content.len() as u32,
                ),
            },
            consumed,
        ));
    }

    // Find minimum indentation among non-blank lines for common-indent stripping
    let min_indent = content_lines
        .iter()
        .filter(|(_, s)| !s.is_empty())
        .map(|(indent, _)| *indent)
        .min()
        .unwrap_or(0);

    // Build the final line strings with common indentation removed
    let prose_lines: Vec<String> = content_lines
        .iter()
        .map(|(indent, s)| {
            if s.is_empty() {
                String::new()
            } else {
                // Reconstruct the line with excess indentation preserved
                let excess = indent.saturating_sub(min_indent);
                format!("{}{}", " ".repeat(excess), s)
            }
        })
        .collect();

    // Calculate span: from the pipe character to end of last content line
    let first_content_line = &lines[key_line_idx + 1];
    let last_content_idx = key_line_idx + consumed;
    let last_line = &lines[last_content_idx];
    let span_start = pipe_offset;
    let span_end = last_line.byte_offset + last_line.indent + last_line.content.len();

    let span = Span::new(
        span_start,
        span_end,
        first_content_line.line_number.saturating_sub(1),
        (key_line.indent as u32) + key_line.content.len() as u32,
    );

    Ok((
        ProseBlock {
            lines: prose_lines,
            span,
        },
        consumed,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::indent::split_lines;

    #[test]
    fn basic_prose_block() {
        let input = "tone: |\n  You are calm and precise.\n  Never use jargon.";
        let lines = split_lines(input).unwrap();
        let (block, consumed) = parse_prose_block(&lines, 0, 0).unwrap();
        assert_eq!(consumed, 2);
        assert_eq!(block.lines.len(), 2);
        assert_eq!(block.lines[0], "You are calm and precise.");
        assert_eq!(block.lines[1], "Never use jargon.");
    }

    #[test]
    fn empty_prose_block() {
        let input = "tone: |";
        let lines = split_lines(input).unwrap();
        let (block, consumed) = parse_prose_block(&lines, 0, 0).unwrap();
        assert_eq!(consumed, 0);
        assert!(block.lines.is_empty());
    }

    #[test]
    fn empty_prose_block_followed_by_dedent() {
        let input = "tone: |\nmodel: opus";
        let lines = split_lines(input).unwrap();
        let (block, consumed) = parse_prose_block(&lines, 0, 0).unwrap();
        assert_eq!(consumed, 0);
        assert!(block.lines.is_empty());
    }

    #[test]
    fn multi_paragraph_prose_block() {
        let input = "prompt: |\n  First paragraph line one.\n  First paragraph line two.\n\n  Second paragraph line one.";
        let lines = split_lines(input).unwrap();
        let (block, consumed) = parse_prose_block(&lines, 0, 0).unwrap();
        assert_eq!(consumed, 4);
        assert_eq!(block.lines.len(), 4);
        assert_eq!(block.lines[0], "First paragraph line one.");
        assert_eq!(block.lines[1], "First paragraph line two.");
        assert_eq!(block.lines[2], "");
        assert_eq!(block.lines[3], "Second paragraph line one.");
    }

    #[test]
    fn prose_block_in_agent_context() {
        // Simulates a prose block inside an agent block (indented at level 2)
        let input = "agent ops:\n  tone: |\n    You are calm.\n    Be precise.\n  model: opus";
        let lines = split_lines(input).unwrap();
        // The tone: | line is at index 1, with indent 2
        let (block, consumed) = parse_prose_block(&lines, 1, 2).unwrap();
        assert_eq!(consumed, 2);
        assert_eq!(block.lines.len(), 2);
        assert_eq!(block.lines[0], "You are calm.");
        assert_eq!(block.lines[1], "Be precise.");
    }

    #[test]
    fn prose_block_preserves_relative_indentation() {
        let input = "prompt: |\n  Line one.\n    Indented sub-line.\n  Back to base.";
        let lines = split_lines(input).unwrap();
        let (block, consumed) = parse_prose_block(&lines, 0, 0).unwrap();
        assert_eq!(consumed, 3);
        assert_eq!(block.lines.len(), 3);
        assert_eq!(block.lines[0], "Line one.");
        assert_eq!(block.lines[1], "  Indented sub-line.");
        assert_eq!(block.lines[2], "Back to base.");
    }

    #[test]
    fn prose_block_trailing_blank_lines_stripped() {
        let input = "tone: |\n  Line one.\n\n";
        let lines = split_lines(input).unwrap();
        let (block, consumed) = parse_prose_block(&lines, 0, 0).unwrap();
        // The blank line is consumed but stripped from the prose lines
        assert_eq!(consumed, 2);
        assert_eq!(block.lines.len(), 1);
        assert_eq!(block.lines[0], "Line one.");
    }

    #[test]
    fn prose_block_span_covers_content() {
        let input = "tone: |\n  You are calm.\n  Be precise.";
        let lines = split_lines(input).unwrap();
        let (block, _) = parse_prose_block(&lines, 0, 0).unwrap();
        assert!(block.span.start > 0);
        assert!(block.span.end > block.span.start);
    }

    // ── Integration tests via parse_document ────────────────────────

    #[test]
    fn document_agent_with_prose_tone() {
        use crate::dsl::ast::{DocumentKind, Section, Value};
        use crate::dsl::parse_document;

        let input = "\
---
kind: agent
---
agent ops:
  model: opus
  tone: |
    You are calm and precise.
    Never use jargon.
  persist: true";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.kind, Some(DocumentKind::Agent));
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Agent(a) => {
                assert_eq!(a.name.value, "ops");
                assert_eq!(a.properties.len(), 3); // model, tone, persist
                assert_eq!(a.properties[1].key.value, "tone");
                match &a.properties[1].value {
                    Value::ProseBlock(pb) => {
                        assert_eq!(pb.lines.len(), 2);
                        assert_eq!(pb.lines[0], "You are calm and precise.");
                        assert_eq!(pb.lines[1], "Never use jargon.");
                    }
                    other => panic!("expected ProseBlock, got {other:?}"),
                }
            }
            other => panic!("expected Agent, got {other:?}"),
        }
    }

    #[test]
    fn document_agent_with_prose_prompt_multi_paragraph() {
        use crate::dsl::ast::{Section, Value};
        use crate::dsl::parse_document;

        let input = "\
agent coordinator:
  model: opus
  prompt: |
    You coordinate all operations across the team.
    Be concise and actionable.

    Always prioritize safety over speed.
  permissions:
    tasks: read, write";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Agent(a) => {
                assert_eq!(a.name.value, "coordinator");
                assert_eq!(a.properties.len(), 2); // model, prompt
                assert_eq!(a.properties[1].key.value, "prompt");
                match &a.properties[1].value {
                    Value::ProseBlock(pb) => {
                        assert_eq!(pb.lines.len(), 4);
                        assert_eq!(
                            pb.lines[0],
                            "You coordinate all operations across the team."
                        );
                        assert_eq!(pb.lines[1], "Be concise and actionable.");
                        assert_eq!(pb.lines[2], "");
                        assert_eq!(pb.lines[3], "Always prioritize safety over speed.");
                    }
                    other => panic!("expected ProseBlock, got {other:?}"),
                }
                assert_eq!(a.permissions.len(), 1);
            }
            other => panic!("expected Agent, got {other:?}"),
        }
    }

    #[test]
    fn document_skill_with_prose_description() {
        use crate::dsl::ast::{Section, Value};
        use crate::dsl::parse_document;

        let input = "\
skill ct-deploy:
  tier: core
  description: |
    Deployment automation skill.
    Handles CI/CD pipelines.";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Skill(s) => {
                assert_eq!(s.name.value, "ct-deploy");
                assert_eq!(s.properties.len(), 2); // tier, description
                assert_eq!(s.properties[1].key.value, "description");
                match &s.properties[1].value {
                    Value::ProseBlock(pb) => {
                        assert_eq!(pb.lines.len(), 2);
                        assert_eq!(pb.lines[0], "Deployment automation skill.");
                        assert_eq!(pb.lines[1], "Handles CI/CD pipelines.");
                    }
                    other => panic!("expected ProseBlock, got {other:?}"),
                }
            }
            other => panic!("expected Skill, got {other:?}"),
        }
    }

    #[test]
    fn document_agent_prose_empty_block() {
        use crate::dsl::ast::{Section, Value};
        use crate::dsl::parse_document;

        let input = "\
agent ops:
  model: opus
  tone: |
  persist: true";
        let doc = parse_document(input).unwrap();
        match &doc.sections[0] {
            Section::Agent(a) => {
                assert_eq!(a.properties.len(), 3);
                match &a.properties[1].value {
                    Value::ProseBlock(pb) => {
                        assert!(pb.lines.is_empty());
                    }
                    other => panic!("expected empty ProseBlock, got {other:?}"),
                }
            }
            other => panic!("expected Agent, got {other:?}"),
        }
    }
}
