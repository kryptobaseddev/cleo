//! Type validation rules T04--T07.
//!
//! T04: Context references resolve to defined agents/skills.
//! T05: Parallel arm context references exist.
//! T06: Approval gate message evaluates to string.
//! T07: No nested interpolation.

use crate::dsl::ast::{CantDocument, Expression, Section, Statement, StringSegment, Value};

use super::helpers::{contains_interpolation, is_value_string_like};
use crate::validate::context::ValidationContext;
use crate::validate::diagnostic::Diagnostic;

// ── T04: Context references resolve to defined agents/skills ────────

/// T04: Context array references MUST resolve to defined agents or skills.
pub(super) fn check_t04_context_references(
    doc: &CantDocument,
    ctx: &ValidationContext,
) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        if let Section::Workflow(wf) = section {
            check_context_refs_in_stmts(&wf.body, ctx, &mut diags);
        }
    }
    diags
}

/// Check context property values for unresolved references.
fn check_context_refs_in_stmts(
    stmts: &[Statement],
    ctx: &ValidationContext,
    diags: &mut Vec<Diagnostic>,
) {
    for stmt in stmts {
        match stmt {
            Statement::Session(sess) => {
                for prop in &sess.properties {
                    if prop.key.value == "context" {
                        check_context_value(&prop.value, prop.span, ctx, diags);
                    }
                }
            }
            Statement::Conditional(cond) => {
                check_context_refs_in_stmts(&cond.then_body, ctx, diags);
                for elif in &cond.elif_branches {
                    check_context_refs_in_stmts(&elif.body, ctx, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_context_refs_in_stmts(else_body, ctx, diags);
                }
            }
            Statement::Repeat(r) => check_context_refs_in_stmts(&r.body, ctx, diags),
            Statement::ForLoop(f) => check_context_refs_in_stmts(&f.body, ctx, diags),
            Statement::LoopUntil(l) => check_context_refs_in_stmts(&l.body, ctx, diags),
            Statement::TryCatch(tc) => {
                check_context_refs_in_stmts(&tc.try_body, ctx, diags);
                if let Some(cb) = &tc.catch_body {
                    check_context_refs_in_stmts(cb, ctx, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_context_refs_in_stmts(fb, ctx, diags);
                }
            }
            _ => {}
        }
    }
}

/// Check a context value for unresolved identifier references.
fn check_context_value(
    value: &Value,
    span: crate::dsl::span::Span,
    ctx: &ValidationContext,
    diags: &mut Vec<Diagnostic>,
) {
    match value {
        Value::Array(elements) => {
            for elem in elements {
                check_context_value(elem, span, ctx, diags);
            }
        }
        Value::Identifier(name) => {
            if !ctx.is_name_defined(name) {
                diags.push(Diagnostic::warning(
                    "T04",
                    format!(
                        "Context reference '{}' at line {} does not resolve to a defined agent, skill, or binding.",
                        name, span.line
                    ),
                    span,
                ));
            }
        }
        _ => {}
    }
}

// ── T05: Parallel arm context references exist ──────────────────────

/// T05: Parallel arm context references MUST refer to existing arms
/// within the same parallel block.
pub(super) fn check_t05_parallel_arm_refs(
    doc: &CantDocument,
    _ctx: &ValidationContext,
) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        if let Section::Workflow(wf) = section {
            check_parallel_arm_context_in_stmts(&wf.body, &mut diags);
        }
    }
    diags
}

