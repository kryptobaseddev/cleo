//! Scope validation rules S01--S13.
//!
//! These rules enforce name resolution, uniqueness, import safety, and
//! permission constraints across a CANT document.

use crate::dsl::ast::{
    AgentDef, CantDocument, Expression, Permission, Section, Statement, StringSegment,
    is_canonical_event,
};
use crate::dsl::span::Span;

use super::context::ValidationContext;
use super::diagnostic::Diagnostic;

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
                "Unknown event '{}' at line {}. Must be one of: SessionStart, SessionEnd, PromptSubmit, ResponseComplete, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, SubagentStart, SubagentStop, PreModel, PostModel, PreCompact, PostCompact, Notification, ConfigChange.",
                event, span.line
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

// ── S09: Import path traversal prevention ──────────────────────────

/// S09: Import paths MUST NOT escape the project root via `..` traversal.
pub fn check_import_path_traversal(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        if let Section::Import(imp) = section {
            if path_escapes_root(&imp.path) {
                diags.push(Diagnostic::error(
                    "S09",
                    format!(
                        "Import path '{}' escapes the project root. Imports MUST resolve within the project directory.",
                        imp.path
                    ),
                    imp.span,
                ));
            }
        }
    }

    diags
}

/// Checks whether a relative path escapes the project root by resolving
/// `..` components. Returns true if the net path goes above the starting
/// directory.
fn path_escapes_root(path: &str) -> bool {
    let mut depth: i32 = 0;
    for component in path.split('/') {
        match component {
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            "" | "." => {}
            _ => {
                depth += 1;
            }
        }
    }
    false
}

// ── S10: Symlink escape prevention ─────────────────────────────────

/// S10: Import paths MUST NOT follow symlinks resolving outside project root.
///
/// Note: This is a static-analysis level check. Full symlink resolution requires
/// filesystem access and is performed at import resolution time (runtime). The
/// static check flags patterns known to be suspicious (e.g., `/` prefixed paths).
pub fn check_import_symlink_escape(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        if let Section::Import(imp) = section {
            // Static check: absolute paths are never relative to project root
            if imp.path.starts_with('/') {
                diags.push(Diagnostic::error(
                    "S10",
                    format!(
                        "Import '{}' uses an absolute path. Imports MUST be relative to the project root to prevent symlink escape.",
                        imp.path
                    ),
                    imp.span,
                ));
            }
        }
    }

    diags
}

// ── S11: Import chain depth limit ──────────────────────────────────

/// S11: Import chain depth MUST NOT exceed the configured maximum.
pub fn check_import_depth(ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    let depth = ctx.import_chain.len() as u32;
    if depth > ctx.limits.max_import_depth {
        let last_path = ctx.import_chain.last().cloned().unwrap_or_default();
        diags.push(Diagnostic::error(
            "S11",
            format!(
                "Import chain depth of {} exceeds the maximum of {} at '{}'. Flatten your import hierarchy.",
                depth, ctx.limits.max_import_depth, last_path
            ),
            Span::dummy(),
        ));
    }
    diags
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

// ── S02: Shadowed bindings ─────────────────────────────────────────

/// S02: Warn when a let binding shadows an existing binding in an enclosing scope.
pub fn check_shadowed_bindings(doc: &CantDocument, ctx: &mut ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        match section {
            Section::Workflow(wf) => {
                ctx.push_scope();
                // Register params
                for param in &wf.params {
                    ctx.define_binding(param.name.value.clone(), param.name.span);
                }
                check_shadow_in_stmts(&wf.body, ctx, &mut diags);
                ctx.pop_scope();
            }
            Section::Hook(hook) => {
                ctx.push_scope();
                check_shadow_in_stmts(&hook.body, ctx, &mut diags);
                ctx.pop_scope();
            }
            Section::Agent(agent) => {
                for hook in &agent.hooks {
                    ctx.push_scope();
                    check_shadow_in_stmts(&hook.body, ctx, &mut diags);
                    ctx.pop_scope();
                }
            }
            _ => {}
        }
    }

    diags
}

