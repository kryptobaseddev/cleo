//! Tests for the hierarchy lint rules (TEAM-001..003, TIER-001..002, JIT-001, MM-001..002).
//!
//! This file is included by `hierarchy.rs` via `#[cfg(test)]` — it is not a
//! standalone module.

use super::*;
use crate::dsl::ast::{Spanned, StringValue};
use crate::dsl::span::Span;

// ── Builders ──────────────────────────────────────────────────────────

fn dummy_span() -> Span {
    Span::dummy()
}

fn spanned(s: &str) -> Spanned<String> {
    Spanned::new(s.to_string(), dummy_span())
}

fn prop(key: &str, value: Value) -> Property {
    Property {
        key: spanned(key),
        value,
        span: dummy_span(),
    }
}

fn ident(s: &str) -> Value {
    Value::Identifier(s.to_string())
}

fn str_val(s: &str) -> Value {
    Value::String(StringValue {
        raw: s.to_string(),
        double_quoted: true,
        span: dummy_span(),
    })
}

fn make_agent(name: &str, properties: Vec<Property>) -> AgentDef {
    AgentDef {
        name: spanned(name),
        properties,
        permissions: vec![],
        context_refs: vec![],
        hooks: vec![],
        context_sources: vec![],
        mental_model: vec![],
        file_permissions: None,
        span: dummy_span(),
    }
}

fn make_team(name: &str, properties: Vec<Property>) -> TeamDef {
    TeamDef {
        name: spanned(name),
        properties,
        consult_when: None,
        stages: vec![],
        span: dummy_span(),
    }
}

fn make_team_full(
    name: &str,
    properties: Vec<Property>,
    consult_when: Option<String>,
    stages: Vec<String>,
) -> TeamDef {
    TeamDef {
        name: spanned(name),
        properties,
        consult_when,
        stages,
        span: dummy_span(),
    }
}

fn run(section: Section) -> Vec<Diagnostic> {
    let doc = CantDocument {
        kind: None,
        frontmatter: None,
        sections: vec![section],
        span: dummy_span(),
    };
    let ctx = ValidationContext::new();
    check_all(&doc, &ctx)
}

// ── TEAM-001 ──────────────────────────────────────────────────────

#[test]
fn team001_missing_orchestrator_fires() {
    let team = make_team("platform", vec![prop("enforcement", ident("strict"))]);
    let diags = run(Section::Team(team));
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule_id, "TEAM-001");
}

#[test]
fn team001_with_orchestrator_passes() {
    let team = make_team("platform", vec![prop("orchestrator", ident("cleo-prime"))]);
    let diags = run(Section::Team(team));
    assert!(diags.iter().all(|d| d.rule_id != "TEAM-001"));
}

// ── TEAM-002 (Wave 7a: consult-when + stages on team blocks) ─────────

#[test]
fn team002_leads_without_consult_when_fires() {
    let team = make_team(
        "platform",
        vec![
            prop("orchestrator", ident("cleo-prime")),
            prop("leads", ident("engineering-lead")),
        ],
    );
    let diags = run(Section::Team(team));
    let team002: Vec<_> = diags.iter().filter(|d| d.rule_id == "TEAM-002").collect();
    // Should fire for missing consult-when AND missing stages.
    assert!(!team002.is_empty());
    assert!(team002.iter().any(|d| d.message.contains("consult-when")));
}

#[test]
fn team002_leads_without_stages_fires() {
    let team = make_team_full(
        "platform",
        vec![
            prop("orchestrator", ident("cleo-prime")),
            prop("leads", ident("engineering-lead")),
            prop("consult-when", str_val("request spans multiple domains")),
        ],
        Some("request spans multiple domains".to_string()),
        vec![], // no stages
    );
    let diags = run(Section::Team(team));
    let team002: Vec<_> = diags.iter().filter(|d| d.rule_id == "TEAM-002").collect();
    assert!(team002.iter().any(|d| d.message.contains("stages")));
}

#[test]
fn team002_leads_with_consult_when_and_stages_passes() {
    let team = make_team_full(
        "platform",
        vec![
            prop("orchestrator", ident("cleo-prime")),
            prop("leads", ident("engineering-lead")),
            prop("consult-when", str_val("scope exceeds single sprint")),
            prop(
                "stages",
                Value::Array(vec![
                    ident("discover"),
                    ident("plan"),
                    ident("execute"),
                    ident("review"),
                ]),
            ),
        ],
        Some("scope exceeds single sprint".to_string()),
        vec![
            "discover".to_string(),
            "plan".to_string(),
            "execute".to_string(),
            "review".to_string(),
        ],
    );
    let diags = run(Section::Team(team));
    // No TEAM-002 for consult-when or stages.
    assert!(diags.iter().all(|d| d.rule_id != "TEAM-002"));
}

#[test]
fn team002_no_leads_skips_consult_when_check() {
    // A team without a leads sub-block should not fire TEAM-002 for
    // consult-when or stages — those rules only apply when leads exist.
    let team = make_team("minimal", vec![prop("orchestrator", ident("cleo-prime"))]);
    let diags = run(Section::Team(team));
    assert!(diags.iter().all(|d| d.rule_id != "TEAM-002"));
}

// ── TEAM-002 (agent tool blocking) ───────────────────────────────────

#[test]
fn team002_lead_with_write_tool_fires() {
    let agent = make_agent(
        "engineering-lead",
        vec![
            prop("role", ident("lead")),
            prop("core", Value::Array(vec![ident("Read"), ident("Write")])),
        ],
    );
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().any(|d| d.rule_id == "TEAM-002"));
}

#[test]
fn team002_lead_without_write_tool_passes() {
    let agent = make_agent(
        "engineering-lead",
        vec![
            prop("role", ident("lead")),
            prop("core", Value::Array(vec![ident("Read"), ident("Grep")])),
        ],
    );
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "TEAM-002"));
}

