//! Workflow definition parser for the CANT DSL.
//!
//! Parses `workflow Name(params):` blocks. The body contains statements
//! including sessions, parallel blocks, conditionals, loops, try/catch,
//! approval gates, and inline pipelines.
//!
//! ```cant
//! workflow review(pr_url):
//!   session "Analyze the code"
//!   if **code quality acceptable**:
//!     /done T{pr.task_id}
//!   else:
//!     /action @author "Address issues"
//! ```

use super::ast::{Spanned, WorkflowDef};
use super::error::ParseError;
use super::indent::{IndentedLine, collect_block};
use super::pipeline::parse_name_and_params;
use super::span::Span;
use super::statement::parse_statement_block;

/// Parses a `workflow Name:` or `workflow Name(params):` block starting at the given line index.
///
/// Returns the parsed [`WorkflowDef`] and the number of lines consumed.
pub fn parse_workflow_block(
    lines: &[IndentedLine<'_>],
    start_idx: usize,
) -> Result<(WorkflowDef, usize), ParseError> {
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

    let after_workflow = content
        .strip_prefix("workflow ")
        .ok_or_else(|| ParseError::error("expected `workflow Name:`", header_span))?;

    let before_colon = after_workflow.strip_suffix(':').ok_or_else(|| {
        ParseError::error(
            "expected `:` after workflow name, e.g. `workflow review:`",
            header_span,
        )
    })?;

    let (name_str, params) =
        parse_name_and_params(before_colon, base_offset + "workflow ".len(), header)?;

    if name_str.is_empty() {
        return Err(ParseError::error("empty workflow name", header_span));
    }

    let name_offset = base_offset + "workflow ".len();
    let name = Spanned {
        value: name_str.to_string(),
        span: Span::new(
            name_offset,
            name_offset + name_str.len(),
            header.line_number,
            col + "workflow ".len() as u32,
        ),
    };

    // Collect the indented body block
    let body_lines = collect_block(lines, start_idx + 1, header.indent);
    let body = parse_statement_block(body_lines)?;
    let total_consumed = 1 + body_lines.len();

    let end_offset = if body_lines.is_empty() {
        base_offset + content.len()
    } else {
        let last = &body_lines[body_lines.len() - 1];
        last.byte_offset + last.indent + last.content.len()
    };

    let workflow = WorkflowDef {
        name,
        params,
        body,
        span: Span::new(base_offset, end_offset, header.line_number, col),
    };

    Ok((workflow, total_consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::ast::Statement;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_simple_workflow() {
        let input = "workflow review:\n  /done T1234";
        let lines = split_lines(input).unwrap();
        let (wf, consumed) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
        assert_eq!(wf.name.value, "review");
        assert!(wf.params.is_empty());
        assert_eq!(wf.body.len(), 1);
    }

    #[test]
    fn parse_workflow_with_params() {
        let input = "workflow review(pr_url, env):\n  /done T1234";
        let lines = split_lines(input).unwrap();
        let (wf, _) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(wf.name.value, "review");
        assert_eq!(wf.params.len(), 2);
        assert_eq!(wf.params[0].name.value, "pr_url");
        assert_eq!(wf.params[1].name.value, "env");
    }

    #[test]
    fn parse_workflow_with_session() {
        let input = "workflow analyze:\n  session \"Analyze the code\"";
        let lines = split_lines(input).unwrap();
        let (wf, consumed) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
        assert_eq!(wf.body.len(), 1);
        match &wf.body[0] {
            Statement::Session(_) => {}
            other => panic!("expected Session, got {:?}", other),
        }
    }

    #[test]
    fn parse_workflow_with_conditional() {
        let input = "workflow check:\n  if status == \"done\":\n    /done T1234";
        let lines = split_lines(input).unwrap();
        let (wf, consumed) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        match &wf.body[0] {
            Statement::Conditional(_) => {}
            other => panic!("expected Conditional, got {:?}", other),
        }
    }

    #[test]
    fn parse_workflow_with_try_catch() {
        let input = "workflow deploy:\n  try:\n    /done T1\n  catch err:\n    /info @ops \"fail\"";
        let lines = split_lines(input).unwrap();
        let (wf, consumed) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(consumed, 5);
        match &wf.body[0] {
            Statement::TryCatch(_) => {}
            other => panic!("expected TryCatch, got {:?}", other),
        }
    }

    #[test]
    fn parse_workflow_empty_body() {
        let input = "workflow empty:";
        let lines = split_lines(input).unwrap();
        let (wf, consumed) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(consumed, 1);
        assert!(wf.body.is_empty());
    }

    #[test]
    fn parse_workflow_with_binding() {
        let input = "workflow process:\n  let x = 42\n  /done T1234";
        let lines = split_lines(input).unwrap();
        let (wf, _) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(wf.body.len(), 2);
        match &wf.body[0] {
            Statement::Binding(_) => {}
            other => panic!("expected Binding, got {:?}", other),
        }
    }

    #[test]
    fn parse_workflow_with_repeat() {
        let input = "workflow retry:\n  repeat 3:\n    /info @all \"retrying\"";
        let lines = split_lines(input).unwrap();
        let (wf, consumed) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        match &wf.body[0] {
            Statement::Repeat(_) => {}
            other => panic!("expected Repeat, got {:?}", other),
        }
    }

    #[test]
    fn parse_workflow_with_for_loop() {
        let input = "workflow batch:\n  for task in tasks:\n    /done task";
        let lines = split_lines(input).unwrap();
        let (wf, consumed) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        match &wf.body[0] {
            Statement::ForLoop(_) => {}
            other => panic!("expected ForLoop, got {:?}", other),
        }
    }

    #[test]
    fn parse_workflow_with_parallel() {
        let input = "workflow review:\n  parallel:\n    a = session \"Check A\"\n    b = session \"Check B\"";
        let lines = split_lines(input).unwrap();
        let (wf, consumed) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match &wf.body[0] {
            Statement::Parallel(_) => {}
            other => panic!("expected Parallel, got {:?}", other),
        }
    }

    #[test]
    fn parse_workflow_with_approval() {
        let input = "workflow deploy:\n  approve:\n    message: \"Ready to ship?\"";
        let lines = split_lines(input).unwrap();
        let (wf, consumed) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
        match &wf.body[0] {
            Statement::ApprovalGate(_) => {}
            other => panic!("expected ApprovalGate, got {:?}", other),
        }
    }

    #[test]
    fn reject_missing_colon() {
        let input = "workflow review\n  /done T1";
        let lines = split_lines(input).unwrap();
        let err = parse_workflow_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("`:`"));
    }

    #[test]
    fn reject_empty_name() {
        let input = "workflow :";
        let lines = split_lines(input).unwrap();
        let err = parse_workflow_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty workflow name"));
    }

    #[test]
    fn parse_workflow_single_param() {
        let input = "workflow deploy(env):\n  /done T1";
        let lines = split_lines(input).unwrap();
        let (wf, _) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(wf.params.len(), 1);
        assert_eq!(wf.params[0].name.value, "env");
    }

    #[test]
    fn parse_workflow_with_output() {
        let input = "workflow review:\n  output verdict = \"approve\"";
        let lines = split_lines(input).unwrap();
        let (wf, _) = parse_workflow_block(&lines, 0).unwrap();
        match &wf.body[0] {
            Statement::Output(_) => {}
            other => panic!("expected Output, got {:?}", other),
        }
    }

    #[test]
    fn span_covers_workflow() {
        let input = "workflow review:\n  /done T1";
        let lines = split_lines(input).unwrap();
        let (wf, _) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(wf.span.start, 0);
        assert_eq!(wf.span.line, 1);
    }

    #[test]
    fn workflow_followed_by_other_section() {
        let input = "workflow w:\n  /done T1\nagent a:\n  model: opus";
        let lines = split_lines(input).unwrap();
        let (_, consumed) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(consumed, 2);
    }

    #[test]
    fn parse_workflow_with_inline_pipeline() {
        let input = "workflow ci:\n  pipeline checks:\n    step lint:\n      command: \"biome\"";
        let lines = split_lines(input).unwrap();
        let (wf, consumed) = parse_workflow_block(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        match &wf.body[0] {
            Statement::Pipeline(_) => {}
            other => panic!("expected Pipeline, got {:?}", other),
        }
    }
}
