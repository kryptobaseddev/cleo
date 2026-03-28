//! Hook validation rules H01--H04.
//!
//! These rules enforce event name validity, duplicate prevention, body
//! constraints, and blocking-hook handling for CAAMP canonical hooks.

use crate::dsl::ast::{
    CANONICAL_EVENT_NAMES_CSV, CanonicalEvent, CantDocument, Section, Statement, is_canonical_event,
};
use crate::dsl::span::Span;
use std::collections::HashMap;

use super::context::ValidationContext;
use super::diagnostic::Diagnostic;

/// Runs all hook checks (H01--H04) against `doc`.
pub fn check_all(doc: &CantDocument, _ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    diags.extend(check_h01_canonical_events(doc));
    diags.extend(check_h02_no_duplicate_events(doc));
    diags.extend(check_h03_no_workflow_constructs(doc));
    diags.extend(check_h04_blocking_hooks_handling(doc));
    diags
}

// ── H01: Event name is one of 16 CAAMP canonical events ────────────

/// H01: Hook event names MUST be one of the 16 CAAMP canonical events.
///
/// Note: This overlaps with S06 in scope.rs but is included here for
/// completeness of the hooks module. The validate orchestrator deduplicates.
fn check_h01_canonical_events(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        match section {
            Section::Hook(hook) => {
                check_event_canonical(&hook.event.value, hook.event.span, &mut diags);
            }
            Section::Agent(agent) => {
                for hook in &agent.hooks {
                    check_event_canonical(&hook.event.value, hook.event.span, &mut diags);
                }
            }
            _ => {}
        }
    }
    diags
}

/// Check that an event name is one of the canonical events.
fn check_event_canonical(event: &str, span: Span, diags: &mut Vec<Diagnostic>) {
    if !is_canonical_event(event) {
        diags.push(Diagnostic::error(
            "H01",
            format!(
                "Hook event '{}' at line {} is not a canonical event. Valid events: {}.",
                event, span.line, CANONICAL_EVENT_NAMES_CSV
            ),
            span,
        ));
    }
}

// ── H02: No duplicate `on Event:` blocks for same event in same agent ─

/// H02: No duplicate `on Event:` blocks for the same event within the same
/// agent or at the document top level.
fn check_h02_no_duplicate_events(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    // Track top-level hook events
    let mut top_level_events: HashMap<&str, Span> = HashMap::new();

    for section in &doc.sections {
        match section {
            Section::Hook(hook) => {
                let event = hook.event.value.as_str();
                if let Some(prev_span) = top_level_events.get(event) {
                    diags.push(Diagnostic::error(
                        "H02",
                        format!(
                            "Duplicate hook for event '{}' at line {}. A handler for this event already exists at line {}.",
                            event, hook.event.span.line, prev_span.line
                        ),
                        hook.event.span,
                    ));
                } else {
                    top_level_events.insert(event, hook.event.span);
                }
            }
            Section::Agent(agent) => {
                // Track per-agent hook events
                let mut agent_events: HashMap<&str, Span> = HashMap::new();
                for hook in &agent.hooks {
                    let event = hook.event.value.as_str();
                    if let Some(prev_span) = agent_events.get(event) {
                        diags.push(Diagnostic::error(
                            "H02",
                            format!(
                                "Agent '{}' has duplicate hook for event '{}' at line {}. A handler already exists at line {}.",
                                agent.name.value, event, hook.event.span.line, prev_span.line
                            ),
                            hook.event.span,
                        ));
                    } else {
                        agent_events.insert(event, hook.event.span);
                    }
                }
            }
            _ => {}
        }
    }

    diags
}

// ── H03: Hook body must not contain workflow constructs ──────────────

/// H03: Hook bodies MUST NOT contain workflow-specific constructs
/// (parallel blocks, approval gates).
fn check_h03_no_workflow_constructs(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        match section {
            Section::Hook(hook) => {
                check_hook_body_for_workflow(&hook.body, &hook.event.value, None, &mut diags);
            }
            Section::Agent(agent) => {
                for hook in &agent.hooks {
                    check_hook_body_for_workflow(
                        &hook.body,
                        &hook.event.value,
                        Some(&agent.name.value),
                        &mut diags,
                    );
                }
            }
            _ => {}
        }
    }
    diags
}

