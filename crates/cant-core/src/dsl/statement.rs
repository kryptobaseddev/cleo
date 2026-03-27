//! Statement parser for the CANT DSL (Layer 2 + Layer 3).
//!
//! Parses individual statements that appear in hook, workflow, and other block bodies.
//! This module recognizes both Layer 2 (bindings, directives, expressions, properties)
//! and Layer 3 (sessions, parallel, conditionals, loops, try/catch, approval, output)
//! statement types.

use super::ast::{Comment, LetBinding, OutputStmt, Spanned, Statement};
use super::error::ParseError;
use super::expression::parse_expression;
use super::indent::IndentedLine;
use super::property::parse_property;
use super::span::Span;

/// Parses a block of indented lines into a vector of statements.
///
/// This is the primary entry point used by workflow, conditional, loop, and
/// try/catch parsers to parse their body blocks.
pub fn parse_statement_block(lines: &[IndentedLine<'_>]) -> Result<Vec<Statement>, ParseError> {
    let mut stmts = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let line = &lines[i];

        if line.is_blank() {
            i += 1;
            continue;
        }

        let content = line.content;

        // Comment
        if content.starts_with('#') {
            let base_offset = line.byte_offset + line.indent;
            stmts.push(Statement::Comment(Comment {
                text: content[1..].trim().to_string(),
                span: Span::new(
                    base_offset,
                    base_offset + content.len(),
                    line.line_number,
                    (line.indent as u32) + 1,
                ),
            }));
            i += 1;
            continue;
        }

        // Session statement
        if content.starts_with("session ") || content.starts_with("session:") {
            let (stmt, consumed) = super::session::parse_session_stmt(lines, i)?;
            stmts.push(stmt);
            i += consumed;
            continue;
        }

        // Parallel block
        if content == "parallel:" || content == "parallel race:" || content == "parallel settle:" {
            let (stmt, consumed) = super::parallel::parse_parallel_block(lines, i)?;
            stmts.push(stmt);
            i += consumed;
            continue;
        }

        // If conditional
        if content.starts_with("if ") {
            let (stmt, consumed) = super::conditional::parse_conditional(lines, i)?;
            stmts.push(stmt);
            i += consumed;
            continue;
        }

        // Repeat loop
        if content.starts_with("repeat ") {
            let (stmt, consumed) = super::loop_::parse_repeat(lines, i)?;
            stmts.push(stmt);
            i += consumed;
            continue;
        }

        // For loop
        if content.starts_with("for ") && content.contains(" in ") {
            let (stmt, consumed) = super::loop_::parse_for_loop(lines, i)?;
            stmts.push(stmt);
            i += consumed;
            continue;
        }

        // Loop until
        if content == "loop:" {
            let (stmt, consumed) = super::loop_::parse_loop_until(lines, i)?;
            stmts.push(stmt);
            i += consumed;
            continue;
        }

        // Try/catch/finally
        if content == "try:" {
            let (stmt, consumed) = super::try_catch::parse_try_catch(lines, i)?;
            stmts.push(stmt);
            i += consumed;
            continue;
        }

        // Approval gate
        if content == "approve:" {
            let (stmt, consumed) = super::approval::parse_approval_gate(lines, i)?;
            stmts.push(stmt);
            i += consumed;
            continue;
        }

        // Inline pipeline
        if content.starts_with("pipeline ") && content.ends_with(':') {
            let (pipeline_def, consumed) = super::pipeline::parse_pipeline_block(lines, i)?;
            stmts.push(Statement::Pipeline(pipeline_def));
            i += consumed;
            continue;
        }

        // Inline pipe step (inside a workflow that has inline pipeline context)
        if content.starts_with("step ") && content.ends_with(':') {
            let (step, consumed) = super::pipeline::parse_pipe_step(lines, i)?;
            stmts.push(Statement::PipeStep(step));
            i += consumed;
            continue;
        }

        // Output binding: output name = expr
        if content.starts_with("output ") {
            let (stmt, consumed) = parse_output_stmt(line)?;
            stmts.push(stmt);
            i += consumed;
            continue;
        }

        // Directive: /verb ...
        if content.starts_with('/') {
            let stmt = parse_directive_stmt(line)?;
            stmts.push(stmt);
            i += 1;
            continue;
        }

        // Let/const binding: let name = expr
        if content.starts_with("let ") || content.starts_with("const ") {
            let stmt = parse_binding_stmt(line)?;
            stmts.push(stmt);
            i += 1;
            continue;
        }

        // Property: key: value (if it contains a colon that's not inside quotes)
        if contains_property_colon(content) {
            let prop = parse_property(line)?;
            stmts.push(Statement::Property(prop));
            i += 1;
            continue;
        }

        // Bare expression
        let base_offset = line.byte_offset + line.indent;
        let col = (line.indent as u32) + 1;
        let expr = parse_expression(content, base_offset, line.line_number, col)?;
        stmts.push(Statement::Expression(expr));
        i += 1;
    }

    Ok(stmts)
}

