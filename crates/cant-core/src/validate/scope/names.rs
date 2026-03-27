//! Name uniqueness and validation rules: S05, S06, S07, S13.
//!
//! S05: Unique names within a file.
//! S06: Valid hook event names.
//! S07: Unique parallel arm names.
//! S13: Permission closed set.

use crate::dsl::ast::{
    CANONICAL_EVENT_NAMES_CSV, CantDocument, Permission, Section, Statement, is_canonical_event,
};
use crate::dsl::span::Span;

use crate::validate::context::ValidationContext;
use crate::validate::diagnostic::Diagnostic;

/// Valid permission values per rule S13.
const VALID_PERMISSIONS: &[&str] = &["read", "write", "execute"];

// ── S05: Unique names within file ──────────────────────────────────

/// S05: Agent, skill, workflow, and pipeline names MUST be unique within a file.
pub fn check_unique_names(doc: &CantDocument, ctx: &mut ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        match section {
            Section::Agent(agent) => {
                let name = &agent.name.value;
                if let Some(prev_span) = ctx.defined_agents.get(name) {
                    diags.push(Diagnostic::error(
                        "S05",
                        format!(
                            "Duplicate agent name '{}' at line {}. An agent with this name is already defined at line {}.",
                            name, agent.name.span.line, prev_span.line
                        ),
                        agent.name.span,
                    ));
                } else {
                    ctx.defined_agents.insert(name.clone(), agent.name.span);
                }
            }
            Section::Skill(skill) => {
                let name = &skill.name.value;
                if let Some(prev_span) = ctx.defined_skills.get(name) {
                    diags.push(Diagnostic::error(
                        "S05",
                        format!(
                            "Duplicate skill name '{}' at line {}. A skill with this name is already defined at line {}.",
                            name, skill.name.span.line, prev_span.line
                        ),
                        skill.name.span,
                    ));
                } else {
                    ctx.defined_skills.insert(name.clone(), skill.name.span);
                }
            }
            Section::Workflow(wf) => {
                let name = &wf.name.value;
                if let Some(prev_span) = ctx.defined_workflows.get(name) {
                    diags.push(Diagnostic::error(
                        "S05",
                        format!(
                            "Duplicate workflow name '{}' at line {}. A workflow with this name is already defined at line {}.",
                            name, wf.name.span.line, prev_span.line
                        ),
                        wf.name.span,
                    ));
                } else {
                    ctx.defined_workflows.insert(name.clone(), wf.name.span);
                }
            }
            Section::Pipeline(pipe) => {
                let name = &pipe.name.value;
                if let Some(prev_span) = ctx.defined_pipelines.get(name) {
                    diags.push(Diagnostic::error(
                        "S05",
                        format!(
                            "Duplicate pipeline name '{}' at line {}. A pipeline with this name is already defined at line {}.",
                            name, pipe.name.span.line, prev_span.line
                        ),
                        pipe.name.span,
                    ));
                } else {
                    ctx.defined_pipelines.insert(name.clone(), pipe.name.span);
                }
            }
            Section::Binding(binding) => {
                ctx.define_binding(binding.name.value.clone(), binding.name.span);
            }
            _ => {}
        }
    }

    diags
}

// ── S06 / H01: Valid hook event names ──────────────────────────────

/// S06: Hook event names MUST be one of the 16 CAAMP canonical events.
pub fn check_valid_hook_events(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        match section {
            Section::Hook(hook) => {
                check_hook_event(&hook.event.value, hook.event.span, &mut diags);
            }
            Section::Agent(agent) => {
                for hook in &agent.hooks {
                    check_hook_event(&hook.event.value, hook.event.span, &mut diags);
                }
            }
            _ => {}
        }
    }

    diags
}

/// Helper to check a single hook event name.
fn check_hook_event(event: &str, span: Span, diags: &mut Vec<Diagnostic>) {
    if !is_canonical_event(event) {
        diags.push(Diagnostic::error(
            "S06",
            format!(
                "Unknown event '{}' at line {}. Must be one of: {}.",
                event, span.line, CANONICAL_EVENT_NAMES_CSV
            ),
            span,
        ));
    }
}

// ── S07: Unique parallel arm names ─────────────────────────────────

/// S07: Parallel arm names MUST be unique within a block.
pub fn check_unique_parallel_arms(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        if let Section::Workflow(wf) = section {
            check_parallel_arms_in_stmts(&wf.body, &mut diags);
        }
    }

    diags
}

/// Recursively check parallel arm uniqueness in statements.
fn check_parallel_arms_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::Parallel(block) => {
                let mut seen: std::collections::HashMap<&str, Span> =
                    std::collections::HashMap::new();
                for arm in &block.arms {
                    if let Some(prev_span) = seen.get(arm.name.as_str()) {
                        diags.push(Diagnostic::error(
                            "S07",
                            format!(
                                "Duplicate parallel arm name '{}' at line {}. An arm with this name already exists at line {}.",
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
                check_parallel_arms_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_parallel_arms_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_parallel_arms_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_parallel_arms_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_parallel_arms_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_parallel_arms_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_parallel_arms_in_stmts(&tc.try_body, diags);
                if let Some(catch_body) = &tc.catch_body {
                    check_parallel_arms_in_stmts(catch_body, diags);
                }
                if let Some(finally_body) = &tc.finally_body {
                    check_parallel_arms_in_stmts(finally_body, diags);
                }
            }
            _ => {}
        }
    }
}

// ── S13: Permission closed set ─────────────────────────────────────

/// S13: Permission values MUST be from the closed set: read, write, execute.
pub fn check_permission_values(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        if let Section::Agent(agent) = section {
            check_agent_permissions(&agent.permissions, &mut diags);
        }
    }

    diags
}

/// Check permission values for a set of permission declarations.
fn check_agent_permissions(permissions: &[Permission], diags: &mut Vec<Diagnostic>) {
    for perm in permissions {
        for access_val in &perm.access {
            if !VALID_PERMISSIONS.contains(&access_val.as_str()) {
                diags.push(Diagnostic::error(
                    "S13",
                    format!(
                        "Invalid permission value '{}' at line {}. Permitted values are: read, write, execute.",
                        access_val, perm.span.line
                    ),
                    perm.span,
                ));
            }
        }
    }
}
