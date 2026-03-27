//! Pipeline purity check implementations P01--P07.
//!
//! Each function validates a specific determinism constraint on pipeline
//! definitions: no sessions, no discretion, no approvals, no LLM calls,
//! deterministic steps, no shell interpolation, and command allowlists.

use crate::dsl::ast::{PipelineDef, Property, Statement, Value};
use crate::dsl::span::Span;

use crate::validate::context::ValidationContext;
use crate::validate::diagnostic::Diagnostic;

/// Recursively find inline pipeline statements within workflow bodies.
pub(super) fn check_inline_pipelines(
    stmts: &[Statement],
    ctx: &ValidationContext,
    diags: &mut Vec<Diagnostic>,
) {
    for stmt in stmts {
        match stmt {
            Statement::Pipeline(pipe) => {
                diags.extend(check_p01_no_sessions(pipe));
                diags.extend(check_p02_no_discretion(pipe));
                diags.extend(check_p03_no_approval_gates(pipe));
                diags.extend(check_p04_no_llm_calls(pipe));
                diags.extend(check_p05_deterministic_steps(pipe));
                diags.extend(check_p06_no_shell_interpolation(pipe));
                diags.extend(check_p07_command_allowlist(pipe, ctx));
            }
            Statement::Conditional(cond) => {
                check_inline_pipelines(&cond.then_body, ctx, diags);
                for elif in &cond.elif_branches {
                    check_inline_pipelines(&elif.body, ctx, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_inline_pipelines(else_body, ctx, diags);
                }
            }
            Statement::Repeat(r) => check_inline_pipelines(&r.body, ctx, diags),
            Statement::ForLoop(f) => check_inline_pipelines(&f.body, ctx, diags),
            Statement::LoopUntil(l) => check_inline_pipelines(&l.body, ctx, diags),
            Statement::TryCatch(tc) => {
                check_inline_pipelines(&tc.try_body, ctx, diags);
                if let Some(cb) = &tc.catch_body {
                    check_inline_pipelines(cb, ctx, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_inline_pipelines(fb, ctx, diags);
                }
            }
            _ => {}
        }
    }
}

// ── P01: No sessions in pipeline bodies ─────────────────────────────

/// P01: Pipelines MUST NOT contain session invocations.
pub(super) fn check_p01_no_sessions(pipe: &PipelineDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for step in &pipe.steps {
        check_step_properties_for_sessions(&step.properties, &pipe.name.value, &mut diags);
    }
    diags
}

/// Check property values for session-like references.
fn check_step_properties_for_sessions(
    props: &[Property],
    pipeline_name: &str,
    diags: &mut Vec<Diagnostic>,
) {
    for prop in props {
        if prop.key.value == "session" {
            diags.push(Diagnostic::error(
                "P01",
                format!(
                    "Pipeline '{}' contains a session reference in step property at line {}. Pipelines MUST be deterministic and cannot invoke LLM sessions.",
                    pipeline_name, prop.span.line
                ),
                prop.span,
            ));
        }
    }
}

// ── P02: No discretion conditions in pipeline bodies ────────────────

/// P02: Pipelines MUST NOT contain discretion conditions.
pub(super) fn check_p02_no_discretion(pipe: &PipelineDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for step in &pipe.steps {
        for prop in &step.properties {
            if prop.key.value == "condition" {
                if let Value::String(sv) = &prop.value {
                    if sv.raw.starts_with("**") && sv.raw.ends_with("**") {
                        diags.push(Diagnostic::error(
                            "P02",
                            format!(
                                "Pipeline '{}' step '{}' contains a discretion condition at line {}. Pipelines MUST NOT use AI-evaluated conditions.",
                                pipe.name.value, step.name.value, prop.span.line
                            ),
                            prop.span,
                        ));
                    }
                }
            }
        }
    }
    diags
}

// ── P03: No approval gates in pipeline bodies ───────────────────────

/// P03: Pipelines MUST NOT contain approval gate constructs.
pub(super) fn check_p03_no_approval_gates(pipe: &PipelineDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for step in &pipe.steps {
        for prop in &step.properties {
            if prop.key.value == "approve" || prop.key.value == "approval" {
                diags.push(Diagnostic::error(
                    "P03",
                    format!(
                        "Pipeline '{}' step '{}' contains an approval gate at line {}. Pipelines MUST NOT require human approval.",
                        pipe.name.value, step.name.value, prop.span.line
                    ),
                    prop.span,
                ));
            }
        }
    }
    diags
}

// ── P04: No LLM-dependent calls in pipeline bodies ──────────────────

/// P04: Pipeline steps MUST NOT invoke LLM-dependent operations.
pub(super) fn check_p04_no_llm_calls(pipe: &PipelineDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for step in &pipe.steps {
        for prop in &step.properties {
            if prop.key.value == "model" || prop.key.value == "prompt" {
                diags.push(Diagnostic::error(
                    "P04",
                    format!(
                        "Pipeline '{}' step '{}' contains LLM-dependent property '{}' at line {}. Pipelines MUST be fully deterministic.",
                        pipe.name.value, step.name.value, prop.key.value, prop.span.line
                    ),
                    prop.span,
                ));
            }
        }
    }
    diags
}

// ── P05: All steps must be deterministic ─────────────────────────────

/// P05: All pipeline steps must be deterministic (no non-deterministic properties).
pub(super) fn check_p05_deterministic_steps(pipe: &PipelineDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    let non_deterministic_keys = ["discretion", "llm", "ai_eval"];
    for step in &pipe.steps {
        for prop in &step.properties {
            if non_deterministic_keys.contains(&prop.key.value.as_str()) {
                diags.push(Diagnostic::error(
                    "P05",
                    format!(
                        "Pipeline '{}' step '{}' contains non-deterministic property '{}' at line {}. All pipeline steps MUST be deterministic.",
                        pipe.name.value, step.name.value, prop.key.value, prop.span.line
                    ),
                    prop.span,
                ));
            }
        }
    }
    diags
}

// ── P06: No shell interpolation in commands ─────────────────────────

/// P06 (CRITICAL): Command values MUST use args array, not shell interpolation.
/// Checks for `${` in command string values.
pub(super) fn check_p06_no_shell_interpolation(pipe: &PipelineDef) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for step in &pipe.steps {
        for prop in &step.properties {
            if prop.key.value == "command" {
                check_value_for_shell_interpolation(
                    &prop.value,
                    &pipe.name.value,
                    &step.name.value,
                    prop.span,
                    &mut diags,
                );
            }
        }
    }
    diags
}

/// Check a value for shell interpolation patterns.
fn check_value_for_shell_interpolation(
    value: &Value,
    pipeline_name: &str,
    step_name: &str,
    span: Span,
    diags: &mut Vec<Diagnostic>,
) {
    match value {
        Value::String(sv) => {
            if sv.raw.contains("${") {
                diags.push(Diagnostic::error(
                    "P06",
                    format!(
                        "Pipeline '{}' step '{}' command contains shell interpolation '${{...}}' at line {}. Use the args array instead to prevent injection.",
                        pipeline_name, step_name, span.line
                    ),
                    span,
                ));
            }
        }
        Value::Identifier(id) => {
            if id.contains("${") {
                diags.push(Diagnostic::error(
                    "P06",
                    format!(
                        "Pipeline '{}' step '{}' command contains shell interpolation '${{...}}' at line {}. Use the args array instead to prevent injection.",
                        pipeline_name, step_name, span.line
                    ),
                    span,
                ));
            }
        }
        _ => {}
    }
}

// ── P07: Command allowlist validation ───────────────────────────────

/// P07: When a command allowlist is configured, command values MUST be
/// in the allowlist. Produces warnings (not errors) when not in allowlist.
pub(super) fn check_p07_command_allowlist(
    pipe: &PipelineDef,
    ctx: &ValidationContext,
) -> Vec<Diagnostic> {
    if ctx.command_allowlist.is_empty() {
        return Vec::new();
    }
    let mut diags = Vec::new();
    for step in &pipe.steps {
        for prop in &step.properties {
            if prop.key.value == "command" {
                if let Some(cmd) = extract_command_name(&prop.value) {
                    if !ctx.command_allowlist.iter().any(|a| a == &cmd) {
                        diags.push(Diagnostic::warning(
                            "P07",
                            format!(
                                "Pipeline '{}' step '{}' uses command '{}' which is not in the configured allowlist at line {}.",
                                pipe.name.value, step.name.value, cmd, prop.span.line
                            ),
                            prop.span,
                        ));
                    }
                }
            }
        }
    }
    diags
}

/// Extract the command name from a value.
fn extract_command_name(value: &Value) -> Option<String> {
    match value {
        Value::String(sv) => Some(sv.raw.clone()),
        Value::Identifier(id) => Some(id.clone()),
        _ => None,
    }
}
