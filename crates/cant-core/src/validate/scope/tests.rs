//! Tests for scope validation rules S01--S13.

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

fn make_agent(name: &str, line: u32) -> AgentDef {
    AgentDef {
        name: Spanned::new(name.to_string(), Span::new(0, name.len(), line, 1)),
        properties: vec![],
        permissions: vec![],
        hooks: vec![],
        span: dummy_span(),
    }
}

fn make_skill(name: &str, line: u32) -> SkillDef {
    SkillDef {
        name: Spanned::new(name.to_string(), Span::new(0, name.len(), line, 1)),
        properties: vec![],
        span: dummy_span(),
    }
}

fn make_doc(sections: Vec<Section>) -> CantDocument {
    CantDocument {
        kind: None,
        frontmatter: None,
        sections,
        span: dummy_span(),
    }
}

// ── S05 tests ────────────────────────────────────────────────────

#[test]
fn s05_unique_agents_pass() {
    let doc = make_doc(vec![
        Section::Agent(make_agent("a", 1)),
        Section::Agent(make_agent("b", 2)),
    ]);
    let mut ctx = ValidationContext::new();
    let diags = check_unique_names(&doc, &mut ctx);
    assert!(diags.is_empty());
}

#[test]
fn s05_duplicate_agent_error() {
    let doc = make_doc(vec![
        Section::Agent(make_agent("scanner", 1)),
        Section::Agent(make_agent("scanner", 5)),
    ]);
    let mut ctx = ValidationContext::new();
    let diags = check_unique_names(&doc, &mut ctx);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "S05");
    assert!(diags[0].message.contains("Duplicate agent name 'scanner'"));
}

#[test]
fn s05_duplicate_skill_error() {
    let doc = make_doc(vec![
        Section::Skill(make_skill("ct-deploy", 1)),
        Section::Skill(make_skill("ct-deploy", 5)),
    ]);
    let mut ctx = ValidationContext::new();
    let diags = check_unique_names(&doc, &mut ctx);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "S05");
}

#[test]
fn s05_different_kinds_same_name_ok() {
    let doc = make_doc(vec![
        Section::Agent(make_agent("scanner", 1)),
        Section::Skill(make_skill("scanner", 5)),
    ]);
    let mut ctx = ValidationContext::new();
    let diags = check_unique_names(&doc, &mut ctx);
    assert!(diags.is_empty());
}

// ── S06 tests ────────────────────────────────────────────────────

#[test]
fn s06_valid_event_pass() {
    let doc = make_doc(vec![Section::Hook(HookDef {
        event: Spanned::new("SessionStart".to_string(), Span::new(0, 12, 1, 1)),
        body: vec![],
        span: dummy_span(),
    })]);
    let diags = check_valid_hook_events(&doc);
    assert!(diags.is_empty());
}

#[test]
fn s06_invalid_event_error() {
    let doc = make_doc(vec![Section::Hook(HookDef {
        event: Spanned::new("TaskComplete".to_string(), Span::new(0, 12, 1, 1)),
        body: vec![],
        span: dummy_span(),
    })]);
    let diags = check_valid_hook_events(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "S06");
    assert!(diags[0].message.contains("Unknown event 'TaskComplete'"));
}

#[test]
fn s06_case_sensitive() {
    let doc = make_doc(vec![Section::Hook(HookDef {
        event: Spanned::new("sessionstart".to_string(), Span::new(0, 12, 1, 1)),
        body: vec![],
        span: dummy_span(),
    })]);
    let diags = check_valid_hook_events(&doc);
    assert_eq!(diags.len(), 1);
}

#[test]
fn s06_inline_hook_in_agent() {
    let mut agent = make_agent("test", 1);
    agent.hooks.push(HookDef {
        event: Spanned::new("InvalidEvent".to_string(), Span::new(0, 5, 3, 1)),
        body: vec![],
        span: dummy_span(),
    });
    let doc = make_doc(vec![Section::Agent(agent)]);
    let diags = check_valid_hook_events(&doc);
    assert_eq!(diags.len(), 1);
}

// ── S07 tests ────────────────────────────────────────────────────

#[test]
fn s07_unique_arms_pass() {
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Parallel(ParallelBlock {
            modifier: None,
            arms: vec![
                ParallelArm {
                    name: "a".to_string(),
                    body: Box::new(Statement::Comment(Comment {
                        text: "".to_string(),
                        span: dummy_span(),
                    })),
                    span: Span::new(0, 5, 1, 1),
                },
                ParallelArm {
                    name: "b".to_string(),
                    body: Box::new(Statement::Comment(Comment {
                        text: "".to_string(),
                        span: dummy_span(),
                    })),
                    span: Span::new(0, 5, 2, 1),
                },
            ],
            span: dummy_span(),
        })],
        span: dummy_span(),
    })]);
    let diags = check_unique_parallel_arms(&doc);
    assert!(diags.is_empty());
}

