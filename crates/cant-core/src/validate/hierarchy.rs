//! Hierarchy lint rules for CleoOS v2 agent/team/tool declarations.
//!
//! Implements the 8 rules defined in `docs/plans/CLEO-ULTRAPLAN.md` §9 and
//! `docs/plans/blueprints/wave-0.5-grammar-blueprint.md` §6:
//!
//! | Rule | Check |
//! |------|-------|
//! | `TEAM-001` | Team must declare an orchestrator |
//! | `TEAM-002` | Lead-role agents must not declare `Edit`/`Write`/`Bash` in `tools.core` |
//! | `TEAM-003` | Worker-role agents must declare a `parent:` |
//! | `TIER-001` | Agent `tier:` must be one of `low`, `mid`, `high` |
//! | `TIER-002` | `mental_model.max_tokens` must be ≤ tier token cap |
//! | `JIT-001`  | `context_sources:` must declare `on_overflow:` |
//! | `MM-001`   | `mental_model:` must declare `scope:` |
//! | `MM-002`   | `mental_model.on_load.validate:` must be `true` |

use crate::dsl::ast::{AgentDef, CantDocument, Property, Section, TeamDef, Value};

use crate::validate::context::ValidationContext;
use crate::validate::diagnostic::Diagnostic;

/// Runs every hierarchy rule against `doc` and returns all diagnostics.
///
/// The `_ctx` parameter is reserved for future rules that need cross-section
/// name resolution (e.g., verifying `parent:` references a defined agent).
pub fn check_all(doc: &CantDocument, _ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        match section {
            Section::Team(team) => {
                check_team_001_orchestrator(team, &mut diags);
                check_team_002_lead_consult_when(team, &mut diags);
                check_team_002_lead_stages(team, &mut diags);
            }
            Section::Agent(agent) => {
                check_team_002_lead_tools(agent, &mut diags);
                check_team_003_worker_parent(agent, &mut diags);
                check_tier_001_valid_tier(agent, &mut diags);
                check_tier_002_max_tokens(agent, &mut diags);
                check_jit_001_on_overflow(agent, &mut diags);
                check_mm_001_scope(agent, &mut diags);
                check_mm_002_validate(agent, &mut diags);
            }
            _ => {}
        }
    }

    diags
}

// ── Helpers ──────────────────────────────────────────────────────────

/// Extracts the string representation of a [`Value`] if it is a string,
/// identifier, or single-quoted literal. Returns `None` for non-string values.
fn extract_string(value: &Value) -> Option<String> {
    match value {
        Value::String(sv) => Some(sv.raw.clone()),
        Value::Identifier(id) => Some(id.clone()),
        _ => None,
    }
}

/// Finds the first property in `props` whose key matches `key`.
fn find_property<'a>(props: &'a [Property], key: &str) -> Option<&'a Property> {
    props.iter().find(|p| p.key.value == key)
}

/// Returns `true` if the given value is a boolean `false`, or an identifier
/// / string literal `"false"`.
fn is_boolean_false(value: &Value) -> bool {
    match value {
        Value::Boolean(b) => !*b,
        Value::Identifier(id) => id == "false",
        Value::String(sv) => sv.raw == "false",
        _ => false,
    }
}

/// Returns `true` if the given value is a boolean `true`, or an identifier
/// / string literal `"true"`.
fn is_boolean_true(value: &Value) -> bool {
    match value {
        Value::Boolean(b) => *b,
        Value::Identifier(id) => id == "true",
        Value::String(sv) => sv.raw == "true",
        _ => false,
    }
}

// ── TEAM-001: Team must declare an orchestrator ─────────────────────

/// `TEAM-001`: A team block MUST declare an `orchestrator:` property.
fn check_team_001_orchestrator(team: &TeamDef, diags: &mut Vec<Diagnostic>) {
    if find_property(&team.properties, "orchestrator").is_none() {
        diags.push(Diagnostic::error(
            "TEAM-001",
            format!(
                "Team '{}' at line {} does not declare an orchestrator. Add `orchestrator: <agent-name>` to the team block.",
                team.name.value, team.name.span.line
            ),
            team.span,
        ));
    }
}

// ── TEAM-002 (Wave 7a): Team with leads must declare consult-when ────

/// `TEAM-002` (extension): A team block that declares a `leads:` sub-block
/// MUST also declare `consult-when:` so that the orchestrator knows when to
/// escalate to HITL consultation (ULTRAPLAN §10.3).
fn check_team_002_lead_consult_when(team: &TeamDef, diags: &mut Vec<Diagnostic>) {
    // Only applies when the team block contains a `leads:` property.
    if find_property(&team.properties, "leads").is_none() {
        return;
    }

    if team.consult_when.is_none() {
        diags.push(Diagnostic::error(
            "TEAM-002",
            format!(
                "Team '{}' at line {} declares leads but is missing required `consult-when:`. \
                 Add a human-readable escalation condition (ULTRAPLAN §10.3).",
                team.name.value, team.name.span.line
            ),
            team.span,
        ));
    }
}