/// Check for shadowed bindings within a statement list.
fn check_shadow_in_stmts(
    stmts: &[Statement],
    ctx: &mut ValidationContext,
    diags: &mut Vec<Diagnostic>,
) {
    for stmt in stmts {
        match stmt {
            Statement::Binding(binding) => {
                if let Some(prev_span) = ctx.find_shadow_target(&binding.name.value) {
                    diags.push(Diagnostic::warning(
                        "S02",
                        format!(
                            "Binding '{}' at line {} shadows an existing binding defined at line {}.",
                            binding.name.value, binding.name.span.line, prev_span.line
                        ),
                        binding.name.span,
                    ));
                }
                ctx.define_binding(binding.name.value.clone(), binding.name.span);
            }
            Statement::ForLoop(f) => {
                ctx.push_scope();
                if let Some(prev_span) = ctx.find_shadow_target(&f.variable.value) {
                    diags.push(Diagnostic::warning(
                        "S02",
                        format!(
                            "Binding '{}' at line {} shadows an existing binding defined at line {}.",
                            f.variable.value, f.variable.span.line, prev_span.line
                        ),
                        f.variable.span,
                    ));
                }
                ctx.define_binding(f.variable.value.clone(), f.variable.span);
                check_shadow_in_stmts(&f.body, ctx, diags);
                ctx.pop_scope();
            }
            Statement::Conditional(cond) => {
                ctx.push_scope();
                check_shadow_in_stmts(&cond.then_body, ctx, diags);
                ctx.pop_scope();
                for elif in &cond.elif_branches {
                    ctx.push_scope();
                    check_shadow_in_stmts(&elif.body, ctx, diags);
                    ctx.pop_scope();
                }
                if let Some(else_body) = &cond.else_body {
                    ctx.push_scope();
                    check_shadow_in_stmts(else_body, ctx, diags);
                    ctx.pop_scope();
                }
            }
            Statement::Repeat(r) => {
                ctx.push_scope();
                check_shadow_in_stmts(&r.body, ctx, diags);
                ctx.pop_scope();
            }
            Statement::LoopUntil(l) => {
                ctx.push_scope();
                check_shadow_in_stmts(&l.body, ctx, diags);
                ctx.pop_scope();
            }
            Statement::TryCatch(tc) => {
                ctx.push_scope();
                check_shadow_in_stmts(&tc.try_body, ctx, diags);
                ctx.pop_scope();
                if let Some(catch_body) = &tc.catch_body {
                    ctx.push_scope();
                    if let Some(catch_name) = &tc.catch_name {
                        ctx.define_binding(catch_name.clone(), tc.span);
                    }
                    check_shadow_in_stmts(catch_body, ctx, diags);
                    ctx.pop_scope();
                }
                if let Some(finally_body) = &tc.finally_body {
                    ctx.push_scope();
                    check_shadow_in_stmts(finally_body, ctx, diags);
                    ctx.pop_scope();
                }
            }
            _ => {}
        }
    }
}

// ── S01: Unresolved variable references ────────────────────────────

/// S01: Every variable reference MUST resolve to a defined name.
pub fn check_unresolved_refs(doc: &CantDocument, ctx: &mut ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    // First pass: register all top-level names (already done by check_unique_names).
    // Second pass: check references inside bodies.
    for section in &doc.sections {
        match section {
            Section::Workflow(wf) => {
                ctx.push_scope();
                for param in &wf.params {
                    ctx.define_binding(param.name.value.clone(), param.name.span);
                }
                check_refs_in_stmts(&wf.body, ctx, &mut diags);
                ctx.pop_scope();
            }
            Section::Hook(hook) => {
                ctx.push_scope();
                // Hook context variables are implicitly available
                register_hook_context_vars(ctx, &hook.event.value);
                check_refs_in_stmts(&hook.body, ctx, &mut diags);
                ctx.pop_scope();
            }
            Section::Agent(agent) => {
                for hook in &agent.hooks {
                    ctx.push_scope();
                    register_hook_context_vars(ctx, &hook.event.value);
                    check_refs_in_stmts(&hook.body, ctx, &mut diags);
                    ctx.pop_scope();
                }
            }
            _ => {}
        }
    }

    diags
}

