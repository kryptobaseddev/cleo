//! Tests for pipeline purity validation rules P01--P07.

use super::*;
use crate::dsl::ast::*;
use crate::dsl::span::Span;
use crate::validate::context::ValidationContext;

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
    let diags = rules::check_p01_no_sessions(&pipe);
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
    let diags = rules::check_p01_no_sessions(&pipe);
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
    let diags = rules::check_p01_no_sessions(&pipe);
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
    let diags = rules::check_p02_no_discretion(&pipe);
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
    let diags = rules::check_p02_no_discretion(&pipe);
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
    let diags = rules::check_p02_no_discretion(&pipe);
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
    let diags = rules::check_p03_no_approval_gates(&pipe);
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
    let diags = rules::check_p03_no_approval_gates(&pipe);
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
    let diags = rules::check_p03_no_approval_gates(&pipe);
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
    let diags = rules::check_p04_no_llm_calls(&pipe);
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
    let diags = rules::check_p04_no_llm_calls(&pipe);
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
    let diags = rules::check_p04_no_llm_calls(&pipe);
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
    let diags = rules::check_p05_deterministic_steps(&pipe);
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
    let diags = rules::check_p05_deterministic_steps(&pipe);
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
    let diags = rules::check_p05_deterministic_steps(&pipe);
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
    let diags = rules::check_p06_no_shell_interpolation(&pipe);
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
    let diags = rules::check_p06_no_shell_interpolation(&pipe);
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
    let diags = rules::check_p06_no_shell_interpolation(&pipe);
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
    let diags = rules::check_p06_no_shell_interpolation(&pipe);
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
    let diags = rules::check_p06_no_shell_interpolation(&pipe);
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
    let diags = rules::check_p07_command_allowlist(&pipe, &ctx);
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
    let diags = rules::check_p07_command_allowlist(&pipe, &ctx);
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
    let diags = rules::check_p07_command_allowlist(&pipe, &ctx);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "P07");
    assert_eq!(
        diags[0].severity,
        crate::validate::diagnostic::Severity::Warning
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