/// `TEAM-002` (extension): A team block that declares a `leads:` sub-block
/// MUST also declare a non-empty `stages: [...]` list so that the pipeline
/// stage contract is explicit (ULTRAPLAN §10.3).
fn check_team_002_lead_stages(team: &TeamDef, diags: &mut Vec<Diagnostic>) {
    // Only applies when the team block contains a `leads:` property.
    if find_property(&team.properties, "leads").is_none() {
        return;
    }

    if team.stages.is_empty() {
        diags.push(Diagnostic::error(
            "TEAM-002",
            format!(
                "Team '{}' at line {} declares leads but is missing required `stages: [...]`. \
                 Add an ordered stage list such as `[discover, plan, execute, review]` (ULTRAPLAN §10.3).",
                team.name.value, team.name.span.line
            ),
            team.span,
        ));
    }
}

// ── TEAM-002: Lead role must not have Edit/Write/Bash in tools.core ──

/// `TEAM-002`: Agents with `role: lead` MUST NOT declare `Edit`, `Write`, or
/// `Bash` in their `tools.core:` list. Leads dispatch to workers; they do not
/// execute writes themselves.
fn check_team_002_lead_tools(agent: &AgentDef, diags: &mut Vec<Diagnostic>) {
    let role_prop = match find_property(&agent.properties, "role") {
        Some(p) => p,
        None => return,
    };

    let role_value = match extract_string(&role_prop.value) {
        Some(v) => v,
        None => return,
    };

    if role_value != "lead" {
        return;
    }

    // The `tools:` sub-block is flattened by the agent parser, so `core:`
    // appears as a sibling property alongside `role:` and `tier:`.
    let core_prop = match find_property(&agent.properties, "core") {
        Some(p) => p,
        None => return,
    };

    let elements = match &core_prop.value {
        Value::Array(elements) => elements,
        _ => return,
    };

    for element in elements {
        if let Some(name) = extract_string(element)
            && matches!(name.as_str(), "Edit" | "Write" | "Bash")
        {
            diags.push(Diagnostic::error(
                "TEAM-002",
                format!(
                    "Lead agent '{}' declares forbidden tool '{}' in tools.core at line {}. Lead-role agents MUST NOT hold Edit/Write/Bash — leads dispatch to workers.",
                    agent.name.value, name, core_prop.span.line
                ),
                core_prop.span,
            ));
        }
    }
}

// ── TEAM-003: Worker agents must declare parent ──────────────────────

/// `TEAM-003`: Agents with `role: worker` MUST declare a `parent:` property
/// identifying the lead or orchestrator they report to.
fn check_team_003_worker_parent(agent: &AgentDef, diags: &mut Vec<Diagnostic>) {
    let role_prop = match find_property(&agent.properties, "role") {
        Some(p) => p,
        None => return,
    };

    let role_value = match extract_string(&role_prop.value) {
        Some(v) => v,
        None => return,
    };

    if role_value != "worker" {
        return;
    }

    if find_property(&agent.properties, "parent").is_none() {
        diags.push(Diagnostic::error(
            "TEAM-003",
            format!(
                "Worker agent '{}' at line {} must declare `parent:`. Worker agents must be explicitly parented to a lead or orchestrator.",
                agent.name.value, agent.name.span.line
            ),
            agent.name.span,
        ));
    }
}

// ── TIER-001: Agent tier must be low|mid|high ────────────────────────

/// `TIER-001`: The `tier:` property on an agent (when present) MUST be one
/// of `low`, `mid`, or `high` per L3.
fn check_tier_001_valid_tier(agent: &AgentDef, diags: &mut Vec<Diagnostic>) {
    let tier_prop = match find_property(&agent.properties, "tier") {
        Some(p) => p,
        None => return,
    };

    let tier_value = match extract_string(&tier_prop.value) {
        Some(v) => v,
        None => {
            // Numeric or other non-string tier — still invalid per TIER-001.
            diags.push(Diagnostic::error(
                "TIER-001",
                format!(
                    "Agent '{}' has invalid tier value at line {}. Tier must be one of: low, mid, high (per L3).",
                    agent.name.value, tier_prop.span.line
                ),
                tier_prop.span,
            ));
            return;
        }
    };

    if !matches!(tier_value.as_str(), "low" | "mid" | "high") {
        diags.push(Diagnostic::error(
            "TIER-001",
            format!(
                "Agent '{}' has invalid tier '{}' at line {}. Tier must be one of: low, mid, high (per L3).",
                agent.name.value, tier_value, tier_prop.span.line
            ),
            tier_prop.span,
        ));
    }
}

// ── TIER-002: mental_model.max_tokens ≤ tier cap ─────────────────────