/// Register implicit context variables available within a hook body.
fn register_hook_context_vars(ctx: &mut ValidationContext, event: &str) {
    // 'session' is available in all hooks
    ctx.define_binding("session".to_string(), Span::dummy());

    match event {
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => {
            ctx.define_binding("tool".to_string(), Span::dummy());
        }
        "SubagentStart" | "SubagentStop" => {
            ctx.define_binding("agent".to_string(), Span::dummy());
        }
        "PreModel" | "PostModel" => {
            ctx.define_binding("model".to_string(), Span::dummy());
        }
        "ConfigChange" => {
            ctx.define_binding("config".to_string(), Span::dummy());
        }
        "Notification" => {
            ctx.define_binding("notification".to_string(), Span::dummy());
        }
        _ => {}
    }
}

/// Check expression references in a statement list.
fn check_refs_in_stmts(
    stmts: &[Statement],
    ctx: &mut ValidationContext,
    diags: &mut Vec<Diagnostic>,
) {
    for stmt in stmts {
        match stmt {
            Statement::Binding(binding) => {
                check_expr_refs(&binding.value, ctx, diags);
                ctx.define_binding(binding.name.value.clone(), binding.name.span);
            }
            Statement::Expression(expr) => {
                check_expr_refs(expr, ctx, diags);
            }
            Statement::Conditional(cond) => {
                check_condition_refs(&cond.condition, ctx, diags);
                ctx.push_scope();
                check_refs_in_stmts(&cond.then_body, ctx, diags);
                ctx.pop_scope();
                for elif in &cond.elif_branches {
                    check_condition_refs(&elif.condition, ctx, diags);
                    ctx.push_scope();
                    check_refs_in_stmts(&elif.body, ctx, diags);
                    ctx.pop_scope();
                }
                if let Some(else_body) = &cond.else_body {
                    ctx.push_scope();
                    check_refs_in_stmts(else_body, ctx, diags);
                    ctx.pop_scope();
                }
            }
            Statement::ForLoop(f) => {
                check_expr_refs(&f.iterable, ctx, diags);
                ctx.push_scope();
                ctx.define_binding(f.variable.value.clone(), f.variable.span);
                check_refs_in_stmts(&f.body, ctx, diags);
                ctx.pop_scope();
            }
            Statement::Repeat(r) => {
                check_expr_refs(&r.count, ctx, diags);
                ctx.push_scope();
                check_refs_in_stmts(&r.body, ctx, diags);
                ctx.pop_scope();
            }
            Statement::LoopUntil(l) => {
                ctx.push_scope();
                check_refs_in_stmts(&l.body, ctx, diags);
                check_condition_refs(&l.condition, ctx, diags);
                ctx.pop_scope();
            }
            Statement::TryCatch(tc) => {
                ctx.push_scope();
                check_refs_in_stmts(&tc.try_body, ctx, diags);
                ctx.pop_scope();
                if let Some(catch_body) = &tc.catch_body {
                    ctx.push_scope();
                    if let Some(catch_name) = &tc.catch_name {
                        ctx.define_binding(catch_name.clone(), tc.span);
                    }
                    check_refs_in_stmts(catch_body, ctx, diags);
                    ctx.pop_scope();
                }
                if let Some(finally_body) = &tc.finally_body {
                    ctx.push_scope();
                    check_refs_in_stmts(finally_body, ctx, diags);
                    ctx.pop_scope();
                }
            }
            Statement::Session(_sess) => {
                // Session properties are Value types (not Expression), so no
                // variable references to resolve here.
            }
            Statement::Output(out) => {
                check_expr_refs(&out.value, ctx, diags);
            }
            Statement::Parallel(block) => {
                for arm in &block.arms {
                    check_stmt_refs(&arm.body, ctx, diags);
                }
            }
            _ => {}
        }
    }
}

/// Check a single statement for unresolved references.
fn check_stmt_refs(stmt: &Statement, ctx: &mut ValidationContext, diags: &mut Vec<Diagnostic>) {
    match stmt {
        Statement::Expression(expr) => check_expr_refs(expr, ctx, diags),
        Statement::Session(_sess) => {
            // Session properties are Value types (not Expression), so no
            // variable references to resolve here.
        }
        _ => {}
    }
}

