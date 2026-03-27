//! Tests for type validation rules T01--T07.

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

// ── T01 tests ────────────────────────────────────────────────────

#[test]
fn t01_model_string_pass() {
    let doc = make_doc(vec![Section::Agent(AgentDef {
        name: spanned("test"),
        properties: vec![make_prop("model", string_val("opus"))],
        permissions: vec![],
        hooks: vec![],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t01_property_types(&doc);
    assert!(diags.is_empty());
}

#[test]
fn t01_model_number_error() {
    let doc = make_doc(vec![Section::Agent(AgentDef {
        name: spanned("test"),
        properties: vec![make_prop("model", Value::Number(42.0))],
        permissions: vec![],
        hooks: vec![],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t01_property_types(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "T01");
    assert!(diags[0].message.contains("model"));
}

#[test]
fn t01_timeout_duration_pass() {
    let doc = make_doc(vec![Section::Pipeline(PipelineDef {
        name: spanned("deploy"),
        params: vec![],
        steps: vec![PipeStep {
            name: spanned("build"),
            properties: vec![make_prop(
                "timeout",
                Value::Duration(DurationValue {
                    amount: 120,
                    unit: DurationUnit::Seconds,
                    span: dummy_span(),
                }),
            )],
            span: dummy_span(),
        }],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t01_property_types(&doc);
    assert!(diags.is_empty());
}

#[test]
fn t01_timeout_string_error() {
    let doc = make_doc(vec![Section::Pipeline(PipelineDef {
        name: spanned("deploy"),
        params: vec![],
        steps: vec![PipeStep {
            name: spanned("build"),
            properties: vec![make_prop("timeout", string_val("120s"))],
            span: dummy_span(),
        }],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t01_property_types(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "T01");
    assert!(diags[0].message.contains("timeout"));
}

#[test]
fn t01_persist_boolean_pass() {
    let doc = make_doc(vec![Section::Agent(AgentDef {
        name: spanned("test"),
        properties: vec![make_prop("persist", Value::Boolean(true))],
        permissions: vec![],
        hooks: vec![],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t01_property_types(&doc);
    assert!(diags.is_empty());
}

#[test]
fn t01_persist_string_error() {
    let doc = make_doc(vec![Section::Agent(AgentDef {
        name: spanned("test"),
        properties: vec![make_prop("persist", string_val("true"))],
        permissions: vec![],
        hooks: vec![],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t01_property_types(&doc);
    assert_eq!(diags.len(), 1);
}

// ── T02 tests ────────────────────────────────────────────────────

#[test]
fn t02_same_type_comparison_pass() {
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Conditional(Conditional {
            condition: Condition::Expression(Expression::Comparison(ComparisonExpr {
                left: Box::new(Expression::Number(NumberExpr {
                    value: 1.0,
                    span: dummy_span(),
                })),
                op: ComparisonOp::Eq,
                right: Box::new(Expression::Number(NumberExpr {
                    value: 2.0,
                    span: dummy_span(),
                })),
                span: Span::new(0, 10, 5, 1),
            })),
            then_body: vec![],
            elif_branches: vec![],
            else_body: None,
            span: dummy_span(),
        })],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t02_comparison_types(&doc);
    assert!(diags.is_empty());
}

#[test]
fn t02_mixed_type_comparison_warning() {
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Conditional(Conditional {
            condition: Condition::Expression(Expression::Comparison(ComparisonExpr {
                left: Box::new(Expression::Number(NumberExpr {
                    value: 1.0,
                    span: dummy_span(),
                })),
                op: ComparisonOp::Eq,
                right: Box::new(Expression::String(StringExpr {
                    segments: vec![StringSegment::Literal("hello".to_string())],
                    span: dummy_span(),
                })),
                span: Span::new(0, 10, 5, 1),
            })),
            then_body: vec![],
            elif_branches: vec![],
            else_body: None,
            span: dummy_span(),
        })],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t02_comparison_types(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "T02");
}

#[test]
fn t02_unknown_types_no_warning() {
    // Name expressions have unknown type at static analysis; no warning
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Conditional(Conditional {
            condition: Condition::Expression(Expression::Comparison(ComparisonExpr {
                left: Box::new(Expression::Name(NameExpr {
                    name: "x".to_string(),
                    span: dummy_span(),
                })),
                op: ComparisonOp::Eq,
                right: Box::new(Expression::Number(NumberExpr {
                    value: 1.0,
                    span: dummy_span(),
                })),
                span: Span::new(0, 10, 5, 1),
            })),
            then_body: vec![],
            elif_branches: vec![],
            else_body: None,
            span: dummy_span(),
        })],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t02_comparison_types(&doc);
    assert!(diags.is_empty());
}

// ── T03 tests ────────────────────────────────────────────────────

#[test]
fn t03_stringifiable_interp_pass() {
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Expression(Expression::String(StringExpr {
            segments: vec![
                StringSegment::Literal("Hello ".to_string()),
                StringSegment::Interpolation(Expression::Name(NameExpr {
                    name: "user".to_string(),
                    span: dummy_span(),
                })),
            ],
            span: Span::new(0, 20, 3, 1),
        }))],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t03_interpolation_operands(&doc);
    assert!(diags.is_empty());
}

#[test]
fn t03_array_interp_warning() {
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Expression(Expression::String(StringExpr {
            segments: vec![
                StringSegment::Literal("Items: ".to_string()),
                StringSegment::Interpolation(Expression::Array(ArrayExpr {
                    elements: vec![],
                    span: dummy_span(),
                })),
            ],
            span: Span::new(0, 20, 3, 1),
        }))],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t03_interpolation_operands(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "T03");
}

#[test]
fn t03_boolean_interp_warning() {
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Expression(Expression::String(StringExpr {
            segments: vec![
                StringSegment::Literal("Flag: ".to_string()),
                StringSegment::Interpolation(Expression::Boolean(BooleanExpr {
                    value: true,
                    span: dummy_span(),
                })),
            ],
            span: Span::new(0, 20, 3, 1),
        }))],
        span: dummy_span(),
    })]);
    let diags = property_rules::check_t03_interpolation_operands(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "T03");
}

// ── T04 tests ────────────────────────────────────────────────────

#[test]
fn t04_defined_context_pass() {
    let mut ctx = ValidationContext::new();
    ctx.defined_agents
        .insert("scanner".to_string(), dummy_span());
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Session(SessionExpr {
            target: SessionTarget::Prompt("Review".to_string()),
            properties: vec![make_prop(
                "context",
                Value::Identifier("scanner".to_string()),
            )],
            span: dummy_span(),
        })],
        span: dummy_span(),
    })]);
    let diags = context_rules::check_t04_context_references(&doc, &ctx);
    assert!(diags.is_empty());
}

#[test]
fn t04_undefined_context_warning() {
    let ctx = ValidationContext::new();
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Session(SessionExpr {
            target: SessionTarget::Prompt("Review".to_string()),
            properties: vec![make_prop(
                "context",
                Value::Identifier("nonexistent".to_string()),
            )],
            span: dummy_span(),
        })],
        span: dummy_span(),
    })]);
    let diags = context_rules::check_t04_context_references(&doc, &ctx);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "T04");
}

#[test]
fn t04_string_context_ignored() {
    let ctx = ValidationContext::new();
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Session(SessionExpr {
            target: SessionTarget::Prompt("Review".to_string()),
            properties: vec![make_prop("context", string_val("inline context"))],
            span: dummy_span(),
        })],
        span: dummy_span(),
    })]);
    let diags = context_rules::check_t04_context_references(&doc, &ctx);
    assert!(diags.is_empty());
}

