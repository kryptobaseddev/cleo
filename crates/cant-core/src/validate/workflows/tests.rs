//! Tests for workflow validation rules W01--W11.

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
    let diags = rules::check_w01_approval_message(&wf);
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
    let diags = rules::check_w01_approval_message(&wf);
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
    let diags = rules::check_w01_approval_message(&wf);
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
    let diags = rules::check_w03_session_prompts(&wf);
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
    let diags = rules::check_w03_session_prompts(&wf);
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
    let diags = rules::check_w03_session_prompts(&wf);
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
    let diags = rules::check_w04_loop_iterables(&wf);
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
    let diags = rules::check_w04_loop_iterables(&wf);
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
    let diags = rules::check_w04_loop_iterables(&wf);
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
    let diags = rules::check_w05_try_blocks(&wf);
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
    let diags = rules::check_w05_try_blocks(&wf);
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
    let diags = rules::check_w05_try_blocks(&wf);
    assert_eq!(diags.len(), 1);
}

// ── W06 tests ────────────────────────────────────────────────────

#[test]
fn w06_valid_name_pass() {
    let wf = make_wf("deploy-pipeline", vec![]);
    let diags = rules::check_w06_workflow_names(&wf);
    assert!(diags.is_empty());
}

#[test]
fn w06_underscore_start_pass() {
    let wf = make_wf("_internal", vec![]);
    let diags = rules::check_w06_workflow_names(&wf);
    assert!(diags.is_empty());
}

#[test]
fn w06_digit_start_error() {
    let wf = make_wf("123invalid", vec![]);
    let diags = rules::check_w06_workflow_names(&wf);
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
    let diags = rules::check_w06_workflow_names(&wf);
    assert_eq!(diags.len(), 1);
}

#[test]
fn w06_special_chars_error() {
    let wf = make_wf("deploy.prod", vec![]);
    let diags = rules::check_w06_workflow_names(&wf);
    assert_eq!(diags.len(), 1);
}

// ── W07 tests ────────────────────────────────────────────────────

#[test]
fn w07_no_unreachable_pass() {
    let wf = make_wf("deploy", vec![directive_stmt(), directive_stmt()]);
    let diags = limits::check_w07_unreachable_code(&wf);
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
    let diags = limits::check_w07_unreachable_code(&wf);
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
    let diags = limits::check_w07_unreachable_code(&wf);
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
    let diags = limits::check_w08_timeout_limits(&wf, &ctx);
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
    let diags = limits::check_w08_timeout_limits(&wf, &ctx);
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
    let diags = limits::check_w08_timeout_limits(&wf, &ctx);
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
    let diags = limits::check_w09_parallel_arm_limits(&wf, &ctx);
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
    let diags = limits::check_w09_parallel_arm_limits(&wf, &ctx);
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
    let diags = limits::check_w10_repeat_count_limits(&wf, &ctx);
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
    let diags = limits::check_w10_repeat_count_limits(&wf, &ctx);
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
    let diags = limits::check_w10_repeat_count_limits(&wf, &ctx);
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
    let diags = limits::check_w11_nesting_depth(&wf, &ctx);
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
    let diags = limits::check_w11_nesting_depth(&wf, &ctx);
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
    let diags = limits::check_w11_nesting_depth(&wf, &ctx);
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
