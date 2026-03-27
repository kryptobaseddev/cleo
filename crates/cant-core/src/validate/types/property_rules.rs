//! Type validation rules T01--T03.
//!
//! T01: Property values match expected types.
//! T02: Comparison operands are type-compatible.
//! T03: String interpolation operands are stringifiable.

use crate::dsl::ast::{
    CantDocument, ComparisonOp, Expression, Section, Statement, StringSegment, Value,
};
use crate::dsl::span::Span;

use super::helpers::{EXPECTED_TYPES, check_props_types, infer_expr_type, is_stringifiable};
use crate::validate::diagnostic::Diagnostic;

// ── T01: Property values match expected types ───────────────────────

/// T01: Property values MUST match their expected types.
pub(super) fn check_t01_property_types(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        match section {
            Section::Agent(agent) => check_props_types(&agent.properties, &mut diags),
            Section::Skill(skill) => check_props_types(&skill.properties, &mut diags),
            Section::Pipeline(pipe) => {
                for step in &pipe.steps {
                    check_props_types(&step.properties, &mut diags);
                }
            }
            Section::Workflow(wf) => check_stmts_props_types(&wf.body, &mut diags),
            Section::Hook(hook) => check_stmts_props_types(&hook.body, &mut diags),
            _ => {}
        }
    }
    diags
}