#[test]
fn s07_duplicate_arms_error() {
    let doc = make_doc(vec![Section::Workflow(WorkflowDef {
        name: spanned("wf"),
        params: vec![],
        body: vec![Statement::Parallel(ParallelBlock {
            modifier: None,
            arms: vec![
                ParallelArm {
                    name: "analysis".to_string(),
                    body: Box::new(Statement::Comment(Comment {
                        text: "".to_string(),
                        span: dummy_span(),
                    })),
                    span: Span::new(0, 5, 1, 1),
                },
                ParallelArm {
                    name: "analysis".to_string(),
                    body: Box::new(Statement::Comment(Comment {
                        text: "".to_string(),
                        span: dummy_span(),
                    })),
                    span: Span::new(0, 5, 2, 1),
                },
            ],
            span: dummy_span(),
        })],
        span: dummy_span(),
    })]);
    let diags = check_unique_parallel_arms(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "S07");
}

// ── S09 tests ────────────────────────────────────────────────────

#[test]
fn s09_relative_path_ok() {
    let doc = make_doc(vec![Section::Import(ImportStatement {
        path: "./agents/scanner.cant".to_string(),
        alias: None,
        span: dummy_span(),
    })]);
    let diags = check_import_path_traversal(&doc);
    assert!(diags.is_empty());
}

#[test]
fn s09_traversal_error() {
    let doc = make_doc(vec![Section::Import(ImportStatement {
        path: "../../etc/passwd".to_string(),
        alias: None,
        span: dummy_span(),
    })]);
    let diags = check_import_path_traversal(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "S09");
}

#[test]
fn s09_single_parent_from_subdir_ok() {
    // ../shared/utils.cant from a subdir stays within root
    let doc = make_doc(vec![Section::Import(ImportStatement {
        path: "subdir/../shared/utils.cant".to_string(),
        alias: None,
        span: dummy_span(),
    })]);
    let diags = check_import_path_traversal(&doc);
    assert!(diags.is_empty());
}

// ── S10 tests ────────────────────────────────────────────────────

#[test]
fn s10_absolute_path_error() {
    let doc = make_doc(vec![Section::Import(ImportStatement {
        path: "/etc/passwd".to_string(),
        alias: None,
        span: dummy_span(),
    })]);
    let diags = check_import_symlink_escape(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "S10");
}

#[test]
fn s10_relative_path_ok() {
    let doc = make_doc(vec![Section::Import(ImportStatement {
        path: "./agents/scanner.cant".to_string(),
        alias: None,
        span: dummy_span(),
    })]);
    let diags = check_import_symlink_escape(&doc);
    assert!(diags.is_empty());
}

// ── S11 tests ────────────────────────────────────────────────────

#[test]
fn s11_within_limit_pass() {
    let ctx = ValidationContext::new();
    let diags = check_import_depth(&ctx);
    assert!(diags.is_empty());
}

#[test]
fn s11_exceeds_limit_error() {
    let mut ctx = ValidationContext::new();
    ctx.limits.max_import_depth = 3;
    ctx.import_chain = vec![
        "a.cant".to_string(),
        "b.cant".to_string(),
        "c.cant".to_string(),
        "d.cant".to_string(),
    ];
    let diags = check_import_depth(&ctx);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "S11");
}

// ── S13 tests ────────────────────────────────────────────────────

#[test]
fn s13_valid_permissions_pass() {
    let mut agent = make_agent("test", 1);
    agent.permissions.push(Permission {
        domain: "tasks".to_string(),
        access: vec!["read".to_string(), "write".to_string()],
        span: dummy_span(),
    });
    let doc = make_doc(vec![Section::Agent(agent)]);
    let diags = check_permission_values(&doc);
    assert!(diags.is_empty());
}

#[test]
fn s13_invalid_permission_error() {
    let mut agent = make_agent("test", 1);
    agent.permissions.push(Permission {
        domain: "tasks".to_string(),
        access: vec!["read".to_string(), "admin".to_string()],
        span: Span::new(0, 10, 3, 1),
    });
    let doc = make_doc(vec![Section::Agent(agent)]);
    let diags = check_permission_values(&doc);
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "S13");
    assert!(diags[0].message.contains("admin"));
}

#[test]
fn s13_execute_is_valid() {
    let mut agent = make_agent("test", 1);
    agent.permissions.push(Permission {
        domain: "tasks".to_string(),
        access: vec!["execute".to_string()],
        span: dummy_span(),
    });
    let doc = make_doc(vec![Section::Agent(agent)]);
    let diags = check_permission_values(&doc);
    assert!(diags.is_empty());
}

// ── S03 tests ────────────────────────────────────────────────────

#[test]
fn s03_no_cycle_pass() {
    let ctx = ValidationContext::new();
    let diags = check_circular_import("b.cant", &ctx, dummy_span());
    assert!(diags.is_empty());
}

#[test]
fn s03_cycle_detected_error() {
    let mut ctx = ValidationContext::new();
    ctx.import_chain = vec!["a.cant".to_string(), "b.cant".to_string()];
    let diags = check_circular_import("a.cant", &ctx, dummy_span());
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "S03");
    assert!(diags[0].message.contains("Circular import chain"));
}

// ── path_escapes_root tests ──────────────────────────────────────

#[test]
fn path_escapes_root_basic() {
    use super::imports::path_escapes_root;
    assert!(path_escapes_root("../../etc/passwd"));
    assert!(path_escapes_root("../../../home"));
    assert!(!path_escapes_root("./agents/scanner.cant"));
    assert!(!path_escapes_root("agents/scanner.cant"));
    assert!(!path_escapes_root("subdir/../shared.cant"));
}