/// Parses an `output name = expression` statement.
fn parse_output_stmt(line: &IndentedLine<'_>) -> Result<(Statement, usize), ParseError> {
    let content = line.content;
    let base_offset = line.byte_offset + line.indent;
    let col = (line.indent as u32) + 1;
    let stmt_span = Span::new(
        base_offset,
        base_offset + content.len(),
        line.line_number,
        col,
    );

    let after_output = content
        .strip_prefix("output ")
        .ok_or_else(|| ParseError::error("expected `output name = expression`", stmt_span))?;

    let eq_pos = after_output.find(" = ").ok_or_else(|| {
        ParseError::error(
            "expected `=` in output binding, e.g. `output verdict = \"approve\"`",
            stmt_span,
        )
    })?;

    let name = after_output[..eq_pos].trim();
    let expr_str = after_output[eq_pos + 3..].trim();

    if name.is_empty() {
        return Err(ParseError::error("empty output name", stmt_span));
    }

    if expr_str.is_empty() {
        return Err(ParseError::error("empty output expression", stmt_span));
    }

    let name_offset = base_offset + "output ".len();
    let name_spanned = Spanned {
        value: name.to_string(),
        span: Span::new(
            name_offset,
            name_offset + name.len(),
            line.line_number,
            col + "output ".len() as u32,
        ),
    };

    let expr_offset = name_offset + eq_pos + 3;
    let value = parse_expression(expr_str, expr_offset, line.line_number, col)?;

    let output = OutputStmt {
        name: name_spanned,
        value,
        span: stmt_span,
    };

    Ok((Statement::Output(output), 1))
}

/// Parses a `/verb @addr T1234 #tag argument` directive statement.
fn parse_directive_stmt(line: &IndentedLine<'_>) -> Result<Statement, ParseError> {
    use super::ast::DirectiveStmt;

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
    fn parse_empty_block() {
        let stmts = parse_statement_block(&[]).unwrap();
        assert!(stmts.is_empty());
    }

    #[test]
    fn parse_block_with_directive() {
        let input = "  /done T1234";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::Directive(d) => assert_eq!(d.verb, "done"),
            other => panic!("expected Directive, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_with_binding() {
        let input = "  let x = 42";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::Binding(b) => assert_eq!(b.name.value, "x"),
            other => panic!("expected Binding, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_with_comment() {
        let input = "  # a comment";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::Comment(c) => assert_eq!(c.text, "a comment"),
            other => panic!("expected Comment, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_with_output() {
        let input = "  output verdict = \"approve\"";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::Output(o) => assert_eq!(o.name.value, "verdict"),
            other => panic!("expected Output, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_with_session() {
        let input = "  session \"Do something\"";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::Session(_) => {}
            other => panic!("expected Session, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_with_property() {
        let input = "  model: opus";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::Property(p) => assert_eq!(p.key.value, "model"),
            other => panic!("expected Property, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_mixed_statements() {
        let input = "  let x = 1\n  # comment\n  /done T1234\n  output result = x";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 4);
    }

    #[test]
    fn parse_block_skips_blanks() {
        let input = "  /done T1\n\n  /done T2";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 2);
    }

    #[test]
    fn parse_output_empty_name_error() {
        let input = "  output  = 42";
        let lines = split_lines(input).unwrap();
        let err = parse_statement_block(&lines).unwrap_err();
        assert!(err.message.contains("empty output name"));
    }

    #[test]
    fn parse_output_empty_expr_error() {
        // Trailing whitespace is trimmed by split_lines, so "output name = "
        // becomes "output name =" which fails to find " = " pattern.
        // Use a property-like fallback: "output name =" triggers the `=` error.
        let input = "  output name =";
        let lines = split_lines(input).unwrap();
        let err = parse_statement_block(&lines).unwrap_err();
        assert!(err.message.contains("="));
    }

    #[test]
    fn parse_block_with_approval() {
        let input = "  approve:\n    message: \"Ready?\"";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::ApprovalGate(_) => {}
            other => panic!("expected ApprovalGate, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_with_try() {
        let input = "  try:\n    /done T1\n  catch:\n    /info @a \"b\"";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::TryCatch(_) => {}
            other => panic!("expected TryCatch, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_with_parallel() {
        let input = "  parallel:\n    a = session \"A\"\n    b = session \"B\"";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::Parallel(_) => {}
            other => panic!("expected Parallel, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_with_repeat() {
        let input = "  repeat 3:\n    /done T1";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::Repeat(_) => {}
            other => panic!("expected Repeat, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_with_for_loop() {
        let input = "  for x in items:\n    /done x";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::ForLoop(_) => {}
            other => panic!("expected ForLoop, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_with_conditional() {
        let input = "  if x == 1:\n    /done T1";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::Conditional(_) => {}
            other => panic!("expected Conditional, got {:?}", other),
        }
    }

    #[test]
    fn parse_block_with_inline_pipeline() {
        let input = "  pipeline checks:\n    step lint:\n      command: \"biome\"";
        let lines = split_lines(input).unwrap();
        let stmts = parse_statement_block(&lines).unwrap();
        assert_eq!(stmts.len(), 1);
        match &stmts[0] {
            Statement::Pipeline(_) => {}
            other => panic!("expected Pipeline, got {:?}", other),
        }
    }
}