#[test]
fn team002_worker_role_not_checked() {
    // Worker holding Edit/Write/Bash is fine per TEAM-002.
    let agent = make_agent(
        "backend-dev",
        vec![
            prop("role", ident("worker")),
            prop("parent", ident("engineering-lead")),
            prop(
                "core",
                Value::Array(vec![ident("Edit"), ident("Write"), ident("Bash")]),
            ),
        ],
    );
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "TEAM-002"));
}

// ── TEAM-003 ──────────────────────────────────────────────────────

#[test]
fn team003_worker_without_parent_fires() {
    let agent = make_agent("orphan", vec![prop("role", ident("worker"))]);
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().any(|d| d.rule_id == "TEAM-003"));
}

#[test]
fn team003_worker_with_parent_passes() {
    let agent = make_agent(
        "backend-dev",
        vec![
            prop("role", ident("worker")),
            prop("parent", ident("engineering-lead")),
        ],
    );
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "TEAM-003"));
}

#[test]
fn team003_lead_without_parent_ok() {
    let agent = make_agent("engineering-lead", vec![prop("role", ident("lead"))]);
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "TEAM-003"));
}

// ── TIER-001 ──────────────────────────────────────────────────────

#[test]
fn tier001_invalid_tier_fires() {
    let agent = make_agent("orphan", vec![prop("tier", ident("subagent"))]);
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().any(|d| d.rule_id == "TIER-001"));
}

#[test]
fn tier001_valid_low_passes() {
    let agent = make_agent("a", vec![prop("tier", ident("low"))]);
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "TIER-001"));
}

#[test]
fn tier001_valid_mid_passes() {
    let agent = make_agent("a", vec![prop("tier", ident("mid"))]);
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "TIER-001"));
}

#[test]
fn tier001_valid_high_passes() {
    let agent = make_agent("a", vec![prop("tier", ident("high"))]);
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "TIER-001"));
}

#[test]
fn tier001_no_tier_passes() {
    let agent = make_agent("a", vec![]);
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "TIER-001"));
}

// ── TIER-002 ──────────────────────────────────────────────────────

#[test]
fn tier002_mid_max_tokens_over_cap_fires() {
    let mut agent = make_agent("backend-dev", vec![prop("tier", ident("mid"))]);
    agent.mental_model = vec![
        prop("scope", ident("project")),
        prop("validate", Value::Boolean(true)),
        prop("max_tokens", Value::Number(5000.0)),
    ];
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().any(|d| d.rule_id == "TIER-002"));
}

#[test]
fn tier002_low_tier_max_tokens_zero_passes() {
    // Low tier has a max_tokens cap of 0 — `max_tokens: 0` is the only
    // value that satisfies TIER-002 for `tier: low`. This pins the
    // surprising edge that `cap == 0` means any positive value fires.
    let mut agent = make_agent(
        "backend-dev",
        vec![
            prop("role", ident("worker")),
            prop("parent", ident("engineering-lead")),
            prop("tier", ident("low")),
        ],
    );
    agent.mental_model = vec![
        prop("scope", ident("project")),
        prop("validate", Value::Boolean(true)),
        prop("max_tokens", Value::Number(0.0)),
    ];
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "TIER-002"));
}

// ── JIT-001 ───────────────────────────────────────────────────────

#[test]
fn jit001_context_sources_without_overflow_fires() {
    let mut agent = make_agent("backend-dev", vec![]);
    agent.context_sources = vec![prop("patterns", str_val("backend"))];
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().any(|d| d.rule_id == "JIT-001"));
}

#[test]
fn jit001_context_sources_with_overflow_passes() {
    let mut agent = make_agent("backend-dev", vec![]);
    agent.context_sources = vec![
        prop("on_overflow", ident("escalate_tier")),
        prop("patterns", str_val("backend")),
    ];
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "JIT-001"));
}

#[test]
fn jit001_no_context_sources_passes() {
    let agent = make_agent("backend-dev", vec![]);
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "JIT-001"));
}

// ── MM-001 ────────────────────────────────────────────────────────

#[test]
fn mm001_mental_model_without_scope_fires() {
    let mut agent = make_agent("backend-dev", vec![]);
    agent.mental_model = vec![
        prop("storage", str_val("brain.db:x")),
        prop("validate", Value::Boolean(true)),
    ];
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().any(|d| d.rule_id == "MM-001"));
}

#[test]
fn mm001_mental_model_with_scope_passes() {
    let mut agent = make_agent("backend-dev", vec![]);
    agent.mental_model = vec![
        prop("scope", ident("project")),
        prop("validate", Value::Boolean(true)),
    ];
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "MM-001"));
}

// ── MM-002 ────────────────────────────────────────────────────────

#[test]
fn mm002_validate_false_fires() {
    let mut agent = make_agent("backend-dev", vec![]);
    agent.mental_model = vec![
        prop("scope", ident("project")),
        prop("validate", Value::Boolean(false)),
    ];
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().any(|d| d.rule_id == "MM-002"));
}

#[test]
fn mm002_validate_absent_fires() {
    let mut agent = make_agent("backend-dev", vec![]);
    agent.mental_model = vec![prop("scope", ident("project"))];
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().any(|d| d.rule_id == "MM-002"));
}

#[test]
fn mm002_validate_true_passes() {
    let mut agent = make_agent("backend-dev", vec![]);
    agent.mental_model = vec![
        prop("scope", ident("project")),
        prop("validate", Value::Boolean(true)),
    ];
    let diags = run(Section::Agent(agent));
    assert!(diags.iter().all(|d| d.rule_id != "MM-002"));
}