/// Returns the maximum `max_tokens` cap permitted for the given tier name.
fn tier_token_cap(tier: &str) -> Option<u64> {
    match tier {
        "low" => Some(0),
        "mid" => Some(1000),
        "high" => Some(2000),
        _ => None,
    }
}

/// `TIER-002`: `mental_model.max_tokens` MUST be ≤ the tier token cap
/// (low=0, mid=1000, high=2000) per L5.
fn check_tier_002_max_tokens(agent: &AgentDef, diags: &mut Vec<Diagnostic>) {
    if agent.mental_model.is_empty() {
        return;
    }

    let max_tokens_prop = match find_property(&agent.mental_model, "max_tokens") {
        Some(p) => p,
        None => return,
    };

    let max_tokens = match &max_tokens_prop.value {
        Value::Number(n) => *n as u64,
        _ => return,
    };

    let tier_prop = match find_property(&agent.properties, "tier") {
        Some(p) => p,
        None => return,
    };

    let tier_value = match extract_string(&tier_prop.value) {
        Some(v) => v,
        None => return,
    };

    let cap = match tier_token_cap(&tier_value) {
        Some(c) => c,
        None => return, // TIER-001 will have already fired on an invalid tier.
    };

    if max_tokens > cap {
        diags.push(Diagnostic::error(
            "TIER-002",
            format!(
                "Agent '{}' mental_model.max_tokens ({}) exceeds tier '{}' cap ({}) at line {}. Lower max_tokens or escalate the tier.",
                agent.name.value, max_tokens, tier_value, cap, max_tokens_prop.span.line
            ),
            max_tokens_prop.span,
        ));
    }
}

// ── JIT-001: context_sources must declare on_overflow ────────────────

/// `JIT-001`: When `context_sources:` is declared, an `on_overflow:` policy
/// MUST also be declared (per L4).
fn check_jit_001_on_overflow(agent: &AgentDef, diags: &mut Vec<Diagnostic>) {
    if agent.context_sources.is_empty() {
        return;
    }

    if find_property(&agent.context_sources, "on_overflow").is_none() {
        diags.push(Diagnostic::error(
            "JIT-001",
            format!(
                "Agent '{}' declares context_sources but is missing required `on_overflow:` policy (per L4). Add `on_overflow: escalate_tier`.",
                agent.name.value
            ),
            agent.name.span,
        ));
    }
}

// ── MM-001: mental_model must declare scope ──────────────────────────

/// `MM-001`: When `mental_model:` is declared, a `scope:` MUST also be
/// declared (per L5).
fn check_mm_001_scope(agent: &AgentDef, diags: &mut Vec<Diagnostic>) {
    if agent.mental_model.is_empty() {
        return;
    }

    if find_property(&agent.mental_model, "scope").is_none() {
        diags.push(Diagnostic::error(
            "MM-001",
            format!(
                "Agent '{}' mental_model must declare `scope: project|global` (per L5).",
                agent.name.value
            ),
            agent.name.span,
        ));
    }
}

// ── MM-002: mental_model.on_load.validate must be true ───────────────

/// `MM-002`: When `mental_model:` is declared, `on_load.validate` MUST be
/// explicitly `true` (per L5). Absent = violation.
///
/// The current parser flattens nested sub-blocks, so `on_load.validate` lives
/// as a sibling `validate:` property inside `agent.mental_model`.
fn check_mm_002_validate(agent: &AgentDef, diags: &mut Vec<Diagnostic>) {
    if agent.mental_model.is_empty() {
        return;
    }

    let validate_prop = find_property(&agent.mental_model, "validate");

    let emit = match validate_prop {
        None => true,
        Some(p) => {
            if is_boolean_true(&p.value) {
                false
            } else if is_boolean_false(&p.value) {
                true
            } else {
                // Anything other than `true` (e.g., identifier, number) is a violation.
                true
            }
        }
    };

    if emit {
        let span = validate_prop.map(|p| p.span).unwrap_or(agent.name.span);
        diags.push(Diagnostic::error(
            "MM-002",
            format!(
                "Agent '{}' mental_model.on_load.validate must be `true` (per L5). Freshness validation is required on every session load.",
                agent.name.value
            ),
            span,
        ));
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::ast::{Spanned, StringValue};
    use crate::dsl::span::Span;

    // ── Builders ──────────────────────────────────────────────────────

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
        let team = make_team(
            "platform",
            vec![prop("orchestrator", ident("cleo-prime"))],
        );
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
        assert!(team002.len() >= 1);
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
        let team = make_team(
            "minimal",
            vec![prop("orchestrator", ident("cleo-prime"))],
        );
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
                prop("core", Value::Array(vec![ident("Edit"), ident("Write"), ident("Bash")])),
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
        let mut agent = make_agent(
            "backend-dev",
            vec![prop("tier", ident("mid"))],
        );
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
}
