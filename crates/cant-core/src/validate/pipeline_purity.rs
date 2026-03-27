//! Pipeline purity validation rules P01--P07.
//!
//! Pipelines MUST be deterministic: they cannot contain LLM sessions,
//! discretion conditions, approval gates, or shell-injectable commands.

use crate::dsl::ast::{CantDocument, PipelineDef, Property, Section, Statement, Value};
use crate::dsl::span::Span;

use super::context::ValidationContext;
use super::diagnostic::Diagnostic;

/// Runs all pipeline purity checks (P01--P07) against `doc`.
pub fn check_all(doc: &CantDocument, ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        if let Section::Pipeline(pipe) = section {
            diags.extend(check_p01_no_sessions(pipe));
            diags.extend(check_p02_no_discretion(pipe));
            diags.extend(check_p03_no_approval_gates(pipe));
            diags.extend(check_p04_no_llm_calls(pipe));
            diags.extend(check_p05_deterministic_steps(pipe));
            diags.extend(check_p06_no_shell_interpolation(pipe));
            diags.extend(check_p07_command_allowlist(pipe, ctx));
        }
        // Also check inline pipeline statements inside workflows
        if let Section::Workflow(wf) = section {
            check_inline_pipelines(&wf.body, ctx, &mut diags);
        }
    }
    diags
}