/// Check condition references (Expression or Discretion).
fn check_condition_refs(
    condition: &crate::dsl::ast::Condition,
    ctx: &ValidationContext,
    diags: &mut Vec<Diagnostic>,
) {
    use crate::dsl::ast::Condition;
    if let Condition::Expression(expr) = condition {
        check_expr_refs(expr, ctx, diags);
    }
    // Discretion conditions contain prose, no variable refs to check
}

/// Check an expression for unresolved name references.
fn check_expr_refs(expr: &Expression, ctx: &ValidationContext, diags: &mut Vec<Diagnostic>) {
    match expr {
        Expression::Name(name_expr) => {
            if !ctx.is_name_defined(&name_expr.name) {
                diags.push(Diagnostic::error(
                    "S01",
                    format!(
                        "Unresolved reference '{}' at line {}. No binding, parameter, or context variable with this name is in scope.",
                        name_expr.name, name_expr.span.line
                    ),
                    name_expr.span,
                ));
            }
        }
        Expression::PropertyAccess(pa) => {
            check_expr_refs(&pa.object, ctx, diags);
        }
        Expression::Comparison(cmp) => {
            check_expr_refs(&cmp.left, ctx, diags);
            check_expr_refs(&cmp.right, ctx, diags);
        }
        Expression::Logical(log) => {
            check_expr_refs(&log.left, ctx, diags);
            check_expr_refs(&log.right, ctx, diags);
        }
        Expression::Negation(neg) => {
            check_expr_refs(&neg.operand, ctx, diags);
        }
        Expression::Interpolation(interp) => {
            check_expr_refs(&interp.expression, ctx, diags);
        }
        Expression::Array(arr) => {
            for elem in &arr.elements {
                check_expr_refs(elem, ctx, diags);
            }
        }
        Expression::String(s) => {
            for seg in &s.segments {
                if let StringSegment::Interpolation(expr) = seg {
                    check_expr_refs(expr, ctx, diags);
                }
            }
        }
        // Literals don't have references
        Expression::Number(_)
        | Expression::Boolean(_)
        | Expression::Duration(_)
        | Expression::TaskRef(_)
        | Expression::Address(_) => {}
    }
}

// ── S03: Circular import chains ────────────────────────────────────

/// S03: Check for circular import chains.
///
/// Note: Full cycle detection requires resolving imports across files. This
/// check validates the import_chain in the context. Call before processing
/// each import to verify the target is not already in the chain.
pub fn check_circular_import(path: &str, ctx: &ValidationContext, span: Span) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    if ctx.import_chain.contains(&path.to_string()) {
        let chain_str = ctx.import_chain.join(" -> ");
        diags.push(Diagnostic::error(
            "S03",
            format!(
                "Circular import chain detected: {} -> {}. Break the cycle by extracting shared definitions.",
                chain_str, path
            ),
            span,
        ));
    }

    diags
}

// ── S08: Binding used before definition ────────────────────────────

/// S08: References to bindings MUST occur after their definition.
///
/// This is partially covered by S01 (unresolved references), since the
/// binding is only added to context after the let statement is visited.
/// S08 provides a more specific diagnostic when the binding exists but
/// is defined later in the same scope.
pub fn check_binding_order(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        if let Section::Workflow(wf) = section {
            check_binding_order_in_stmts(&wf.body, &mut diags);
        }
    }

    diags
}

/// Check binding order within a statement list.
fn check_binding_order_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    // Collect all binding positions first
    let mut binding_positions: std::collections::HashMap<String, (usize, Span)> =
        std::collections::HashMap::new();

    for (i, stmt) in stmts.iter().enumerate() {
        if let Statement::Binding(binding) = stmt {
            binding_positions
                .entry(binding.name.value.clone())
                .or_insert((i, binding.name.span));
        }
    }

    // Check references that occur before definitions
    for (i, stmt) in stmts.iter().enumerate() {
        let refs = collect_name_refs_from_stmt(stmt);
        for (name, ref_span) in refs {
            if let Some((def_idx, def_span)) = binding_positions.get(&name) {
                if i < *def_idx {
                    diags.push(Diagnostic::error(
                        "S08",
                        format!(
                            "Reference to '{}' at line {} before its definition at line {}. Move the 'let' binding above this reference.",
                            name, ref_span.line, def_span.line
                        ),
                        ref_span,
                    ));
                }
            }
        }
    }
}