/// Check a hook body for forbidden workflow constructs.
fn check_hook_body_for_workflow(
    stmts: &[Statement],
    event: &str,
    agent_name: Option<&str>,
    diags: &mut Vec<Diagnostic>,
) {
    for stmt in stmts {
        match stmt {
            Statement::Parallel(block) => {
                let location = match agent_name {
                    Some(name) => format!("agent '{}' hook '{}'", name, event),
                    None => format!("hook '{}'", event),
                };
                diags.push(Diagnostic::error(
                    "H03",
                    format!(
                        "Parallel block at line {} in {} is not allowed. Hook bodies MUST NOT contain workflow constructs.",
                        block.span.line, location
                    ),
                    block.span,
                ));
            }
            Statement::ApprovalGate(gate) => {
                let location = match agent_name {
                    Some(name) => format!("agent '{}' hook '{}'", name, event),
                    None => format!("hook '{}'", event),
                };
                diags.push(Diagnostic::error(
                    "H03",
                    format!(
                        "Approval gate at line {} in {} is not allowed. Hook bodies MUST NOT contain workflow constructs.",
                        gate.span.line, location
                    ),
                    gate.span,
                ));
            }
            // Recurse into nested constructs
            Statement::Conditional(cond) => {
                check_hook_body_for_workflow(&cond.then_body, event, agent_name, diags);
                for elif in &cond.elif_branches {
                    check_hook_body_for_workflow(&elif.body, event, agent_name, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_hook_body_for_workflow(else_body, event, agent_name, diags);
                }
            }
            Statement::Repeat(r) => {
                check_hook_body_for_workflow(&r.body, event, agent_name, diags);
            }
            Statement::ForLoop(f) => {
                check_hook_body_for_workflow(&f.body, event, agent_name, diags);
            }
            Statement::LoopUntil(l) => {
                check_hook_body_for_workflow(&l.body, event, agent_name, diags);
            }
            Statement::TryCatch(tc) => {
                check_hook_body_for_workflow(&tc.try_body, event, agent_name, diags);
                if let Some(cb) = &tc.catch_body {
                    check_hook_body_for_workflow(cb, event, agent_name, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_hook_body_for_workflow(fb, event, agent_name, diags);
                }
            }
            _ => {}
        }
    }
}

// ── H04: Blocking hooks must have explicit handling ─────────────────

/// H04: Blocking hooks (PreToolUse, PermissionRequest) MUST have a
/// non-empty body with explicit handling logic.
fn check_h04_blocking_hooks_handling(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        match section {
            Section::Hook(hook) => {
                check_blocking_hook(&hook.event.value, &hook.body, hook.span, None, &mut diags);
            }
            Section::Agent(agent) => {
                for hook in &agent.hooks {
                    check_blocking_hook(
                        &hook.event.value,
                        &hook.body,
                        hook.span,
                        Some(&agent.name.value),
                        &mut diags,
                    );
                }
            }
            _ => {}
        }
    }
    diags
}

/// Check that a blocking hook has a non-empty body.
fn check_blocking_hook(
    event: &str,
    body: &[Statement],
    span: Span,
    agent_name: Option<&str>,
    diags: &mut Vec<Diagnostic>,
) {
    let is_blocking = CanonicalEvent::from_str(event).is_some_and(|e| e.can_block());
    if !is_blocking {
        return;
    }

    // Filter out comments — only real statements count
    let has_real_stmts = body.iter().any(|s| !matches!(s, Statement::Comment(_)));

    if !has_real_stmts {
        let location = match agent_name {
            Some(name) => format!("agent '{}' hook '{}'", name, event),
            None => format!("hook '{}'", event),
        };
        diags.push(Diagnostic::warning(
            "H04",
            format!(
                "Blocking {} at line {} has no handling logic. Blocking hooks (PreToolUse, PermissionRequest) should contain explicit allow/deny/review logic.",
                location, span.line
            ),
            span,
        ));
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

    fn make_hook(event: &str, body: Vec<Statement>) -> HookDef {
        HookDef {
            event: Spanned::new(event.to_string(), Span::new(0, event.len(), 1, 1)),
            body,
            span: Span::new(0, 20, 1, 1),
        }
    }

    fn make_agent(name: &str, hooks: Vec<HookDef>) -> AgentDef {
        AgentDef {
            name: spanned(name),
            properties: vec![],
            permissions: vec![],
            context_refs: vec![],
            hooks,
            span: dummy_span(),
        }
    }

    fn comment_stmt() -> Statement {
        Statement::Comment(Comment {
            text: "placeholder".to_string(),
            span: dummy_span(),
        })
    }

    fn directive_stmt() -> Statement {
        Statement::Directive(DirectiveStmt {
            verb: "checkin".to_string(),
            addresses: vec!["all".to_string()],
            task_refs: vec![],
            tags: vec![],
            argument: None,
            span: Span::new(0, 15, 2, 1),
        })
    }

    // ── H01 tests ────────────────────────────────────────────────────

    #[test]
    fn h01_valid_event_pass() {
        let doc = make_doc(vec![Section::Hook(make_hook("SessionStart", vec![]))]);
        let diags = check_h01_canonical_events(&doc);
        assert!(diags.is_empty());
    }

    #[test]
    fn h01_invalid_event_error() {
        let doc = make_doc(vec![Section::Hook(make_hook("TaskComplete", vec![]))]);
        let diags = check_h01_canonical_events(&doc);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "H01");
        assert!(diags[0].message.contains("TaskComplete"));
    }

    #[test]
    fn h01_all_canonical_events_pass() {
        for event in CanonicalEvent::ALL {
            let doc = make_doc(vec![Section::Hook(make_hook(event.as_str(), vec![]))]);
            let diags = check_h01_canonical_events(&doc);
            assert!(
                diags.is_empty(),
                "Event '{}' should pass H01",
                event.as_str()
            );
        }
    }

    #[test]
    fn h01_case_sensitive() {
        let doc = make_doc(vec![Section::Hook(make_hook("sessionstart", vec![]))]);
        let diags = check_h01_canonical_events(&doc);
        assert_eq!(diags.len(), 1);
    }

    #[test]
    fn h01_inline_agent_hook() {
        let doc = make_doc(vec![Section::Agent(make_agent(
            "ops",
            vec![make_hook("BadEvent", vec![])],
        ))]);
        let diags = check_h01_canonical_events(&doc);
        assert_eq!(diags.len(), 1);
    }

    // ── H02 tests ────────────────────────────────────────────────────

    #[test]
    fn h02_unique_events_pass() {
        let doc = make_doc(vec![
            Section::Hook(make_hook("SessionStart", vec![])),
            Section::Hook(make_hook("SessionEnd", vec![])),
        ]);
        let diags = check_h02_no_duplicate_events(&doc);
        assert!(diags.is_empty());
    }

    #[test]
    fn h02_duplicate_top_level_error() {
        let doc = make_doc(vec![
            Section::Hook(make_hook("SessionStart", vec![])),
            Section::Hook(make_hook("SessionStart", vec![])),
        ]);
        let diags = check_h02_no_duplicate_events(&doc);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "H02");
    }

    #[test]
    fn h02_duplicate_in_agent_error() {
        let doc = make_doc(vec![Section::Agent(make_agent(
            "ops",
            vec![
                make_hook("PreToolUse", vec![]),
                make_hook("PreToolUse", vec![]),
            ],
        ))]);
        let diags = check_h02_no_duplicate_events(&doc);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "H02");
        assert!(diags[0].message.contains("ops"));
    }

    #[test]
    fn h02_same_event_different_agents_ok() {
        let doc = make_doc(vec![
            Section::Agent(make_agent("a", vec![make_hook("PreToolUse", vec![])])),
            Section::Agent(make_agent("b", vec![make_hook("PreToolUse", vec![])])),
        ]);
        let diags = check_h02_no_duplicate_events(&doc);
        assert!(diags.is_empty());
    }

    #[test]
    fn h02_three_duplicates_two_errors() {
        let doc = make_doc(vec![
            Section::Hook(make_hook("SessionEnd", vec![])),
            Section::Hook(make_hook("SessionEnd", vec![])),
            Section::Hook(make_hook("SessionEnd", vec![])),
        ]);
        let diags = check_h02_no_duplicate_events(&doc);
        assert_eq!(diags.len(), 2);
    }

    // ── H03 tests ────────────────────────────────────────────────────

    #[test]
    fn h03_simple_body_pass() {
        let doc = make_doc(vec![Section::Hook(make_hook(
            "SessionStart",
            vec![directive_stmt()],
        ))]);
        let diags = check_h03_no_workflow_constructs(&doc);
        assert!(diags.is_empty());
    }

    #[test]
    fn h03_parallel_in_hook_error() {
        let doc = make_doc(vec![Section::Hook(make_hook(
            "SessionStart",
            vec![Statement::Parallel(ParallelBlock {
                modifier: None,
                arms: vec![],
                span: Span::new(0, 20, 3, 1),
            })],
        ))]);
        let diags = check_h03_no_workflow_constructs(&doc);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "H03");
        assert!(diags[0].message.contains("Parallel"));
    }

    #[test]
    fn h03_approval_in_hook_error() {
        let doc = make_doc(vec![Section::Hook(make_hook(
            "PreToolUse",
            vec![Statement::ApprovalGate(ApprovalGate {
                properties: vec![],
                span: Span::new(0, 20, 3, 1),
            })],
        ))]);
        let diags = check_h03_no_workflow_constructs(&doc);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "H03");
        assert!(diags[0].message.contains("Approval"));
    }

    #[test]
    fn h03_nested_parallel_in_conditional_error() {
        let doc = make_doc(vec![Section::Hook(make_hook(
            "SessionStart",
            vec![Statement::Conditional(Conditional {
                condition: Condition::Expression(Expression::Boolean(BooleanExpr {
                    value: true,
                    span: dummy_span(),
                })),
                then_body: vec![Statement::Parallel(ParallelBlock {
                    modifier: None,
                    arms: vec![],
                    span: Span::new(0, 20, 5, 1),
                })],
                elif_branches: vec![],
                else_body: None,
                span: dummy_span(),
            })],
        ))]);
        let diags = check_h03_no_workflow_constructs(&doc);
        assert_eq!(diags.len(), 1);
    }

    #[test]
    fn h03_agent_inline_hook_error() {
        let doc = make_doc(vec![Section::Agent(make_agent(
            "ops",
            vec![make_hook(
                "SessionStart",
                vec![Statement::Parallel(ParallelBlock {
                    modifier: None,
                    arms: vec![],
                    span: Span::new(0, 20, 3, 1),
                })],
            )],
        ))]);
        let diags = check_h03_no_workflow_constructs(&doc);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("ops"));
    }

    // ── H04 tests ────────────────────────────────────────────────────

    #[test]
    fn h04_non_blocking_empty_ok() {
        let doc = make_doc(vec![Section::Hook(make_hook("SessionStart", vec![]))]);
        let diags = check_h04_blocking_hooks_handling(&doc);
        assert!(diags.is_empty());
    }

    #[test]
    fn h04_blocking_with_body_pass() {
        let doc = make_doc(vec![Section::Hook(make_hook(
            "PreToolUse",
            vec![directive_stmt()],
        ))]);
        let diags = check_h04_blocking_hooks_handling(&doc);
        assert!(diags.is_empty());
    }

    #[test]
    fn h04_blocking_empty_body_warning() {
        let doc = make_doc(vec![Section::Hook(make_hook("PreToolUse", vec![]))]);
        let diags = check_h04_blocking_hooks_handling(&doc);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "H04");
        assert_eq!(
            diags[0].severity,
            super::super::diagnostic::Severity::Warning
        );
    }

    #[test]
    fn h04_permission_request_empty_warning() {
        let doc = make_doc(vec![Section::Hook(make_hook("PermissionRequest", vec![]))]);
        let diags = check_h04_blocking_hooks_handling(&doc);
        assert_eq!(diags.len(), 1);
    }

    #[test]
    fn h04_blocking_with_only_comments_warning() {
        let doc = make_doc(vec![Section::Hook(make_hook(
            "PreToolUse",
            vec![comment_stmt()],
        ))]);
        let diags = check_h04_blocking_hooks_handling(&doc);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "H04");
    }

    #[test]
    fn h04_agent_blocking_hook_warning() {
        let doc = make_doc(vec![Section::Agent(make_agent(
            "scanner",
            vec![make_hook("PermissionRequest", vec![])],
        ))]);
        let diags = check_h04_blocking_hooks_handling(&doc);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("scanner"));
    }

    // ── check_all integration ───────────────────────────────────────

    #[test]
    fn check_all_valid_hooks_pass() {
        let doc = make_doc(vec![
            Section::Hook(make_hook("SessionStart", vec![directive_stmt()])),
            Section::Hook(make_hook("PreToolUse", vec![directive_stmt()])),
        ]);
        let ctx = ValidationContext::new();
        let diags = check_all(&doc, &ctx);
        assert!(diags.is_empty());
    }

    #[test]
    fn check_all_multiple_violations() {
        // Invalid event (H01) + duplicate (H02) + empty blocking (H04)
        let doc = make_doc(vec![
            Section::Hook(make_hook("PreToolUse", vec![])),
            Section::Hook(make_hook("PreToolUse", vec![])),
        ]);
        let ctx = ValidationContext::new();
        let diags = check_all(&doc, &ctx);
        // H02 duplicate (1 error) + H04 empty blocking (2 warnings)
        assert!(diags.iter().any(|d| d.rule_id == "H02"));
        assert!(diags.iter().any(|d| d.rule_id == "H04"));
    }
}