/// Recursively check parallel blocks for arm context references.
fn check_parallel_arm_context_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        if let Statement::Parallel(block) = stmt {
            // Collect arm names in this block
            let arm_names: Vec<&str> = block.arms.iter().map(|a| a.name.as_str()).collect();

            // Check each arm's body for context references to other arms
            for arm in &block.arms {
                check_arm_body_context_refs(&arm.body, &arm_names, &arm.name, diags);
            }
        }

        // Recurse into nested structures
        match stmt {
            Statement::Conditional(cond) => {
                check_parallel_arm_context_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_parallel_arm_context_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_parallel_arm_context_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_parallel_arm_context_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_parallel_arm_context_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_parallel_arm_context_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_parallel_arm_context_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_parallel_arm_context_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_parallel_arm_context_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

/// Check an arm's body statement for context property references to other arms.
fn check_arm_body_context_refs(
    body: &Statement,
    arm_names: &[&str],
    current_arm: &str,
    diags: &mut Vec<Diagnostic>,
) {
    if let Statement::Session(sess) = body {
        for prop in &sess.properties {
            if prop.key.value == "context" {
                check_arm_context_value(&prop.value, arm_names, current_arm, prop.span, diags);
            }
        }
    }
}

/// Check a context value for arm references that don't exist in the parallel block.
fn check_arm_context_value(
    value: &Value,
    arm_names: &[&str],
    current_arm: &str,
    span: crate::dsl::span::Span,
    diags: &mut Vec<Diagnostic>,
) {
    match value {
        Value::Identifier(name) => {
            // Only check references that look like they could be arm names
            // (not built-in references like "active-tasks")
            if !name.contains('-') && !arm_names.contains(&name.as_str()) {
                diags.push(Diagnostic::warning(
                    "T05",
                    format!(
                        "Parallel arm '{}' references context '{}' at line {} which is not a sibling arm. Available arms: {}.",
                        current_arm,
                        name,
                        span.line,
                        arm_names.join(", ")
                    ),
                    span,
                ));
            }
        }
        Value::Array(elements) => {
            for elem in elements {
                check_arm_context_value(elem, arm_names, current_arm, span, diags);
            }
        }
        _ => {}
    }
}

// ── T06: Approval gate message evaluates to string ──────────────────

/// T06: Approval gate `message` property MUST evaluate to a string.
pub(super) fn check_t06_approval_message_type(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        if let Section::Workflow(wf) = section {
            check_approval_messages_in_stmts(&wf.body, &mut diags);
        }
    }
    diags
}

/// Recursively check approval gate messages in statements.
fn check_approval_messages_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::ApprovalGate(gate) => {
                for prop in &gate.properties {
                    if prop.key.value == "message" {
                        if !is_value_string_like(&prop.value) {
                            diags.push(Diagnostic::error(
                                "T06",
                                format!(
                                    "Approval gate message at line {} must evaluate to a string.",
                                    prop.span.line
                                ),
                                prop.span,
                            ));
                        }
                    }
                }
            }
            Statement::Conditional(cond) => {
                check_approval_messages_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_approval_messages_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_approval_messages_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_approval_messages_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_approval_messages_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_approval_messages_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_approval_messages_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_approval_messages_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_approval_messages_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

// ── T07: Single-pass interpolation ──────────────────────────────────

/// T07: Interpolated values MUST NOT contain nested `${` sequences.
/// CANT uses single-pass interpolation: the result of `${expr}` is NOT
/// re-evaluated for further interpolation.
pub(super) fn check_t07_no_nested_interpolation(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        match section {
            Section::Workflow(wf) => check_nested_interp_in_stmts(&wf.body, &mut diags),
            Section::Hook(hook) => check_nested_interp_in_stmts(&hook.body, &mut diags),
            Section::Agent(agent) => {
                for hook in &agent.hooks {
                    check_nested_interp_in_stmts(&hook.body, &mut diags);
                }
            }
            _ => {}
        }
    }
    diags
}

/// Recursively check for nested interpolation in statements.
fn check_nested_interp_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::Expression(expr) => check_nested_interp_in_expr(expr, diags),
            Statement::Binding(b) => check_nested_interp_in_expr(&b.value, diags),
            Statement::Output(out) => check_nested_interp_in_expr(&out.value, diags),
            Statement::Conditional(cond) => {
                check_nested_interp_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_nested_interp_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_nested_interp_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_nested_interp_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_nested_interp_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_nested_interp_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_nested_interp_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_nested_interp_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_nested_interp_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

/// Check for nested interpolation within expressions.
fn check_nested_interp_in_expr(expr: &Expression, diags: &mut Vec<Diagnostic>) {
    match expr {
        Expression::String(s) => {
            for seg in &s.segments {
                if let StringSegment::Interpolation(inner) = seg {
                    // Check if the inner expression itself contains string interpolation
                    if contains_interpolation(inner) {
                        diags.push(Diagnostic::error(
                            "T07",
                            format!(
                                "Nested interpolation detected at line {}. CANT uses single-pass interpolation; '${{...}}' inside an interpolated value will NOT be re-evaluated.",
                                s.span.line
                            ),
                            s.span,
                        ));
                    }
                }
            }
        }
        Expression::Interpolation(interp) => {
            if contains_interpolation(&interp.expression) {
                diags.push(Diagnostic::error(
                    "T07",
                    format!(
                        "Nested interpolation detected at line {}. CANT uses single-pass interpolation.",
                        interp.span.line
                    ),
                    interp.span,
                ));
            }
        }
        Expression::Comparison(cmp) => {
            check_nested_interp_in_expr(&cmp.left, diags);
            check_nested_interp_in_expr(&cmp.right, diags);
        }
        Expression::Logical(log) => {
            check_nested_interp_in_expr(&log.left, diags);
            check_nested_interp_in_expr(&log.right, diags);
        }
        _ => {}
    }
}
