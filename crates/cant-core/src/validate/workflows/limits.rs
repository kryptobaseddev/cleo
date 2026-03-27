//! Workflow configurable-limit validation rules W07--W11.
//!
//! These rules enforce configurable safety limits: unreachable code detection,
//! timeout bounds, parallel arm limits, repeat count limits, and nesting depth.

use crate::dsl::ast::{Expression, Property, Statement, WorkflowDef};

use super::helpers::{duration_to_seconds, is_terminal_stmt, stmt_span};
use crate::validate::context::ValidationContext;
use crate::validate::diagnostic::Diagnostic;

// ── W07: No unreachable code after unconditional return/break ───────

/// W07: Statements after an unconditional directive or output SHOULD be flagged
/// as potentially unreachable.
pub(super) fn check_w07_unreachable_code(wf: &WorkflowDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    check_unreachable_in_stmts(&wf.body, &mut diags);
    diags
}

/// Check for unreachable code after terminal statements.
fn check_unreachable_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    let mut found_terminal = false;
    let mut terminal_line: u32 = 0;

    for stmt in stmts {
        if found_terminal {
            let span = stmt_span(stmt);
            if !matches!(stmt, Statement::Comment(_)) {
                diags.push(Diagnostic::warning(
                    "W07",
                    format!(
                        "Statement at line {} is unreachable. A terminal statement was encountered at line {}.",
                        span.line, terminal_line
                    ),
                    span,
                ));
            }
        }

        if is_terminal_stmt(stmt) {
            found_terminal = true;
            terminal_line = stmt_span(stmt).line;
        }

        // Recurse into nested constructs
        match stmt {
            Statement::Conditional(cond) => {
                check_unreachable_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_unreachable_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_unreachable_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_unreachable_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_unreachable_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_unreachable_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_unreachable_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_unreachable_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_unreachable_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

// ── W08: Timeout values <= configurable max ─────────────────────────

/// W08: Timeout values MUST NOT exceed the configured maximum (default: 3600s).
pub(super) fn check_w08_timeout_limits(
    wf: &WorkflowDef,
    ctx: &ValidationContext,
) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    check_timeout_in_stmts(&wf.body, ctx.limits.max_timeout_seconds, &mut diags);
    diags
}

/// Recursively check timeout property values in statements.
fn check_timeout_in_stmts(stmts: &[Statement], max_seconds: u64, diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::Session(sess) => {
                check_timeout_in_props(&sess.properties, max_seconds, diags)
            }
            Statement::ApprovalGate(gate) => {
                check_timeout_in_props(&gate.properties, max_seconds, diags)
            }
            Statement::Conditional(cond) => {
                check_timeout_in_stmts(&cond.then_body, max_seconds, diags);
                for elif in &cond.elif_branches {
                    check_timeout_in_stmts(&elif.body, max_seconds, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_timeout_in_stmts(else_body, max_seconds, diags);
                }
            }
            Statement::Repeat(r) => check_timeout_in_stmts(&r.body, max_seconds, diags),
            Statement::ForLoop(f) => check_timeout_in_stmts(&f.body, max_seconds, diags),
            Statement::LoopUntil(l) => check_timeout_in_stmts(&l.body, max_seconds, diags),
            Statement::TryCatch(tc) => {
                check_timeout_in_stmts(&tc.try_body, max_seconds, diags);
                if let Some(cb) = &tc.catch_body {
                    check_timeout_in_stmts(cb, max_seconds, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_timeout_in_stmts(fb, max_seconds, diags);
                }
            }
            _ => {}
        }
    }
}

/// Check properties for timeout values exceeding limits.
fn check_timeout_in_props(props: &[Property], max_seconds: u64, diags: &mut Vec<Diagnostic>) {
    for prop in props {
        if prop.key.value == "timeout" {
            if let crate::dsl::ast::Value::Duration(dv) = &prop.value {
                let total_seconds = duration_to_seconds(dv.amount, dv.unit);
                if total_seconds > max_seconds {
                    diags.push(Diagnostic::error(
                        "W08",
                        format!(
                            "Timeout value of {}s at line {} exceeds the maximum of {}s.",
                            total_seconds, prop.span.line, max_seconds
                        ),
                        prop.span,
                    ));
                }
            }
        }
    }
}

// ── W09: Parallel arms <= configurable max ──────────────────────────

/// W09: Parallel blocks MUST NOT exceed the configured arm limit (default: 32).
pub(super) fn check_w09_parallel_arm_limits(
    wf: &WorkflowDef,
    ctx: &ValidationContext,
) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    check_parallel_limits_in_stmts(&wf.body, ctx.limits.max_parallel_arms, &mut diags);
    diags
}

/// Recursively check parallel block arm counts.
fn check_parallel_limits_in_stmts(stmts: &[Statement], max_arms: u32, diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::Parallel(block) => {
                let arm_count = block.arms.len() as u32;
                if arm_count > max_arms {
                    diags.push(Diagnostic::error(
                        "W09",
                        format!(
                            "Parallel block at line {} has {} arms, exceeding the maximum of {}.",
                            block.span.line, arm_count, max_arms
                        ),
                        block.span,
                    ));
                }
            }
            Statement::Conditional(cond) => {
                check_parallel_limits_in_stmts(&cond.then_body, max_arms, diags);
                for elif in &cond.elif_branches {
                    check_parallel_limits_in_stmts(&elif.body, max_arms, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_parallel_limits_in_stmts(else_body, max_arms, diags);
                }
            }
            Statement::Repeat(r) => check_parallel_limits_in_stmts(&r.body, max_arms, diags),
            Statement::ForLoop(f) => check_parallel_limits_in_stmts(&f.body, max_arms, diags),
            Statement::LoopUntil(l) => check_parallel_limits_in_stmts(&l.body, max_arms, diags),
            Statement::TryCatch(tc) => {
                check_parallel_limits_in_stmts(&tc.try_body, max_arms, diags);
                if let Some(cb) = &tc.catch_body {
                    check_parallel_limits_in_stmts(cb, max_arms, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_parallel_limits_in_stmts(fb, max_arms, diags);
                }
            }
            _ => {}
        }
    }
}

// ── W10: Repeat count <= configurable max ───────────────────────────

/// W10: Repeat count MUST NOT exceed the configured maximum (default: 10000).
pub(super) fn check_w10_repeat_count_limits(
    wf: &WorkflowDef,
    ctx: &ValidationContext,
) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    check_repeat_limits_in_stmts(&wf.body, ctx.limits.max_repeat_count, &mut diags);
    diags
}

