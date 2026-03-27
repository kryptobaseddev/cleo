//! Workflow validation rules W01--W11.
//!
//! These rules enforce structural constraints on workflow constructs:
//! approval gate requirements, parallel arm uniqueness, expression types,
//! reachability, and configurable safety limits.

use crate::dsl::ast::{CantDocument, Expression, Property, Section, Statement, Value, WorkflowDef};
use crate::dsl::span::Span;

use super::context::ValidationContext;
use super::diagnostic::Diagnostic;

/// Runs all workflow checks (W01--W11) against `doc`.
pub fn check_all(doc: &CantDocument, ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        if let Section::Workflow(wf) = section {
            diags.extend(check_w01_approval_message(wf));
            diags.extend(check_w02_parallel_arm_names(wf));
            diags.extend(check_w03_session_prompts(wf));
            diags.extend(check_w04_loop_iterables(wf));
            diags.extend(check_w05_try_blocks(wf));
            diags.extend(check_w06_workflow_names(wf));
            diags.extend(check_w07_unreachable_code(wf));
            diags.extend(check_w08_timeout_limits(wf, ctx));
            diags.extend(check_w09_parallel_arm_limits(wf, ctx));
            diags.extend(check_w10_repeat_count_limits(wf, ctx));
            diags.extend(check_w11_nesting_depth(wf, ctx));
        }
    }
    diags
}

// ── W01: Approval gates require message property ────────────────────

