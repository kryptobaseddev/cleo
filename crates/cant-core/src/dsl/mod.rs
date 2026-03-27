//! CANT DSL Layer 2 parser.
//!
//! This module provides the structured parser for `.cant` document files.
//! It transforms raw CANT DSL text into an AST rooted at [`ast::CantDocument`].
//!
//! The parser is line-based with indentation tracking (2-space, like YAML).
//! It recognizes frontmatter, agent/skill/hook definitions, imports, and bindings.
//!
//! # Entry Point
//!
//! Use [`parse_document`] to parse a complete `.cant` file:
//!
//! ```
//! use cant_core::dsl::parse_document;
//!
//! let doc = parse_document("---\nkind: agent\n---\nagent ops:\n  model: opus").unwrap();
//! assert!(doc.frontmatter.is_some());
//! assert_eq!(doc.sections.len(), 1);
//! ```

pub mod agent;
pub mod approval;
pub mod ast;
pub mod ast_orchestration;
pub mod binding;
pub mod conditional;
pub mod discretion;
pub mod error;
pub mod expression;
pub mod frontmatter;
pub mod hook;
pub mod import;
pub mod indent;
pub mod loop_;
pub mod parallel;
pub mod permission;
pub mod pipeline;
pub mod property;
pub mod session;
pub mod skill;
pub mod span;
pub mod statement;
pub mod try_catch;
pub mod workflow;

use ast::{CantDocument, Comment, DocumentKind, Section};
use error::ParseError;
use indent::split_lines;
use span::Span;

