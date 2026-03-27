//! Binding resolution and permission rules: S01, S02, S08, S12.
//!
//! S01: Unresolved variable references.
//! S02: Shadowed bindings.
//! S08: Binding used before definition.
//! S12: Permission escalation prevention.

use crate::dsl::ast::{AgentDef, CantDocument, Expression, Section, Statement, StringSegment};
use crate::dsl::span::Span;

use crate::validate::context::ValidationContext;
use crate::validate::diagnostic::Diagnostic;

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