/// Recursively find inline pipeline statements within workflow bodies.
fn check_inline_pipelines(
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
fn check_p01_no_sessions(pipe: &PipelineDef) -> Vec<Diagnostic> {
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
fn check_p02_no_discretion(pipe: &PipelineDef) -> Vec<Diagnostic> {
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
fn check_p03_no_approval_gates(pipe: &PipelineDef) -> Vec<Diagnostic> {
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
fn check_p04_no_llm_calls(pipe: &PipelineDef) -> Vec<Diagnostic> {
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
fn check_p05_deterministic_steps(pipe: &PipelineDef) -> Vec<Diagnostic> {
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
fn check_p06_no_shell_interpolation(pipe: &PipelineDef) -> Vec<Diagnostic> {
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
fn check_p07_command_allowlist(pipe: &PipelineDef, ctx: &ValidationContext) -> Vec<Diagnostic> {
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

    fn make_pipe(name: &str, steps: Vec<PipeStep>) -> PipelineDef {
        PipelineDef {
            name: spanned(name),
            params: vec![],
            steps,
            span: dummy_span(),
        }
    }

    fn make_step(name: &str, properties: Vec<Property>) -> PipeStep {
        PipeStep {
            name: spanned(name),
            properties,
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

    fn make_doc(sections: Vec<Section>) -> CantDocument {
        CantDocument {
            kind: None,
            frontmatter: None,
            sections,
            span: dummy_span(),
        }
    }

    // ── P01 tests ────────────────────────────────────────────────────

    #[test]
    fn p01_no_session_pass() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("command", string_val("make"))],
            )],
        );
        let diags = check_p01_no_sessions(&pipe);
        assert!(diags.is_empty());
    }

    #[test]
    fn p01_session_in_step_error() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "analyze",
                vec![make_prop("session", string_val("Analyze code"))],
            )],
        );
        let diags = check_p01_no_sessions(&pipe);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "P01");
    }

    #[test]
    fn p01_multiple_steps_one_session() {
        let pipe = make_pipe(
            "deploy",
            vec![
                make_step("build", vec![make_prop("command", string_val("make"))]),
                make_step(
                    "review",
                    vec![make_prop("session", string_val("review this"))],
                ),
            ],
        );
        let diags = check_p01_no_sessions(&pipe);
        assert_eq!(diags.len(), 1);
    }

    // ── P02 tests ────────────────────────────────────────────────────

    #[test]
    fn p02_no_discretion_pass() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("condition", string_val("status == 'ready'"))],
            )],
        );
        let diags = check_p02_no_discretion(&pipe);
        assert!(diags.is_empty());
    }

    #[test]
    fn p02_discretion_condition_error() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "check",
                vec![make_prop(
                    "condition",
                    string_val("**looks good to deploy**"),
                )],
            )],
        );
        let diags = check_p02_no_discretion(&pipe);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "P02");
    }

    #[test]
    fn p02_non_condition_property_ignored() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "check",
                vec![make_prop("description", string_val("**bold text**"))],
            )],
        );
        let diags = check_p02_no_discretion(&pipe);
        assert!(diags.is_empty());
    }

    // ── P03 tests ────────────────────────────────────────────────────

    #[test]
    fn p03_no_approval_pass() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("command", string_val("make"))],
            )],
        );
        let diags = check_p03_no_approval_gates(&pipe);
        assert!(diags.is_empty());
    }

    #[test]
    fn p03_approval_in_step_error() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "gate",
                vec![make_prop("approve", string_val("Ready?"))],
            )],
        );
        let diags = check_p03_no_approval_gates(&pipe);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "P03");
    }

    #[test]
    fn p03_approval_key_variant() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "gate",
                vec![make_prop("approval", string_val("Ready?"))],
            )],
        );
        let diags = check_p03_no_approval_gates(&pipe);
        assert_eq!(diags.len(), 1);
    }

    // ── P04 tests ────────────────────────────────────────────────────

    #[test]
    fn p04_no_llm_pass() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("command", string_val("make"))],
            )],
        );
        let diags = check_p04_no_llm_calls(&pipe);
        assert!(diags.is_empty());
    }

    #[test]
    fn p04_model_property_error() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "analyze",
                vec![make_prop("model", string_val("opus"))],
            )],
        );
        let diags = check_p04_no_llm_calls(&pipe);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "P04");
    }

    #[test]
    fn p04_prompt_property_error() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "analyze",
                vec![make_prop("prompt", string_val("Analyze this"))],
            )],
        );
        let diags = check_p04_no_llm_calls(&pipe);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "P04");
    }

    // ── P05 tests ────────────────────────────────────────────────────

    #[test]
    fn p05_deterministic_pass() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("command", string_val("make"))],
            )],
        );
        let diags = check_p05_deterministic_steps(&pipe);
        assert!(diags.is_empty());
    }

    #[test]
    fn p05_non_deterministic_property_error() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "check",
                vec![make_prop("discretion", string_val("evaluate quality"))],
            )],
        );
        let diags = check_p05_deterministic_steps(&pipe);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "P05");
    }

    #[test]
    fn p05_llm_property_error() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "check",
                vec![make_prop("llm", string_val("true"))],
            )],
        );
        let diags = check_p05_deterministic_steps(&pipe);
        assert_eq!(diags.len(), 1);
    }

    // ── P06 tests ────────────────────────────────────────────────────

    #[test]
    fn p06_clean_command_pass() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("command", string_val("pnpm"))],
            )],
        );
        let diags = check_p06_no_shell_interpolation(&pipe);
        assert!(diags.is_empty());
    }

    #[test]
    fn p06_shell_interpolation_error() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("command", string_val("bash -c ${USER_INPUT}"))],
            )],
        );
        let diags = check_p06_no_shell_interpolation(&pipe);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "P06");
        assert!(diags[0].message.contains("shell interpolation"));
    }

    #[test]
    fn p06_identifier_with_interpolation_error() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop(
                    "command",
                    Value::Identifier("echo ${SECRET}".to_string()),
                )],
            )],
        );
        let diags = check_p06_no_shell_interpolation(&pipe);
        assert_eq!(diags.len(), 1);
    }

    #[test]
    fn p06_non_command_property_ignored() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("description", string_val("Uses ${var} pattern"))],
            )],
        );
        let diags = check_p06_no_shell_interpolation(&pipe);
        assert!(diags.is_empty());
    }

    #[test]
    fn p06_args_property_not_checked() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("args", string_val("${arg}"))],
            )],
        );
        let diags = check_p06_no_shell_interpolation(&pipe);
        assert!(diags.is_empty());
    }

    // ── P07 tests ────────────────────────────────────────────────────

    #[test]
    fn p07_no_allowlist_disabled() {
        let ctx = ValidationContext::new();
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("command", string_val("anything"))],
            )],
        );
        let diags = check_p07_command_allowlist(&pipe, &ctx);
        assert!(diags.is_empty());
    }

    #[test]
    fn p07_command_in_allowlist_pass() {
        let mut ctx = ValidationContext::new();
        ctx.command_allowlist = vec!["make".to_string(), "pnpm".to_string()];
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("command", string_val("make"))],
            )],
        );
        let diags = check_p07_command_allowlist(&pipe, &ctx);
        assert!(diags.is_empty());
    }

    #[test]
    fn p07_command_not_in_allowlist_warning() {
        let mut ctx = ValidationContext::new();
        ctx.command_allowlist = vec!["make".to_string(), "pnpm".to_string()];
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![make_prop("command", string_val("rm"))],
            )],
        );
        let diags = check_p07_command_allowlist(&pipe, &ctx);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "P07");
        assert_eq!(
            diags[0].severity,
            super::super::diagnostic::Severity::Warning
        );
    }

    // ── check_all integration test ──────────────────────────────────

    #[test]
    fn check_all_runs_all_rules() {
        let pipe = make_pipe(
            "bad",
            vec![make_step(
                "evil",
                vec![
                    make_prop("command", string_val("bash -c ${INJECT}")),
                    make_prop("model", string_val("opus")),
                ],
            )],
        );
        let doc = make_doc(vec![Section::Pipeline(pipe)]);
        let ctx = ValidationContext::new();
        let diags = check_all(&doc, &ctx);
        // Should have P04 (model) + P06 (interpolation) at minimum
        assert!(diags.iter().any(|d| d.rule_id == "P04"));
        assert!(diags.iter().any(|d| d.rule_id == "P06"));
    }

    #[test]
    fn check_all_clean_pipeline_passes() {
        let pipe = make_pipe(
            "deploy",
            vec![make_step(
                "build",
                vec![
                    make_prop("command", string_val("pnpm")),
                    make_prop(
                        "timeout",
                        Value::Duration(DurationValue {
                            amount: 120,
                            unit: DurationUnit::Seconds,
                            span: dummy_span(),
                        }),
                    ),
                ],
            )],
        );
        let doc = make_doc(vec![Section::Pipeline(pipe)]);
        let ctx = ValidationContext::new();
        let diags = check_all(&doc, &ctx);
        assert!(diags.is_empty());
    }
}