/// Parses a complete `.cant` document into a [`CantDocument`] AST.
///
/// This is the main entry point for CANT DSL parsing. It:
/// 1. Splits the input into indented lines and validates indentation
/// 2. Parses frontmatter if present (`---` delimited block)
/// 3. Parses remaining lines as top-level sections (agent, skill, hook, import, binding)
/// 4. Returns a `CantDocument` or a list of parse errors
///
/// # Arguments
///
/// * `content` - The raw `.cant` document text.
///
/// # Returns
///
/// `Ok(CantDocument)` on success, or `Err(Vec<ParseError>)` if parsing fails.
///
/// # Examples
///
/// ```
/// use cant_core::dsl::parse_document;
///
/// // Document with frontmatter and agent block
/// let doc = parse_document("---\nkind: agent\n---\nagent ops:\n  model: opus").unwrap();
/// assert!(doc.frontmatter.is_some());
///
/// // Message-mode document (no frontmatter)
/// let doc = parse_document("# Just a message").unwrap();
/// assert!(doc.frontmatter.is_none());
/// ```
pub fn parse_document(content: &str) -> Result<CantDocument, Vec<ParseError>> {
    if content.is_empty() {
        return Ok(CantDocument {
            kind: Some(DocumentKind::Message),
            frontmatter: None,
            sections: Vec::new(),
            span: Span::new(0, 0, 1, 1),
        });
    }

    let lines = split_lines(content).map_err(|e| vec![e])?;

    if lines.is_empty() {
        return Ok(CantDocument {
            kind: Some(DocumentKind::Message),
            frontmatter: None,
            sections: Vec::new(),
            span: Span::new(0, content.len(), 1, 1),
        });
    }

    // Try to parse frontmatter
    let (fm, start_idx) = match frontmatter::parse_frontmatter(&lines) {
        Ok(Some((fm, consumed))) => (Some(fm), consumed),
        Ok(None) => (None, 0),
        Err(e) => return Err(vec![e]),
    };

    // Determine document kind
    let kind = fm.as_ref().and_then(|f| f.kind);

    // Parse sections
    let mut sections = Vec::new();
    let mut errors = Vec::new();
    let mut idx = start_idx;

    while idx < lines.len() {
        let line = &lines[idx];

        // Skip blank lines
        if line.is_blank() {
            idx += 1;
            continue;
        }

        // Comments at top level
        if line.is_comment() {
            let base_offset = line.byte_offset + line.indent;
            sections.push(Section::Comment(Comment {
                text: line.content[1..].trim().to_string(),
                span: Span::new(
                    base_offset,
                    base_offset + line.content.len(),
                    line.line_number,
                    (line.indent as u32) + 1,
                ),
            }));
            idx += 1;
            continue;
        }

        let content_str = line.content;

        // Agent block
        if content_str.starts_with("agent ") {
            match agent::parse_agent_block(&lines, idx) {
                Ok((agent_def, consumed)) => {
                    sections.push(Section::Agent(agent_def));
                    idx += consumed;
                }
                Err(e) => {
                    errors.push(e);
                    idx += 1;
                }
            }
            continue;
        }

        // Skill block
        if content_str.starts_with("skill ") {
            match skill::parse_skill_block(&lines, idx) {
                Ok((skill_def, consumed)) => {
                    sections.push(Section::Skill(skill_def));
                    idx += consumed;
                }
                Err(e) => {
                    errors.push(e);
                    idx += 1;
                }
            }
            continue;
        }

        // Hook block
        if content_str.starts_with("on ") && content_str.ends_with(':') {
            match hook::parse_hook_block(&lines, idx) {
                Ok((hook_def, consumed)) => {
                    sections.push(Section::Hook(hook_def));
                    idx += consumed;
                }
                Err(e) => {
                    errors.push(e);
                    idx += 1;
                }
            }
            continue;
        }

        // Import statement
        if content_str.starts_with("@import ") {
            match import::parse_import(line) {
                Ok(imp) => {
                    sections.push(Section::Import(imp));
                }
                Err(e) => {
                    errors.push(e);
                }
            }
            idx += 1;
            continue;
        }

        // Let/const binding
        if content_str.starts_with("let ") || content_str.starts_with("const ") {
            match binding::parse_binding(line) {
                Ok(bind) => {
                    sections.push(Section::Binding(bind));
                }
                Err(e) => {
                    errors.push(e);
                }
            }
            idx += 1;
            continue;
        }

        // Workflow block
        if content_str.starts_with("workflow ") && content_str.ends_with(':') {
            match workflow::parse_workflow_block(&lines, idx) {
                Ok((wf_def, consumed)) => {
                    sections.push(Section::Workflow(wf_def));
                    idx += consumed;
                }
                Err(e) => {
                    errors.push(e);
                    idx += 1;
                }
            }
            continue;
        }

        // Pipeline block
        if content_str.starts_with("pipeline ") && content_str.ends_with(':') {
            match pipeline::parse_pipeline_block(&lines, idx) {
                Ok((pipe_def, consumed)) => {
                    sections.push(Section::Pipeline(pipe_def));
                    idx += consumed;
                }
                Err(e) => {
                    errors.push(e);
                    idx += 1;
                }
            }
            continue;
        }

        // Unknown top-level construct
        let base_offset = line.byte_offset + line.indent;
        errors.push(ParseError::error(
            format!(
                "unexpected top-level construct: `{}`; expected agent, skill, on, workflow, pipeline, @import, let, const, or #comment",
                content_str
            ),
            Span::new(
                base_offset,
                base_offset + content_str.len(),
                line.line_number,
                (line.indent as u32) + 1,
            ),
        ));
        idx += 1;
    }

    if !errors.is_empty() {
        return Err(errors);
    }

    let doc_span = Span::new(0, content.len(), 1, 1);

    Ok(CantDocument {
        kind,
        frontmatter: fm,
        sections,
        span: doc_span,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_empty_document() {
        let doc = parse_document("").unwrap();
        assert_eq!(doc.kind, Some(DocumentKind::Message));
        assert!(doc.frontmatter.is_none());
        assert!(doc.sections.is_empty());
    }

    #[test]
    fn parse_message_mode_no_frontmatter() {
        let doc = parse_document("# This is a comment").unwrap();
        assert!(doc.frontmatter.is_none());
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Comment(c) => assert_eq!(c.text, "This is a comment"),
            other => panic!("expected Comment, got {:?}", other),
        }
    }

    #[test]
    fn parse_document_with_frontmatter_and_agent() {
        let input =
            "---\nkind: agent\nversion: \"1.0\"\n---\nagent ops:\n  model: opus\n  persist: true";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.kind, Some(DocumentKind::Agent));
        assert!(doc.frontmatter.is_some());
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Agent(a) => {
                assert_eq!(a.name.value, "ops");
                assert_eq!(a.properties.len(), 2);
            }
            other => panic!("expected Agent, got {:?}", other),
        }
    }

    #[test]
    fn parse_document_with_skill() {
        let input = "skill ct-deploy:\n  description: \"Deploy\"\n  tier: core";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Skill(s) => {
                assert_eq!(s.name.value, "ct-deploy");
                assert_eq!(s.properties.len(), 2);
            }
            other => panic!("expected Skill, got {:?}", other),
        }
    }

    #[test]
    fn parse_document_with_hook() {
        let input = "on SessionStart:\n  /checkin @all";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Hook(h) => assert_eq!(h.event.value, "SessionStart"),
            other => panic!("expected Hook, got {:?}", other),
        }
    }

    #[test]
    fn parse_document_with_import() {
        let input = "@import \"./agents/scanner.cant\"";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Import(i) => {
                assert_eq!(i.path, "./agents/scanner.cant");
                assert!(i.alias.is_none());
            }
            other => panic!("expected Import, got {:?}", other),
        }
    }

    #[test]
    fn parse_document_with_named_import() {
        let input = "@import scanner from \"./agents/scanner.cant\"";
        let doc = parse_document(input).unwrap();
        match &doc.sections[0] {
            Section::Import(i) => {
                assert_eq!(i.path, "./agents/scanner.cant");
                assert_eq!(i.alias, Some("scanner".to_string()));
            }
            other => panic!("expected Import, got {:?}", other),
        }
    }

    #[test]
    fn parse_document_with_binding() {
        let input = "let threshold = 42";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Binding(b) => assert_eq!(b.name.value, "threshold"),
            other => panic!("expected Binding, got {:?}", other),
        }
    }

    #[test]
    fn parse_document_with_const_binding() {
        let input = "const name = \"ops-lead\"";
        let doc = parse_document(input).unwrap();
        match &doc.sections[0] {
            Section::Binding(b) => assert_eq!(b.name.value, "name"),
            other => panic!("expected Binding, got {:?}", other),
        }
    }

    #[test]
    fn parse_multi_section_document() {
        let input = "\
---
kind: agent
---
@import \"./shared.cant\"

let default_model = \"opus\"

agent ops-lead:
  model: opus
  permissions:
    tasks: read, write

agent scanner:
  model: sonnet

on SessionStart:
  /checkin @all";

        let doc = parse_document(input).unwrap();
        assert_eq!(doc.kind, Some(DocumentKind::Agent));
        assert!(doc.frontmatter.is_some());
        // Import + Binding + 2 Agents + Hook = 5 sections
        assert_eq!(doc.sections.len(), 5);

        match &doc.sections[0] {
            Section::Import(_) => {}
            other => panic!("expected Import, got {:?}", other),
        }
        match &doc.sections[1] {
            Section::Binding(_) => {}
            other => panic!("expected Binding, got {:?}", other),
        }
        match &doc.sections[2] {
            Section::Agent(a) => assert_eq!(a.name.value, "ops-lead"),
            other => panic!("expected Agent ops-lead, got {:?}", other),
        }
        match &doc.sections[3] {
            Section::Agent(a) => assert_eq!(a.name.value, "scanner"),
            other => panic!("expected Agent scanner, got {:?}", other),
        }
        match &doc.sections[4] {
            Section::Hook(h) => assert_eq!(h.event.value, "SessionStart"),
            other => panic!("expected Hook, got {:?}", other),
        }
    }

    #[test]
    fn unknown_top_level_construct_is_error() {
        let input = "foo bar baz";
        let err = parse_document(input).unwrap_err();
        assert_eq!(err.len(), 1);
        assert!(err[0].message.contains("unexpected top-level construct"));
    }

    #[test]
    fn tab_indentation_is_error() {
        let input = "agent ops:\n\tmodel: opus";
        let err = parse_document(input).unwrap_err();
        assert!(err[0].message.contains("tabs"));
    }

    #[test]
    fn odd_indentation_is_error() {
        let input = "agent ops:\n   model: opus";
        let err = parse_document(input).unwrap_err();
        assert!(err[0].message.contains("multiple of 2"));
    }

    #[test]
    fn unclosed_frontmatter_is_error() {
        let input = "---\nkind: agent\nno closing";
        let err = parse_document(input).unwrap_err();
        assert!(err[0].message.contains("unclosed frontmatter"));
    }

    #[test]
    fn agent_with_permissions_and_hook() {
        let input = "\
agent coordinator:
  model: opus
  prompt: \"You coordinate everything\"
  permissions:
    tasks: read, write
    session: read
  on PreToolUse:
    /review @ops";

        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Agent(a) => {
                assert_eq!(a.name.value, "coordinator");
                assert_eq!(a.properties.len(), 2); // model, prompt
                assert_eq!(a.permissions.len(), 2);
                assert_eq!(a.hooks.len(), 1);
                assert_eq!(a.hooks[0].event.value, "PreToolUse");
            }
            other => panic!("expected Agent, got {:?}", other),
        }
    }

    #[test]
    fn blank_lines_between_sections() {
        let input = "agent a:\n  model: opus\n\n\nagent b:\n  model: sonnet";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 2);
    }

    #[test]
    fn comments_at_top_level() {
        let input = "# Header comment\nagent ops:\n  model: opus\n# Footer comment";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 3);
        match &doc.sections[0] {
            Section::Comment(c) => assert_eq!(c.text, "Header comment"),
            other => panic!("expected Comment, got {:?}", other),
        }
        match &doc.sections[2] {
            Section::Comment(c) => assert_eq!(c.text, "Footer comment"),
            other => panic!("expected Comment, got {:?}", other),
        }
    }

    #[test]
    fn all_frontmatter_kinds() {
        for kind_str in [
            "agent", "skill", "hook", "workflow", "pipeline", "config", "message",
        ] {
            let input = format!("---\nkind: {kind_str}\n---");
            let doc = parse_document(&input).unwrap();
            assert!(doc.frontmatter.is_some());
            assert!(doc.kind.is_some(), "kind should be parsed for {kind_str}");
        }
    }

    #[test]
    fn document_without_frontmatter_has_no_kind() {
        let input = "agent ops:\n  model: opus";
        let doc = parse_document(input).unwrap();
        assert!(doc.kind.is_none());
        assert!(doc.frontmatter.is_none());
    }

    #[test]
    fn parse_document_skill_document() {
        let input = "\
---
kind: skill
version: \"2.0\"
---
skill ct-monitor:
  description: \"Monitoring automation\"
  tier: optional
  version: \"1.2\"";

        let doc = parse_document(input).unwrap();
        assert_eq!(doc.kind, Some(DocumentKind::Skill));
        let fm = doc.frontmatter.as_ref().unwrap();
        assert_eq!(fm.version, Some("2.0".to_string()));
        assert_eq!(doc.sections.len(), 1);
    }

    // ── Layer 3: Workflow and Pipeline integration tests ─────────────

    #[test]
    fn parse_document_with_workflow() {
        let input = "workflow review:\n  /done T1234";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Workflow(wf) => {
                assert_eq!(wf.name.value, "review");
                assert_eq!(wf.body.len(), 1);
            }
            other => panic!("expected Workflow, got {:?}", other),
        }
    }

    #[test]
    fn parse_document_with_pipeline() {
        let input = "pipeline deploy:\n  step build:\n    command: \"make\"";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Pipeline(p) => {
                assert_eq!(p.name.value, "deploy");
                assert_eq!(p.steps.len(), 1);
            }
            other => panic!("expected Pipeline, got {:?}", other),
        }
    }

    #[test]
    fn parse_workflow_document_with_frontmatter() {
        let input = "\
---
kind: workflow
version: \"1.0\"
---
workflow ci(pr_url):
  session \"Analyze code\"
  if **looks good**:
    /done T1234";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.kind, Some(DocumentKind::Workflow));
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Workflow(wf) => {
                assert_eq!(wf.name.value, "ci");
                assert_eq!(wf.params.len(), 1);
                assert_eq!(wf.body.len(), 2); // session + if
            }
            other => panic!("expected Workflow, got {:?}", other),
        }
    }

    #[test]
    fn parse_pipeline_document_with_frontmatter() {
        let input = "\
---
kind: pipeline
---
pipeline build:
  step compile:
    command: \"cargo\"
    args: [\"build\"]
    timeout: 120s";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.kind, Some(DocumentKind::Pipeline));
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Pipeline(p) => {
                assert_eq!(p.steps.len(), 1);
                assert_eq!(p.steps[0].properties.len(), 3);
            }
            other => panic!("expected Pipeline, got {:?}", other),
        }
    }

    #[test]
    fn parse_document_with_workflow_and_agents() {
        let input = "\
agent ops:
  model: opus

workflow review:
  session \"Check code\"

agent scanner:
  model: sonnet";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.sections.len(), 3);
        match &doc.sections[0] {
            Section::Agent(a) => assert_eq!(a.name.value, "ops"),
            other => panic!("expected Agent, got {:?}", other),
        }
        match &doc.sections[1] {
            Section::Workflow(wf) => assert_eq!(wf.name.value, "review"),
            other => panic!("expected Workflow, got {:?}", other),
        }
        match &doc.sections[2] {
            Section::Agent(a) => assert_eq!(a.name.value, "scanner"),
            other => panic!("expected Agent, got {:?}", other),
        }
    }

    #[test]
    fn parse_mixed_document_workflow_and_pipeline() {
        let input = "\
---
kind: workflow
---
workflow review(pr):
  pipeline checks:
    step lint:
      command: \"biome\"
  session \"Review results\"";
        let doc = parse_document(input).unwrap();
        assert_eq!(doc.kind, Some(DocumentKind::Workflow));
        assert_eq!(doc.sections.len(), 1);
        match &doc.sections[0] {
            Section::Workflow(wf) => assert_eq!(wf.body.len(), 2),
            other => panic!("expected Workflow, got {:?}", other),
        }
    }
}