/// Check properties within statement bodies.
fn check_stmts_props_types(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::Property(prop) => {
                for et in EXPECTED_TYPES {
                    if prop.key.value == et.key && !(et.check)(&prop.value) {
                        diags.push(Diagnostic::error(
                            "T01",
                            format!(
                                "Property '{}' at line {} expects a {} value.",
                                prop.key.value, prop.span.line, et.expected
                            ),
                            prop.span,
                        ));
                    }
                }
            }
            Statement::Session(sess) => check_props_types(&sess.properties, diags),
            Statement::Conditional(cond) => {
                check_stmts_props_types(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_stmts_props_types(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_stmts_props_types(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_stmts_props_types(&r.body, diags),
            Statement::ForLoop(f) => check_stmts_props_types(&f.body, diags),
            Statement::LoopUntil(l) => check_stmts_props_types(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_stmts_props_types(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_stmts_props_types(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_stmts_props_types(fb, diags);
                }
            }
            _ => {}
        }
    }
}

// ── T02: Comparison operands type-compatible ────────────────────────

/// T02: Comparison operands MUST be type-compatible.
pub(super) fn check_t02_comparison_types(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        match section {
            Section::Workflow(wf) => check_comparisons_in_stmts(&wf.body, &mut diags),
            Section::Hook(hook) => check_comparisons_in_stmts(&hook.body, &mut diags),
            Section::Agent(agent) => {
                for hook in &agent.hooks {
                    check_comparisons_in_stmts(&hook.body, &mut diags);
                }
            }
            _ => {}
        }
    }
    diags
}

/// Recursively check comparison expressions in statements.
fn check_comparisons_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::Expression(expr) => check_comparison_expr(expr, diags),
            Statement::Binding(b) => check_comparison_expr(&b.value, diags),
            Statement::Conditional(cond) => {
                if let crate::dsl::ast::Condition::Expression(expr) = &cond.condition {
                    check_comparison_expr(expr, diags);
                }
                check_comparisons_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    if let crate::dsl::ast::Condition::Expression(expr) = &elif.condition {
                        check_comparison_expr(expr, diags);
                    }
                    check_comparisons_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_comparisons_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => {
                check_comparison_expr(&r.count, diags);
                check_comparisons_in_stmts(&r.body, diags);
            }
            Statement::ForLoop(f) => {
                check_comparison_expr(&f.iterable, diags);
                check_comparisons_in_stmts(&f.body, diags);
            }
            Statement::LoopUntil(l) => {
                if let crate::dsl::ast::Condition::Expression(expr) = &l.condition {
                    check_comparison_expr(expr, diags);
                }
                check_comparisons_in_stmts(&l.body, diags);
            }
            Statement::TryCatch(tc) => {
                check_comparisons_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_comparisons_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_comparisons_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

/// Check a comparison expression for type compatibility.
fn check_comparison_expr(expr: &Expression, diags: &mut Vec<Diagnostic>) {
    match expr {
        Expression::Comparison(cmp) => {
            let left_type = infer_expr_type(&cmp.left);
            let right_type = infer_expr_type(&cmp.right);

            // If both types are known and different, flag incompatibility
            if let (Some(lt), Some(rt)) = (&left_type, &right_type) {
                if lt != rt {
                    // Ordering comparisons on non-numeric types are always invalid
                    let is_ordering = matches!(
                        cmp.op,
                        ComparisonOp::Gt | ComparisonOp::Lt | ComparisonOp::Ge | ComparisonOp::Le
                    );
                    if is_ordering || lt != rt {
                        diags.push(Diagnostic::warning(
                            "T02",
                            format!(
                                "Comparison at line {} compares {} with {} operands. Ensure operands are type-compatible.",
                                cmp.span.line, lt, rt
                            ),
                            cmp.span,
                        ));
                    }
                }
            }

            // Recurse into sub-expressions
            check_comparison_expr(&cmp.left, diags);
            check_comparison_expr(&cmp.right, diags);
        }
        Expression::Logical(log) => {
            check_comparison_expr(&log.left, diags);
            check_comparison_expr(&log.right, diags);
        }
        Expression::Negation(neg) => check_comparison_expr(&neg.operand, diags),
        _ => {}
    }
}

// ── T03: String interpolation operands stringifiable ────────────────

/// T03: Operands within string interpolation MUST be stringifiable.
pub(super) fn check_t03_interpolation_operands(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        match section {
            Section::Workflow(wf) => check_interp_in_stmts(&wf.body, &mut diags),
            Section::Hook(hook) => check_interp_in_stmts(&hook.body, &mut diags),
            Section::Agent(agent) => {
                for hook in &agent.hooks {
                    check_interp_in_stmts(&hook.body, &mut diags);
                }
            }
            _ => {}
        }
    }
    diags
}

/// Recursively check interpolation operands in statements.
fn check_interp_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::Expression(expr) => check_interp_in_expr(expr, diags),
            Statement::Binding(b) => check_interp_in_expr(&b.value, diags),
            Statement::Output(out) => check_interp_in_expr(&out.value, diags),
            Statement::Session(sess) => {
                for prop in &sess.properties {
                    check_interp_in_value(&prop.value, prop.span, diags);
                }
            }
            Statement::Conditional(cond) => {
                check_interp_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_interp_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_interp_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_interp_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_interp_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_interp_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_interp_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_interp_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_interp_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

/// Check an expression for non-stringifiable interpolation operands.
fn check_interp_in_expr(expr: &Expression, diags: &mut Vec<Diagnostic>) {
    match expr {
        Expression::String(s) => {
            for seg in &s.segments {
                if let StringSegment::Interpolation(inner) = seg {
                    if !is_stringifiable(inner) {
                        diags.push(Diagnostic::warning(
                            "T03",
                            format!(
                                "String interpolation at line {} contains a non-stringifiable expression (e.g., array or boolean). Ensure the interpolated value is a string, number, or name.",
                                s.span.line
                            ),
                            s.span,
                        ));
                    }
                }
            }
        }
        Expression::Interpolation(interp) => {
            if !is_stringifiable(&interp.expression) {
                diags.push(Diagnostic::warning(
                    "T03",
                    format!(
                        "Interpolation at line {} contains a non-stringifiable expression.",
                        interp.span.line
                    ),
                    interp.span,
                ));
            }
        }
        Expression::Comparison(cmp) => {
            check_interp_in_expr(&cmp.left, diags);
            check_interp_in_expr(&cmp.right, diags);
        }
        Expression::Logical(log) => {
            check_interp_in_expr(&log.left, diags);
            check_interp_in_expr(&log.right, diags);
        }
        Expression::Negation(neg) => check_interp_in_expr(&neg.operand, diags),
        Expression::Array(arr) => {
            for elem in &arr.elements {
                check_interp_in_expr(elem, diags);
            }
        }
        _ => {}
    }
}

/// Check a property Value for interpolation issues.
fn check_interp_in_value(value: &Value, span: Span, _diags: &mut Vec<Diagnostic>) {
    // Value::String contains raw text, not AST expressions. Interpolation checks
    // are handled at the Expression level (StringExpr with segments).
    let _ = (value, span);
}