/// Collect all name references from a statement (non-recursive, for binding-order checks).
fn collect_name_refs_from_stmt(stmt: &Statement) -> Vec<(String, Span)> {
    let mut refs = Vec::new();
    match stmt {
        Statement::Expression(expr) => collect_name_refs_from_expr(expr, &mut refs),
        Statement::Output(out) => collect_name_refs_from_expr(&out.value, &mut refs),
        Statement::Conditional(cond) => {
            if let crate::dsl::ast::Condition::Expression(expr) = &cond.condition {
                collect_name_refs_from_expr(expr, &mut refs);
            }
        }
        Statement::Session(_sess) => {
            // Session properties are Value types (not Expression), so no
            // name references to collect here.
        }
        _ => {}
    }
    refs
}

/// Collect name references from an expression.
fn collect_name_refs_from_expr(expr: &Expression, refs: &mut Vec<(String, Span)>) {
    match expr {
        Expression::Name(name) => refs.push((name.name.clone(), name.span)),
        Expression::PropertyAccess(pa) => collect_name_refs_from_expr(&pa.object, refs),
        Expression::Comparison(cmp) => {
            collect_name_refs_from_expr(&cmp.left, refs);
            collect_name_refs_from_expr(&cmp.right, refs);
        }
        Expression::Logical(log) => {
            collect_name_refs_from_expr(&log.left, refs);
            collect_name_refs_from_expr(&log.right, refs);
        }
        Expression::Negation(neg) => collect_name_refs_from_expr(&neg.operand, refs),
        Expression::Interpolation(interp) => {
            collect_name_refs_from_expr(&interp.expression, refs);
        }
        Expression::Array(arr) => {
            for elem in &arr.elements {
                collect_name_refs_from_expr(elem, refs);
            }
        }
        Expression::String(s) => {
            for seg in &s.segments {
                if let StringSegment::Interpolation(expr) = seg {
                    collect_name_refs_from_expr(expr, refs);
                }
            }
        }
        _ => {}
    }
}

// ── S12: Permission escalation prevention ──────────────────────────

/// S12: Imported agent permissions MUST NOT exceed importing context.
///
/// This requires cross-file analysis. At the single-document level, we
/// cannot fully enforce this. This function provides the building block:
/// given a set of "allowed" permissions and an agent definition, it
/// checks for escalation.
pub fn check_permission_escalation(
    agent: &AgentDef,
    allowed_permissions: &std::collections::HashMap<String, Vec<String>>,
) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for perm in &agent.permissions {
        if let Some(allowed) = allowed_permissions.get(&perm.domain) {
            for access_val in &perm.access {
                if !allowed.contains(access_val) {
                    diags.push(Diagnostic::error(
                        "S12",
                        format!(
                            "Agent '{}' declares permission '{}: {}' which exceeds the permissions of the importing context. Imported agents MUST NOT escalate privileges.",
                            agent.name.value, perm.domain, access_val
                        ),
                        perm.span,
                    ));
                }
            }
        } else {
            // Domain not in allowed set at all -- all permissions escalate
            for access_val in &perm.access {
                diags.push(Diagnostic::error(
                    "S12",
                    format!(
                        "Agent '{}' declares permission '{}: {}' which exceeds the permissions of the importing context. Imported agents MUST NOT escalate privileges.",
                        agent.name.value, perm.domain, access_val
                    ),
                    perm.span,
                ));
            }
        }
    }

    diags
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
        assert!(path_escapes_root("../../etc/passwd"));
        assert!(path_escapes_root("../../../home"));
        assert!(!path_escapes_root("./agents/scanner.cant"));
        assert!(!path_escapes_root("agents/scanner.cant"));
        assert!(!path_escapes_root("subdir/../shared.cant"));
    }
}