/// W01: Approval gate constructs MUST include a `message` property.
fn check_w01_approval_message(wf: &WorkflowDef) -> Vec<Diagnostic> {
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
fn check_w02_parallel_arm_names(wf: &WorkflowDef) -> Vec<Diagnostic> {
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
fn check_w03_session_prompts(wf: &WorkflowDef) -> Vec<Diagnostic> {
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

/// Returns true if a value is string-compatible.
fn is_string_value(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Identifier(_))
}

// ── W04: Loop iterables are resolvable collections ──────────────────

/// W04: For-loop iterable expressions MUST be resolvable (arrays or names).
fn check_w04_loop_iterables(wf: &WorkflowDef) -> Vec<Diagnostic> {
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

/// Returns true if the expression is a valid iterable (array, name, or property access).
fn is_iterable_expr(expr: &Expression) -> bool {
    matches!(
        expr,
        Expression::Array(_) | Expression::Name(_) | Expression::PropertyAccess(_)
    )
}

// ── W05: Try blocks have at least one statement ─────────────────────

/// W05: Try blocks MUST contain at least one non-comment statement.
fn check_w05_try_blocks(wf: &WorkflowDef) -> Vec<Diagnostic> {
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
fn check_w06_workflow_names(wf: &WorkflowDef) -> Vec<Diagnostic> {
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

/// Returns true if the name is a valid CANT identifier.
fn is_valid_identifier(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let first = name.chars().next().unwrap();
    if !first.is_ascii_alphabetic() && first != '_' {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ── W07: No unreachable code after unconditional return/break ───────

/// W07: Statements after an unconditional directive or output SHOULD be flagged
/// as potentially unreachable.
fn check_w07_unreachable_code(wf: &WorkflowDef) -> Vec<Diagnostic> {
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
            let stmt_span = stmt_span(stmt);
            if !matches!(stmt, Statement::Comment(_)) {
                diags.push(Diagnostic::warning(
                    "W07",
                    format!(
                        "Statement at line {} is unreachable. A terminal statement was encountered at line {}.",
                        stmt_span.line, terminal_line
                    ),
                    stmt_span,
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

/// Returns true if the statement is a terminal (flow-ending) statement.
fn is_terminal_stmt(stmt: &Statement) -> bool {
    matches!(stmt, Statement::Output(_))
}

/// Extract the span from a statement.
fn stmt_span(stmt: &Statement) -> Span {
    match stmt {
        Statement::Binding(b) => b.span,
        Statement::Expression(e) => expr_span(e),
        Statement::Directive(d) => d.span,
        Statement::Property(p) => p.span,
        Statement::Comment(c) => c.span,
        Statement::Session(s) => s.span,
        Statement::Parallel(p) => p.span,
        Statement::Conditional(c) => c.span,
        Statement::Repeat(r) => r.span,
        Statement::ForLoop(f) => f.span,
        Statement::LoopUntil(l) => l.span,
        Statement::TryCatch(tc) => tc.span,
        Statement::ApprovalGate(a) => a.span,
        Statement::Pipeline(p) => p.span,
        Statement::PipeStep(ps) => ps.span,
        Statement::Output(o) => o.span,
    }
}

/// Extract span from an expression.
fn expr_span(expr: &Expression) -> Span {
    match expr {
        Expression::Name(n) => n.span,
        Expression::String(s) => s.span,
        Expression::Number(n) => n.span,
        Expression::Boolean(b) => b.span,
        Expression::Duration(d) => d.span,
        Expression::TaskRef(t) => t.span,
        Expression::Address(a) => a.span,
        Expression::Array(a) => a.span,
        Expression::PropertyAccess(p) => p.span,
        Expression::Comparison(c) => c.span,
        Expression::Logical(l) => l.span,
        Expression::Negation(n) => n.span,
        Expression::Interpolation(i) => i.span,
    }
}

// ── W08: Timeout values <= configurable max ─────────────────────────

/// W08: Timeout values MUST NOT exceed the configured maximum (default: 3600s).
fn check_w08_timeout_limits(wf: &WorkflowDef, ctx: &ValidationContext) -> Vec<Diagnostic> {
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
            if let Value::Duration(dv) = &prop.value {
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

/// Convert duration amount + unit to seconds.
fn duration_to_seconds(amount: u64, unit: crate::dsl::ast::DurationUnit) -> u64 {
    use crate::dsl::ast::DurationUnit;
    match unit {
        DurationUnit::Seconds => amount,
        DurationUnit::Minutes => amount * 60,
        DurationUnit::Hours => amount * 3600,
        DurationUnit::Days => amount * 86400,
    }
}

// ── W09: Parallel arms <= configurable max ──────────────────────────

/// W09: Parallel blocks MUST NOT exceed the configured arm limit (default: 32).
fn check_w09_parallel_arm_limits(wf: &WorkflowDef, ctx: &ValidationContext) -> Vec<Diagnostic> {
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
fn check_w10_repeat_count_limits(wf: &WorkflowDef, ctx: &ValidationContext) -> Vec<Diagnostic> {
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
fn check_w11_nesting_depth(wf: &WorkflowDef, ctx: &ValidationContext) -> Vec<Diagnostic> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::ast::*;
    use crate::dsl::span::Span;

    fn dummy_span() -> Span {
        Span::dummy()
    }

    fn spanned(value: &str) -> Spanned<String> {
        Spanned::new(value.to_string(), dummy_span())
    }

    fn make_doc(sections: Vec<Section>) -> CantDocument {
        CantDocument {
            kind: None,
            frontmatter: None,
            sections,
            span: dummy_span(),
        }
    }

    fn make_wf(name: &str, body: Vec<Statement>) -> WorkflowDef {
        WorkflowDef {
            name: Spanned::new(name.to_string(), Span::new(0, name.len(), 1, 1)),
            params: vec![],
            body,
            span: dummy_span(),
        }
    }

    fn make_prop(key: &str, value: Value) -> Property {
        Property {
            key: spanned(key),
            value,
            span: Span::new(0, 10, 3, 1),
        }
    }

    fn string_val(s: &str) -> Value {
        Value::String(StringValue {
            raw: s.to_string(),
            double_quoted: true,
            span: dummy_span(),
        })
    }

    fn comment_stmt() -> Statement {
        Statement::Comment(Comment {
            text: "placeholder".to_string(),
            span: dummy_span(),
        })
    }

    fn directive_stmt() -> Statement {
        Statement::Directive(DirectiveStmt {
            verb: "done".to_string(),
            addresses: vec![],
            task_refs: vec!["T1234".to_string()],
            tags: vec![],
            argument: None,
            span: Span::new(0, 15, 2, 1),
        })
    }

    // ── W01 tests ────────────────────────────────────────────────────

    #[test]
    fn w01_approval_with_message_pass() {
        let wf = make_wf(
            "deploy",
            vec![Statement::ApprovalGate(ApprovalGate {
                properties: vec![make_prop("message", string_val("Ready?"))],
                span: Span::new(0, 20, 3, 1),
            })],
        );
        let diags = check_w01_approval_message(&wf);
        assert!(diags.is_empty());
    }

    #[test]
    fn w01_approval_without_message_error() {
        let wf = make_wf(
            "deploy",
            vec![Statement::ApprovalGate(ApprovalGate {
                properties: vec![make_prop(
                    "timeout",
                    Value::Duration(DurationValue {
                        amount: 60,
                        unit: DurationUnit::Seconds,
                        span: dummy_span(),
                    }),
                )],
                span: Span::new(0, 20, 3, 1),
            })],
        );
        let diags = check_w01_approval_message(&wf);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "W01");
    }

    #[test]
    fn w01_approval_empty_props_error() {
        let wf = make_wf(
            "deploy",
            vec![Statement::ApprovalGate(ApprovalGate {
                properties: vec![],
                span: Span::new(0, 20, 3, 1),
            })],
        );
        let diags = check_w01_approval_message(&wf);
        assert_eq!(diags.len(), 1);
    }

    // ── W03 tests ────────────────────────────────────────────────────

    #[test]
    fn w03_string_prompt_pass() {
        let wf = make_wf(
            "review",
            vec![Statement::Session(SessionExpr {
                target: SessionTarget::Prompt("Review this".to_string()),
                properties: vec![make_prop("prompt", string_val("Review the code"))],
                span: dummy_span(),
            })],
        );
        let diags = check_w03_session_prompts(&wf);
        assert!(diags.is_empty());
    }

    #[test]
    fn w03_number_prompt_error() {
        let wf = make_wf(
            "review",
            vec![Statement::Session(SessionExpr {
                target: SessionTarget::Prompt("Review".to_string()),
                properties: vec![make_prop("prompt", Value::Number(42.0))],
                span: dummy_span(),
            })],
        );
        let diags = check_w03_session_prompts(&wf);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "W03");
    }

    #[test]
    fn w03_no_prompt_property_pass() {
        let wf = make_wf(
            "review",
            vec![Statement::Session(SessionExpr {
                target: SessionTarget::Agent("scanner".to_string()),
                properties: vec![],
                span: dummy_span(),
            })],
        );
        let diags = check_w03_session_prompts(&wf);
        assert!(diags.is_empty());
    }

    // ── W04 tests ────────────────────────────────────────────────────

    #[test]
    fn w04_array_iterable_pass() {
        let wf = make_wf(
            "process",
            vec![Statement::ForLoop(ForLoop {
                variable: spanned("item"),
                iterable: Expression::Array(ArrayExpr {
                    elements: vec![],
                    span: dummy_span(),
                }),
                body: vec![directive_stmt()],
                span: dummy_span(),
            })],
        );
        let diags = check_w04_loop_iterables(&wf);
        assert!(diags.is_empty());
    }

    #[test]
    fn w04_name_iterable_pass() {
        let wf = make_wf(
            "process",
            vec![Statement::ForLoop(ForLoop {
                variable: spanned("item"),
                iterable: Expression::Name(NameExpr {
                    name: "tasks".to_string(),
                    span: dummy_span(),
                }),
                body: vec![directive_stmt()],
                span: dummy_span(),
            })],
        );
        let diags = check_w04_loop_iterables(&wf);
        assert!(diags.is_empty());
    }

    #[test]
    fn w04_number_iterable_warning() {
        let wf = make_wf(
            "process",
            vec![Statement::ForLoop(ForLoop {
                variable: spanned("item"),
                iterable: Expression::Number(NumberExpr {
                    value: 42.0,
                    span: dummy_span(),
                }),
                body: vec![directive_stmt()],
                span: Span::new(0, 30, 5, 1),
            })],
        );
        let diags = check_w04_loop_iterables(&wf);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "W04");
    }

    // ── W05 tests ────────────────────────────────────────────────────

    #[test]
    fn w05_non_empty_try_pass() {
        let wf = make_wf(
            "deploy",
            vec![Statement::TryCatch(TryCatch {
                try_body: vec![directive_stmt()],
                catch_name: None,
                catch_body: None,
                finally_body: None,
                span: Span::new(0, 30, 3, 1),
            })],
        );
        let diags = check_w05_try_blocks(&wf);
        assert!(diags.is_empty());
    }

    #[test]
    fn w05_empty_try_warning() {
        let wf = make_wf(
            "deploy",
            vec![Statement::TryCatch(TryCatch {
                try_body: vec![],
                catch_name: None,
                catch_body: None,
                finally_body: None,
                span: Span::new(0, 30, 3, 1),
            })],
        );
        let diags = check_w05_try_blocks(&wf);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "W05");
    }

    #[test]
    fn w05_comments_only_try_warning() {
        let wf = make_wf(
            "deploy",
            vec![Statement::TryCatch(TryCatch {
                try_body: vec![comment_stmt()],
                catch_name: None,
                catch_body: None,
                finally_body: None,
                span: Span::new(0, 30, 3, 1),
            })],
        );
        let diags = check_w05_try_blocks(&wf);
        assert_eq!(diags.len(), 1);
    }

    // ── W06 tests ────────────────────────────────────────────────────

    #[test]
    fn w06_valid_name_pass() {
        let wf = make_wf("deploy-pipeline", vec![]);
        let diags = check_w06_workflow_names(&wf);
        assert!(diags.is_empty());
    }

    #[test]
    fn w06_underscore_start_pass() {
        let wf = make_wf("_internal", vec![]);
        let diags = check_w06_workflow_names(&wf);
        assert!(diags.is_empty());
    }

    #[test]
    fn w06_digit_start_error() {
        let wf = make_wf("123invalid", vec![]);
        let diags = check_w06_workflow_names(&wf);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "W06");
    }

    #[test]
    fn w06_empty_name_error() {
        let wf = WorkflowDef {
            name: Spanned::new(String::new(), Span::new(0, 0, 1, 1)),
            params: vec![],
            body: vec![],
            span: dummy_span(),
        };
        let diags = check_w06_workflow_names(&wf);
        assert_eq!(diags.len(), 1);
    }

    #[test]
    fn w06_special_chars_error() {
        let wf = make_wf("deploy.prod", vec![]);
        let diags = check_w06_workflow_names(&wf);
        assert_eq!(diags.len(), 1);
    }

    // ── W07 tests ────────────────────────────────────────────────────

    #[test]
    fn w07_no_unreachable_pass() {
        let wf = make_wf("deploy", vec![directive_stmt(), directive_stmt()]);
        let diags = check_w07_unreachable_code(&wf);
        assert!(diags.is_empty());
    }

    #[test]
    fn w07_code_after_output_warning() {
        let wf = make_wf(
            "deploy",
            vec![
                Statement::Output(OutputStmt {
                    name: spanned("result"),
                    value: Expression::String(StringExpr {
                        segments: vec![StringSegment::Literal("done".to_string())],
                        span: dummy_span(),
                    }),
                    span: Span::new(0, 20, 3, 1),
                }),
                Statement::Directive(DirectiveStmt {
                    verb: "done".to_string(),
                    addresses: vec![],
                    task_refs: vec![],
                    tags: vec![],
                    argument: None,
                    span: Span::new(0, 15, 5, 1),
                }),
            ],
        );
        let diags = check_w07_unreachable_code(&wf);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "W07");
    }

    #[test]
    fn w07_comments_after_output_ignored() {
        let wf = make_wf(
            "deploy",
            vec![
                Statement::Output(OutputStmt {
                    name: spanned("result"),
                    value: Expression::String(StringExpr {
                        segments: vec![StringSegment::Literal("done".to_string())],
                        span: dummy_span(),
                    }),
                    span: Span::new(0, 20, 3, 1),
                }),
                comment_stmt(),
            ],
        );
        let diags = check_w07_unreachable_code(&wf);
        assert!(diags.is_empty());
    }

    // ── W08 tests ────────────────────────────────────────────────────

    #[test]
    fn w08_within_limit_pass() {
        let ctx = ValidationContext::new();
        let wf = make_wf(
            "deploy",
            vec![Statement::Session(SessionExpr {
                target: SessionTarget::Prompt("Deploy".to_string()),
                properties: vec![make_prop(
                    "timeout",
                    Value::Duration(DurationValue {
                        amount: 300,
                        unit: DurationUnit::Seconds,
                        span: dummy_span(),
                    }),
                )],
                span: dummy_span(),
            })],
        );
        let diags = check_w08_timeout_limits(&wf, &ctx);
        assert!(diags.is_empty());
    }

    #[test]
    fn w08_exceeds_limit_error() {
        let ctx = ValidationContext::new(); // default max = 3600s
        let wf = make_wf(
            "deploy",
            vec![Statement::Session(SessionExpr {
                target: SessionTarget::Prompt("Deploy".to_string()),
                properties: vec![make_prop(
                    "timeout",
                    Value::Duration(DurationValue {
                        amount: 2,
                        unit: DurationUnit::Hours,
                        span: dummy_span(),
                    }),
                )],
                span: dummy_span(),
            })],
        );
        let diags = check_w08_timeout_limits(&wf, &ctx);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "W08");
    }

    #[test]
    fn w08_custom_limit() {
        let mut ctx = ValidationContext::new();
        ctx.limits.max_timeout_seconds = 60;
        let wf = make_wf(
            "deploy",
            vec![Statement::Session(SessionExpr {
                target: SessionTarget::Prompt("Deploy".to_string()),
                properties: vec![make_prop(
                    "timeout",
                    Value::Duration(DurationValue {
                        amount: 120,
                        unit: DurationUnit::Seconds,
                        span: dummy_span(),
                    }),
                )],
                span: dummy_span(),
            })],
        );
        let diags = check_w08_timeout_limits(&wf, &ctx);
        assert_eq!(diags.len(), 1);
    }

    // ── W09 tests ────────────────────────────────────────────────────

    #[test]
    fn w09_within_limit_pass() {
        let ctx = ValidationContext::new();
        let wf = make_wf(
            "deploy",
            vec![Statement::Parallel(ParallelBlock {
                modifier: None,
                arms: vec![
                    ParallelArm {
                        name: "a".to_string(),
                        body: Box::new(comment_stmt()),
                        span: dummy_span(),
                    },
                    ParallelArm {
                        name: "b".to_string(),
                        body: Box::new(comment_stmt()),
                        span: dummy_span(),
                    },
                ],
                span: Span::new(0, 20, 3, 1),
            })],
        );
        let diags = check_w09_parallel_arm_limits(&wf, &ctx);
        assert!(diags.is_empty());
    }

    #[test]
    fn w09_exceeds_limit_error() {
        let mut ctx = ValidationContext::new();
        ctx.limits.max_parallel_arms = 2;
        let wf = make_wf(
            "deploy",
            vec![Statement::Parallel(ParallelBlock {
                modifier: None,
                arms: vec![
                    ParallelArm {
                        name: "a".to_string(),
                        body: Box::new(comment_stmt()),
                        span: dummy_span(),
                    },
                    ParallelArm {
                        name: "b".to_string(),
                        body: Box::new(comment_stmt()),
                        span: dummy_span(),
                    },
                    ParallelArm {
                        name: "c".to_string(),
                        body: Box::new(comment_stmt()),
                        span: dummy_span(),
                    },
                ],
                span: Span::new(0, 20, 3, 1),
            })],
        );
        let diags = check_w09_parallel_arm_limits(&wf, &ctx);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "W09");
    }

    // ── W10 tests ────────────────────────────────────────────────────

    #[test]
    fn w10_within_limit_pass() {
        let ctx = ValidationContext::new();
        let wf = make_wf(
            "retry",
            vec![Statement::Repeat(RepeatLoop {
                count: Expression::Number(NumberExpr {
                    value: 3.0,
                    span: dummy_span(),
                }),
                body: vec![directive_stmt()],
                span: dummy_span(),
            })],
        );
        let diags = check_w10_repeat_count_limits(&wf, &ctx);
        assert!(diags.is_empty());
    }

    #[test]
    fn w10_exceeds_limit_error() {
        let mut ctx = ValidationContext::new();
        ctx.limits.max_repeat_count = 100;
        let wf = make_wf(
            "retry",
            vec![Statement::Repeat(RepeatLoop {
                count: Expression::Number(NumberExpr {
                    value: 1000.0,
                    span: dummy_span(),
                }),
                body: vec![directive_stmt()],
                span: Span::new(0, 20, 3, 1),
            })],
        );
        let diags = check_w10_repeat_count_limits(&wf, &ctx);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "W10");
    }

    #[test]
    fn w10_name_count_no_check() {
        // Name expression count can't be statically checked
        let ctx = ValidationContext::new();
        let wf = make_wf(
            "retry",
            vec![Statement::Repeat(RepeatLoop {
                count: Expression::Name(NameExpr {
                    name: "n".to_string(),
                    span: dummy_span(),
                }),
                body: vec![directive_stmt()],
                span: dummy_span(),
            })],
        );
        let diags = check_w10_repeat_count_limits(&wf, &ctx);
        assert!(diags.is_empty());
    }

    // ── W11 tests ────────────────────────────────────────────────────

    #[test]
    fn w11_shallow_nesting_pass() {
        let ctx = ValidationContext::new();
        let wf = make_wf(
            "deploy",
            vec![Statement::Conditional(Conditional {
                condition: Condition::Expression(Expression::Boolean(BooleanExpr {
                    value: true,
                    span: dummy_span(),
                })),
                then_body: vec![directive_stmt()],
                elif_branches: vec![],
                else_body: None,
                span: Span::new(0, 20, 3, 1),
            })],
        );
        let diags = check_w11_nesting_depth(&wf, &ctx);
        assert!(diags.is_empty());
    }

    #[test]
    fn w11_exceeds_depth_error() {
        let mut ctx = ValidationContext::new();
        ctx.limits.max_nesting_depth = 2;

        // Build 3 levels of nesting (exceeds max of 2)
        let inner = Statement::Conditional(Conditional {
            condition: Condition::Expression(Expression::Boolean(BooleanExpr {
                value: true,
                span: dummy_span(),
            })),
            then_body: vec![directive_stmt()],
            elif_branches: vec![],
            else_body: None,
            span: Span::new(0, 20, 7, 1),
        });
        let middle = Statement::Conditional(Conditional {
            condition: Condition::Expression(Expression::Boolean(BooleanExpr {
                value: true,
                span: dummy_span(),
            })),
            then_body: vec![inner],
            elif_branches: vec![],
            else_body: None,
            span: Span::new(0, 20, 5, 1),
        });
        let outer = Statement::Conditional(Conditional {
            condition: Condition::Expression(Expression::Boolean(BooleanExpr {
                value: true,
                span: dummy_span(),
            })),
            then_body: vec![middle],
            elif_branches: vec![],
            else_body: None,
            span: Span::new(0, 20, 3, 1),
        });

        let wf = make_wf("deep", vec![outer]);
        let diags = check_w11_nesting_depth(&wf, &ctx);
        assert!(diags.iter().any(|d| d.rule_id == "W11"));
    }

    #[test]
    fn w11_at_exact_limit_pass() {
        let mut ctx = ValidationContext::new();
        ctx.limits.max_nesting_depth = 2;

        // 2 levels of nesting (equal to max, should pass)
        let inner = Statement::Conditional(Conditional {
            condition: Condition::Expression(Expression::Boolean(BooleanExpr {
                value: true,
                span: dummy_span(),
            })),
            then_body: vec![directive_stmt()],
            elif_branches: vec![],
            else_body: None,
            span: Span::new(0, 20, 5, 1),
        });
        let outer = Statement::Conditional(Conditional {
            condition: Condition::Expression(Expression::Boolean(BooleanExpr {
                value: true,
                span: dummy_span(),
            })),
            then_body: vec![inner],
            elif_branches: vec![],
            else_body: None,
            span: Span::new(0, 20, 3, 1),
        });

        let wf = make_wf("ok", vec![outer]);
        let diags = check_w11_nesting_depth(&wf, &ctx);
        assert!(diags.is_empty());
    }

    // ── check_all integration ───────────────────────────────────────

    #[test]
    fn check_all_valid_workflow_passes() {
        let wf = make_wf("deploy", vec![directive_stmt()]);
        let doc = make_doc(vec![Section::Workflow(wf)]);
        let ctx = ValidationContext::new();
        let diags = check_all(&doc, &ctx);
        assert!(diags.is_empty());
    }

    #[test]
    fn check_all_multiple_violations() {
        let wf = make_wf(
            "123bad",
            vec![Statement::ApprovalGate(ApprovalGate {
                properties: vec![], // missing message (W01)
                span: Span::new(0, 20, 3, 1),
            })],
        );
        let doc = make_doc(vec![Section::Workflow(wf)]);
        let ctx = ValidationContext::new();
        let diags = check_all(&doc, &ctx);
        // W01 (missing message) + W06 (invalid name)
        assert!(diags.iter().any(|d| d.rule_id == "W01"));
        assert!(diags.iter().any(|d| d.rule_id == "W06"));
    }

    #[test]
    fn check_all_non_workflow_sections_ignored() {
        let doc = make_doc(vec![Section::Agent(AgentDef {
            name: spanned("ops"),
            properties: vec![],
            permissions: vec![],
            hooks: vec![],
            span: dummy_span(),
        })]);
        let ctx = ValidationContext::new();
        let diags = check_all(&doc, &ctx);
        assert!(diags.is_empty());
    }
}
