//! Workflow structural validation rules W01--W06.
//!
//! These rules enforce structural constraints: approval gate requirements,
//! parallel arm uniqueness, expression types, and naming conventions.

use crate::dsl::ast::{Statement, WorkflowDef};
use crate::dsl::span::Span;

use super::helpers::{is_iterable_expr, is_string_value, is_valid_identifier};
use crate::validate::diagnostic::Diagnostic;

// ── W01: Approval gates require message property ────────────────────

/// W01: Approval gate constructs MUST include a `message` property.
pub(super) fn check_w01_approval_message(wf: &WorkflowDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    check_approval_in_stmts(&wf.body, &mut diags);
    diags
}

/// Recursively check approval gates for message property.
fn check_approval_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::ApprovalGate(gate) => {
                let has_message = gate.properties.iter().any(|p| p.key.value == "message");
                if !has_message {
                    diags.push(Diagnostic::error(
                        "W01",
                        format!(
                            "Approval gate at line {} is missing required 'message' property.",
                            gate.span.line
                        ),
                        gate.span,
                    ));
                }
            }
            Statement::Conditional(cond) => {
                check_approval_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_approval_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_approval_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_approval_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_approval_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_approval_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_approval_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_approval_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_approval_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

// ── W02: Parallel arms have unique names ────────────────────────────

/// W02: Parallel arm names MUST be unique within a parallel block.
///
/// Note: This overlaps with S07 in scope.rs but provides workflow-specific context.
pub(super) fn check_w02_parallel_arm_names(wf: &WorkflowDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    check_parallel_names_in_stmts(&wf.body, &mut diags);
    diags
}

/// Recursively check parallel arm name uniqueness.
fn check_parallel_names_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::Parallel(block) => {
                let mut seen: std::collections::HashMap<&str, Span> =
                    std::collections::HashMap::new();
                for arm in &block.arms {
                    if let Some(prev_span) = seen.get(arm.name.as_str()) {
                        diags.push(Diagnostic::error(
                            "W02",
                            format!(
                                "Parallel arm '{}' at line {} duplicates an arm defined at line {}. Arm names must be unique.",
                                arm.name, arm.span.line, prev_span.line
                            ),
                            arm.span,
                        ));
                    } else {
                        seen.insert(&arm.name, arm.span);
                    }
                }
            }
            Statement::Conditional(cond) => {
                check_parallel_names_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_parallel_names_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_parallel_names_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_parallel_names_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_parallel_names_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_parallel_names_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_parallel_names_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_parallel_names_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_parallel_names_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

// ── W03: Session prompts are string expressions ─────────────────────

/// W03: Session prompt values MUST be string expressions.
pub(super) fn check_w03_session_prompts(wf: &WorkflowDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    check_session_prompts_in_stmts(&wf.body, &mut diags);
    diags
}

/// Recursively check session prompt types.
fn check_session_prompts_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::Session(sess) => {
                // Check the prompt property if it exists
                for prop in &sess.properties {
                    if prop.key.value == "prompt" {
                        if !is_string_value(&prop.value) {
                            diags.push(Diagnostic::error(
                                "W03",
                                format!(
                                    "Session prompt at line {} must be a string expression.",
                                    prop.span.line
                                ),
                                prop.span,
                            ));
                        }
                    }
                }
            }
            Statement::Conditional(cond) => {
                check_session_prompts_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_session_prompts_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_session_prompts_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_session_prompts_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_session_prompts_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_session_prompts_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_session_prompts_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_session_prompts_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_session_prompts_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

// ── W04: Loop iterables are resolvable collections ──────────────────

/// W04: For-loop iterable expressions MUST be resolvable (arrays or names).
pub(super) fn check_w04_loop_iterables(wf: &WorkflowDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    check_loop_iterables_in_stmts(&wf.body, &mut diags);
    diags
}

/// Recursively check for-loop iterables.
fn check_loop_iterables_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::ForLoop(f) => {
                if !is_iterable_expr(&f.iterable) {
                    diags.push(Diagnostic::warning(
                        "W04",
                        format!(
                            "For-loop iterable at line {} may not be a resolvable collection. Expected an array or name expression.",
                            f.span.line
                        ),
                        f.span,
                    ));
                }
                check_loop_iterables_in_stmts(&f.body, diags);
            }
            Statement::Conditional(cond) => {
                check_loop_iterables_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_loop_iterables_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_loop_iterables_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_loop_iterables_in_stmts(&r.body, diags),
            Statement::LoopUntil(l) => check_loop_iterables_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_loop_iterables_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_loop_iterables_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_loop_iterables_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

// ── W05: Try blocks have at least one statement ─────────────────────

/// W05: Try blocks MUST contain at least one non-comment statement.
pub(super) fn check_w05_try_blocks(wf: &WorkflowDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    check_try_blocks_in_stmts(&wf.body, &mut diags);
    diags
}

/// Recursively check try blocks for empty bodies.
fn check_try_blocks_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::TryCatch(tc) => {
                let has_real_stmts = tc
                    .try_body
                    .iter()
                    .any(|s| !matches!(s, Statement::Comment(_)));
                if !has_real_stmts {
                    diags.push(Diagnostic::warning(
                        "W05",
                        format!(
                            "Try block at line {} has an empty body. Try blocks should contain at least one statement.",
                            tc.span.line
                        ),
                        tc.span,
                    ));
                }
                // Recurse
                check_try_blocks_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_try_blocks_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_try_blocks_in_stmts(fb, diags);
                }
            }
            Statement::Conditional(cond) => {
                check_try_blocks_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_try_blocks_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_try_blocks_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_try_blocks_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_try_blocks_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_try_blocks_in_stmts(&l.body, diags),
            _ => {}
        }
    }
}

// ── W06: Workflow names are valid identifiers ───────────────────────

/// W06: Workflow names MUST be valid identifiers (start with letter or underscore,
/// contain only alphanumeric, underscore, and hyphen characters).
pub(super) fn check_w06_workflow_names(wf: &WorkflowDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    let name = &wf.name.value;
    if !is_valid_identifier(name) {
        diags.push(Diagnostic::error(
            "W06",
            format!(
                "Workflow name '{}' at line {} is not a valid identifier. Names must start with a letter or underscore and contain only alphanumeric, underscore, or hyphen characters.",
                name, wf.name.span.line
            ),
            wf.name.span,
        ));
    }
    diags
}
