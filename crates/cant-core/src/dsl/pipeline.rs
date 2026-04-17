//! Pipeline definition parser for the CANT DSL.
//!
//! Parses `pipeline Name:` blocks containing ONLY `step` definitions.
//! Pipelines are deterministic -- no sessions, no discretion, no approval gates.
//!
//! ```cant
//! pipeline deploy(service):
//!   step build:
//!     command: "pnpm"
//!     args: ["run", "build"]
//!     timeout: 120s
//!
//!   step test:
//!     command: "pnpm"
//!     args: ["run", "test"]
//!     timeout: 300s
//! ```

use super::ast::{ParamDef, PipeStep, PipelineDef, Spanned};
use super::error::ParseError;
use super::indent::{IndentedLine, collect_block};
use super::property::parse_property;
use super::span::Span;

/// Parses a `pipeline Name:` or `pipeline Name(params):` block starting at the given line index.
///
/// Returns the parsed [`PipelineDef`] and the number of lines consumed.
///
/// # Errors
///
/// Returns [`ParseError`] if the pipeline header or any step body is malformed.
pub fn parse_pipeline_block(
    lines: &[IndentedLine<'_>],
    start_idx: usize,
) -> Result<(PipelineDef, usize), ParseError> {
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

    let after_pipeline = content
        .strip_prefix("pipeline ")
        .ok_or_else(|| ParseError::error("expected `pipeline Name:`", header_span))?;

    let before_colon = after_pipeline.strip_suffix(':').ok_or_else(|| {
        ParseError::error(
            "expected `:` after pipeline name, e.g. `pipeline deploy:`",
            header_span,
        )
    })?;

    // Parse name and optional params
    let (name_str, params) =
        parse_name_and_params(before_colon, base_offset + "pipeline ".len(), header)?;

    if name_str.is_empty() {
        return Err(ParseError::error("empty pipeline name", header_span));
    }

    let name_offset = base_offset + "pipeline ".len();
    let name = Spanned {
        value: name_str.to_string(),
        span: Span::new(
            name_offset,
            name_offset + name_str.len(),
            header.line_number,
            col + "pipeline ".len() as u32,
        ),
    };

    // Collect the indented body block
    let body_lines = collect_block(lines, start_idx + 1, header.indent);
    let total_consumed = 1 + body_lines.len();

    let mut steps = Vec::new();
    let mut i = 0;

    while i < body_lines.len() {
        let line = &body_lines[i];

        if line.is_blank() || line.is_comment() {
            i += 1;
            continue;
        }

        if line.content.starts_with("step ") {
            let (step, step_consumed) = parse_pipe_step(body_lines, i)?;
            steps.push(step);
            i += step_consumed;
            continue;
        }

        let line_offset = line.byte_offset + line.indent;
        return Err(ParseError::error(
            format!(
                "unexpected content in pipeline body: `{}`; pipelines may only contain `step` definitions",
                line.content
            ),
            Span::new(
                line_offset,
                line_offset + line.content.len(),
                line.line_number,
                (line.indent as u32) + 1,
            ),
        ));
    }

    let end_offset = if body_lines.is_empty() {
        base_offset + content.len()
    } else {
        let last = &body_lines[body_lines.len() - 1];
        last.byte_offset + last.indent + last.content.len()
    };

    let pipeline = PipelineDef {
        name,
        params,
        steps,
        span: Span::new(base_offset, end_offset, header.line_number, col),
    };

    Ok((pipeline, total_consumed))
}

/// Parses a `step Name:` block within a pipeline.
///
/// Returns the parsed [`PipeStep`] and the number of lines consumed.
///
/// # Errors
///
/// Returns [`ParseError`] if the step header or properties are malformed.
pub fn parse_pipe_step(
    lines: &[IndentedLine<'_>],
    start_idx: usize,
) -> Result<(PipeStep, usize), ParseError> {
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

    let after_step = content
        .strip_prefix("step ")
        .ok_or_else(|| ParseError::error("expected `step Name:`", header_span))?;

    let step_name = after_step
        .strip_suffix(':')
        .ok_or_else(|| {
            ParseError::error(
                "expected `:` after step name, e.g. `step build:`",
                header_span,
            )
        })?
        .trim();

    if step_name.is_empty() {
        return Err(ParseError::error("empty step name", header_span));
    }

    let name_offset = base_offset + "step ".len();
    let name = Spanned {
        value: step_name.to_string(),
        span: Span::new(
            name_offset,
            name_offset + step_name.len(),
            header.line_number,
            col + "step ".len() as u32,
        ),
    };

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

    let step = PipeStep {
        name,
        properties,
        span: Span::new(base_offset, end_offset, header.line_number, col),
    };

    Ok((step, total_consumed))
}

/// Parses a name and optional parameter list from `"Name(p1, p2)"` or just `"Name"`.
///
/// # Errors
///
/// Returns [`ParseError`] if the name or parameter syntax is invalid.
pub fn parse_name_and_params<'a>(
    input: &'a str,
    base_offset: usize,
    header: &IndentedLine<'_>,
) -> Result<(&'a str, Vec<ParamDef>), ParseError> {
    let input = input.trim();

    if let Some(paren_start) = input.find('(') {
        let name = &input[..paren_start];

        if !input.ends_with(')') {
            let col = (header.indent as u32) + 1;
            return Err(ParseError::error(
                "unclosed parameter list",
                Span::new(
                    base_offset,
                    base_offset + input.len(),
                    header.line_number,
                    col,
                ),
            ));
        }

        let params_str = &input[paren_start + 1..input.len() - 1];
        let params = parse_param_list(params_str, base_offset + paren_start + 1, header)?;

        Ok((name, params))
    } else {
        Ok((input, Vec::new()))
    }
}

/// Parses a comma-separated parameter list.
fn parse_param_list(
    input: &str,
    base_offset: usize,
    header: &IndentedLine<'_>,
) -> Result<Vec<ParamDef>, ParseError> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(Vec::new());
    }

    let parts: Vec<&str> = input.split(',').collect();
    let mut params = Vec::new();
    let col = (header.indent as u32) + 1;

    for part in parts {
        let param_name = part.trim();
        if param_name.is_empty() {
            continue;
        }

        // For now, params are simple names. Type annotations and defaults
        // would be added in a later phase.
        let param_offset = base_offset; // approximate
        params.push(ParamDef {
            name: Spanned {
                value: param_name.to_string(),
                span: Span::new(
                    param_offset,
                    param_offset + param_name.len(),
                    header.line_number,
                    col,
                ),
            },
            span: Span::new(
                param_offset,
                param_offset + param_name.len(),
                header.line_number,
                col,
            ),
        });
    }

    Ok(params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::ast::Value;
    use crate::dsl::indent::split_lines;

    #[test]
    fn parse_simple_pipeline() {
        let input = "pipeline deploy:\n  step build:\n    command: \"pnpm\"\n    args: [\"run\", \"build\"]";
        let lines = split_lines(input).unwrap();
        let (pipeline, consumed) = parse_pipeline_block(&lines, 0).unwrap();
        assert_eq!(consumed, 4);
        assert_eq!(pipeline.name.value, "deploy");
        assert!(pipeline.params.is_empty());
        assert_eq!(pipeline.steps.len(), 1);
        assert_eq!(pipeline.steps[0].name.value, "build");
        assert_eq!(pipeline.steps[0].properties.len(), 2);
    }

    #[test]
    fn parse_pipeline_with_params() {
        let input = "pipeline deploy(service, env):\n  step build:\n    command: \"make\"";
        let lines = split_lines(input).unwrap();
        let (pipeline, _) = parse_pipeline_block(&lines, 0).unwrap();
        assert_eq!(pipeline.name.value, "deploy");
        assert_eq!(pipeline.params.len(), 2);
        assert_eq!(pipeline.params[0].name.value, "service");
        assert_eq!(pipeline.params[1].name.value, "env");
    }

    #[test]
    fn parse_pipeline_multiple_steps() {
        let input = "pipeline ci:\n  step lint:\n    command: \"biome\"\n    timeout: 30s\n  step test:\n    command: \"pnpm\"\n    args: [\"test\"]";
        let lines = split_lines(input).unwrap();
        let (pipeline, consumed) = parse_pipeline_block(&lines, 0).unwrap();
        assert_eq!(consumed, 7);
        assert_eq!(pipeline.steps.len(), 2);
        assert_eq!(pipeline.steps[0].name.value, "lint");
        assert_eq!(pipeline.steps[1].name.value, "test");
    }

    #[test]
    fn parse_pipeline_step_with_all_properties() {
        let input = "pipeline ci:\n  step test:\n    command: \"pnpm\"\n    args: [\"test\"]\n    stdin: lint\n    timeout: 300s\n    condition: lint.exitCode == 0";
        let lines = split_lines(input).unwrap();
        let (pipeline, _) = parse_pipeline_block(&lines, 0).unwrap();
        assert_eq!(pipeline.steps[0].properties.len(), 5);
    }

    #[test]
    fn parse_pipeline_empty_body() {
        let input = "pipeline empty:";
        let lines = split_lines(input).unwrap();
        let (pipeline, consumed) = parse_pipeline_block(&lines, 0).unwrap();
        assert_eq!(consumed, 1);
        assert!(pipeline.steps.is_empty());
    }

    #[test]
    fn reject_non_step_in_pipeline() {
        let input = "pipeline bad:\n  let x = 1";
        let lines = split_lines(input).unwrap();
        let err = parse_pipeline_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("step"));
    }

    #[test]
    fn reject_missing_colon() {
        let input = "pipeline deploy\n  step build:";
        let lines = split_lines(input).unwrap();
        let err = parse_pipeline_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("`:`"));
    }

    #[test]
    fn reject_empty_name() {
        let input = "pipeline :";
        let lines = split_lines(input).unwrap();
        let err = parse_pipeline_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty pipeline name"));
    }

    #[test]
    fn reject_step_empty_name() {
        let input = "pipeline ci:\n  step :";
        let lines = split_lines(input).unwrap();
        let err = parse_pipeline_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("empty step name"));
    }

    #[test]
    fn reject_step_missing_colon() {
        let input = "pipeline ci:\n  step build\n    command: \"make\"";
        let lines = split_lines(input).unwrap();
        let err = parse_pipeline_block(&lines, 0).unwrap_err();
        assert!(err.message.contains("`:`"));
    }

    #[test]
    fn parse_pipeline_with_blank_lines() {
        let input = "pipeline ci:\n  step a:\n    command: \"a\"\n\n  step b:\n    command: \"b\"";
        let lines = split_lines(input).unwrap();
        let (pipeline, consumed) = parse_pipeline_block(&lines, 0).unwrap();
        assert_eq!(consumed, 6);
        assert_eq!(pipeline.steps.len(), 2);
    }

    #[test]
    fn parse_step_timeout_is_duration() {
        let input = "pipeline p:\n  step s:\n    command: \"x\"\n    timeout: 60s";
        let lines = split_lines(input).unwrap();
        let (pipeline, _) = parse_pipeline_block(&lines, 0).unwrap();
        let timeout = pipeline.steps[0]
            .properties
            .iter()
            .find(|p| p.key.value == "timeout")
            .unwrap();
        match &timeout.value {
            Value::Duration(d) => assert_eq!(d.amount, 60),
            other => panic!("expected Duration, got {other:?}"),
        }
    }

    #[test]
    fn span_covers_pipeline() {
        let input = "pipeline deploy:\n  step build:\n    command: \"make\"";
        let lines = split_lines(input).unwrap();
        let (pipeline, _) = parse_pipeline_block(&lines, 0).unwrap();
        assert_eq!(pipeline.span.start, 0);
        assert_eq!(pipeline.span.line, 1);
    }

    #[test]
    fn pipeline_followed_by_other_section() {
        let input = "pipeline p:\n  step s:\n    command: \"x\"\nagent a:\n  model: opus";
        let lines = split_lines(input).unwrap();
        let (_, consumed) = parse_pipeline_block(&lines, 0).unwrap();
        assert_eq!(consumed, 3);
    }

    #[test]
    fn parse_pipeline_single_param() {
        let input = "pipeline deploy(env):\n  step build:\n    command: \"make\"";
        let lines = split_lines(input).unwrap();
        let (pipeline, _) = parse_pipeline_block(&lines, 0).unwrap();
        assert_eq!(pipeline.params.len(), 1);
        assert_eq!(pipeline.params[0].name.value, "env");
    }

    #[test]
    fn step_with_comment_lines() {
        let input = "pipeline p:\n  step s:\n    # build step\n    command: \"make\"";
        let lines = split_lines(input).unwrap();
        let (pipeline, _) = parse_pipeline_block(&lines, 0).unwrap();
        assert_eq!(pipeline.steps[0].properties.len(), 1);
    }
}