/// Recursively check repeat count limits.
fn check_repeat_limits_in_stmts(stmts: &[Statement], max_count: u64, diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::Repeat(r) => {
                if let Expression::Number(n) = &r.count {
                    let count = n.value as u64;
                    if count > max_count {
                        diags.push(Diagnostic::error(
                            "W10",
                            format!(
                                "Repeat count of {} at line {} exceeds the maximum of {}.",
                                count, r.span.line, max_count
                            ),
                            r.span,
                        ));
                    }
                }
                check_repeat_limits_in_stmts(&r.body, max_count, diags);
            }
            Statement::Conditional(cond) => {
                check_repeat_limits_in_stmts(&cond.then_body, max_count, diags);
                for elif in &cond.elif_branches {
                    check_repeat_limits_in_stmts(&elif.body, max_count, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_repeat_limits_in_stmts(else_body, max_count, diags);
                }
            }
            Statement::ForLoop(f) => check_repeat_limits_in_stmts(&f.body, max_count, diags),
            Statement::LoopUntil(l) => check_repeat_limits_in_stmts(&l.body, max_count, diags),
            Statement::TryCatch(tc) => {
                check_repeat_limits_in_stmts(&tc.try_body, max_count, diags);
                if let Some(cb) = &tc.catch_body {
                    check_repeat_limits_in_stmts(cb, max_count, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_repeat_limits_in_stmts(fb, max_count, diags);
                }
            }
            _ => {}
        }
    }
}

// ── W11: Nesting depth <= configurable max ──────────────────────────

/// W11: Nesting depth MUST NOT exceed the configured maximum (default: 16).
pub(super) fn check_w11_nesting_depth(
    wf: &WorkflowDef,
    ctx: &ValidationContext,
) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    check_nesting_depth_in_stmts(&wf.body, 0, ctx.limits.max_nesting_depth, &mut diags);
    diags
}

/// Recursively check nesting depth.
fn check_nesting_depth_in_stmts(
    stmts: &[Statement],
    current_depth: u32,
    max_depth: u32,
    diags: &mut Vec<Diagnostic>,
) {
    for stmt in stmts {
        let new_depth = match stmt {
            Statement::Conditional(_)
            | Statement::Repeat(_)
            | Statement::ForLoop(_)
            | Statement::LoopUntil(_)
            | Statement::TryCatch(_)
            | Statement::Parallel(_) => current_depth + 1,
            _ => current_depth,
        };

        if new_depth > max_depth {
            let span = stmt_span(stmt);
            diags.push(Diagnostic::error(
                "W11",
                format!(
                    "Nesting depth of {} at line {} exceeds the maximum of {}. Flatten your workflow logic.",
                    new_depth, span.line, max_depth
                ),
                span,
            ));
            // Don't recurse further once we've flagged the violation
            continue;
        }

        match stmt {
            Statement::Conditional(cond) => {
                check_nesting_depth_in_stmts(&cond.then_body, new_depth, max_depth, diags);
                for elif in &cond.elif_branches {
                    check_nesting_depth_in_stmts(&elif.body, new_depth, max_depth, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_nesting_depth_in_stmts(else_body, new_depth, max_depth, diags);
                }
            }
            Statement::Repeat(r) => {
                check_nesting_depth_in_stmts(&r.body, new_depth, max_depth, diags);
            }
            Statement::ForLoop(f) => {
                check_nesting_depth_in_stmts(&f.body, new_depth, max_depth, diags);
            }
            Statement::LoopUntil(l) => {
                check_nesting_depth_in_stmts(&l.body, new_depth, max_depth, diags);
            }
            Statement::TryCatch(tc) => {
                check_nesting_depth_in_stmts(&tc.try_body, new_depth, max_depth, diags);
                if let Some(cb) = &tc.catch_body {
                    check_nesting_depth_in_stmts(cb, new_depth, max_depth, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_nesting_depth_in_stmts(fb, new_depth, max_depth, diags);
                }
            }
            Statement::Parallel(block) => {
                for arm in &block.arms {
                    // Each arm body is a single statement; treat it as a one-element slice
                    check_nesting_depth_in_stmts(&[*arm.body.clone()], new_depth, max_depth, diags);
                }
            }
            _ => {}
        }
    }
}