// ── T06 tests ────────────────────────────────────────────────────

#[test]
fn t06_string_message_pass() {
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::ApprovalGate(ApprovalGate {
            properties: vec![make_prop("message", string_val("Ready to deploy?"))],
            span: dummy_span(),
        })],
        span: dummy_span(),
    })]);
    let diags = context_rules::check_t06_approval_message_type(&doc);
    assert!(diags.is_empty());
}

#[test]
fn t06_number_message_error() {
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::ApprovalGate(ApprovalGate {
            properties: vec![make_prop("message", Value::Number(42.0))],
            span: dummy_span(),
        })],
        span: dummy_span(),
    })]);
    let diags = context_rules::check_t06_approval_message_type(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "T06");
}

#[test]
fn t06_boolean_message_error() {
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::ApprovalGate(ApprovalGate {
            properties: vec![make_prop("message", Value::Boolean(true))],
            span: dummy_span(),
        })],
        span: dummy_span(),
    })]);
    let diags = context_rules::check_t06_approval_message_type(&doc);
    assert_eq!(diags.len(), 1);
}

// ── T07 tests ────────────────────────────────────────────────────

#[test]
fn t07_simple_interpolation_pass() {
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Expression(Expression::String(StringExpr {
            segments: vec![
                StringSegment::Literal("Hello ".to_string()),
                StringSegment::Interpolation(Expression::Name(NameExpr {
                    name: "name".to_string(),
                    span: dummy_span(),
                })),
            ],
            span: Span::new(0, 20, 3, 1),
        }))],
        span: dummy_span(),
    })]);
    let diags = context_rules::check_t07_no_nested_interpolation(&doc);
    assert!(diags.is_empty());
}

#[test]
fn t07_nested_interpolation_error() {
    // "${outer_${inner}}" -- the inner expression is itself an interpolation
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Expression(Expression::String(StringExpr {
            segments: vec![StringSegment::Interpolation(Expression::Interpolation(
                InterpolationExpr {
                    expression: Box::new(Expression::Name(NameExpr {
                        name: "inner".to_string(),
                        span: dummy_span(),
                    })),
                    span: dummy_span(),
                },
            ))],
            span: Span::new(0, 20, 3, 1),
        }))],
        span: dummy_span(),
    })]);
    let diags = context_rules::check_t07_no_nested_interpolation(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "T07");
}

#[test]
fn t07_string_with_interpolation_inside_interpolation() {
    // "${a_string_with_${x}}" -- inner string contains interpolation
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Expression(Expression::String(StringExpr {
            segments: vec![StringSegment::Interpolation(Expression::String(
                StringExpr {
                    segments: vec![
                        StringSegment::Literal("prefix_".to_string()),
                        StringSegment::Interpolation(Expression::Name(NameExpr {
                            name: "x".to_string(),
                            span: dummy_span(),
                        })),
                    ],
                    span: dummy_span(),
                },
            ))],
            span: Span::new(0, 30, 3, 1),
        }))],
        span: dummy_span(),
    })]);
    let diags = context_rules::check_t07_no_nested_interpolation(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "T07");
}

// ── check_all integration ───────────────────────────────────────

#[test]
fn check_all_clean_document_passes() {
    let doc = make_doc(vec![Section::Agent(AgentDef {
        name: spanned("ops"),
        properties: vec![
            make_prop("model", string_val("opus")),
            make_prop("persist", Value::Boolean(true)),
        ],
        permissions: vec![],
        hooks: vec![],
        span: dummy_span(),
    })]);
    let ctx = ValidationContext::new();
    let diags = check_all(&doc, &ctx);
    assert!(diags.is_empty());
}
