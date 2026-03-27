//! Type validation rules T01--T07.
//!
//! These rules enforce type compatibility for property values, comparison
//! operands, string interpolation operands, and context references.

use crate::dsl::ast::{
    CantDocument, ComparisonOp, Expression, Property, Section, Statement, StringSegment, Value,
};
use crate::dsl::span::Span;

use super::context::ValidationContext;
use super::diagnostic::Diagnostic;

/// Runs all type checks (T01--T07) against `doc`.
pub fn check_all(doc: &CantDocument, ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    diags.extend(check_t01_property_types(doc));
    diags.extend(check_t02_comparison_types(doc));
    diags.extend(check_t03_interpolation_operands(doc));
    diags.extend(check_t04_context_references(doc, ctx));
    diags.extend(check_t05_parallel_arm_refs(doc, ctx));
    diags.extend(check_t06_approval_message_type(doc));
    diags.extend(check_t07_no_nested_interpolation(doc));
    diags
}

// ── Property type expectations ──────────────────────────────────────

/// Known property keys and their expected value types.
struct ExpectedType {
    key: &'static str,
    /// A human-readable expected type name.
    expected: &'static str,
    /// Checker function.
    check: fn(&Value) -> bool,
}

/// Returns true if the value is a string-like type.
fn is_string_like(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Identifier(_))
}

/// Returns true if the value is a duration.
fn is_duration(value: &Value) -> bool {
    matches!(value, Value::Duration(_))
}

/// Returns true if the value is a boolean.
fn is_boolean(value: &Value) -> bool {
    matches!(value, Value::Boolean(_))
}

/// Returns true if the value is an array.
fn is_array(value: &Value) -> bool {
    matches!(value, Value::Array(_))
}

const EXPECTED_TYPES: &[ExpectedType] = &[
    ExpectedType {
        key: "model",
        expected: "string",
        check: is_string_like,
    },
    ExpectedType {
        key: "prompt",
        expected: "string",
        check: is_string_like,
    },
    ExpectedType {
        key: "description",
        expected: "string",
        check: is_string_like,
    },
    ExpectedType {
        key: "timeout",
        expected: "duration",
        check: is_duration,
    },
    ExpectedType {
        key: "persist",
        expected: "boolean",
        check: is_boolean,
    },
    ExpectedType {
        key: "args",
        expected: "array",
        check: is_array,
    },
];

// ── T01: Property values match expected types ───────────────────────

/// T01: Property values MUST match their expected types.
fn check_t01_property_types(doc: &CantDocument) -> Vec<Diagnostic> {
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

/// Check property types against expected types.
fn check_props_types(props: &[Property], diags: &mut Vec<Diagnostic>) {
    for prop in props {
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
fn check_t02_comparison_types(doc: &CantDocument) -> Vec<Diagnostic> {
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

/// Infer a simple type string for an expression (for type-compatibility checks).
fn infer_expr_type(expr: &Expression) -> Option<&'static str> {
    match expr {
        Expression::String(_) => Some("string"),
        Expression::Number(_) => Some("number"),
        Expression::Boolean(_) => Some("boolean"),
        Expression::Duration(_) => Some("duration"),
        Expression::Array(_) => Some("array"),
        Expression::TaskRef(_) => Some("task_ref"),
        Expression::Address(_) => Some("address"),
        // Name, PropertyAccess, Interpolation, Comparison, Logical, Negation — unknown at
        // static analysis time
        _ => None,
    }
}

// ── T03: String interpolation operands stringifiable ────────────────

/// T03: Operands within string interpolation MUST be stringifiable.
fn check_t03_interpolation_operands(doc: &CantDocument) -> Vec<Diagnostic> {
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

/// Returns true if the expression is stringifiable (can be coerced to a string).
fn is_stringifiable(expr: &Expression) -> bool {
    matches!(
        expr,
        Expression::String(_)
            | Expression::Number(_)
            | Expression::Name(_)
            | Expression::PropertyAccess(_)
            | Expression::Interpolation(_)
            | Expression::TaskRef(_)
            | Expression::Address(_)
            | Expression::Duration(_)
    )
}

// ── T04: Context references resolve to defined agents/skills ────────

/// T04: Context array references MUST resolve to defined agents or skills.
fn check_t04_context_references(doc: &CantDocument, ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        if let Section::Workflow(wf) = section {
            check_context_refs_in_stmts(&wf.body, ctx, &mut diags);
        }
    }
    diags
}

/// Check context property values for unresolved references.
fn check_context_refs_in_stmts(
    stmts: &[Statement],
    ctx: &ValidationContext,
    diags: &mut Vec<Diagnostic>,
) {
    for stmt in stmts {
        match stmt {
            Statement::Session(sess) => {
                for prop in &sess.properties {
                    if prop.key.value == "context" {
                        check_context_value(&prop.value, prop.span, ctx, diags);
                    }
                }
            }
            Statement::Conditional(cond) => {
                check_context_refs_in_stmts(&cond.then_body, ctx, diags);
                for elif in &cond.elif_branches {
                    check_context_refs_in_stmts(&elif.body, ctx, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_context_refs_in_stmts(else_body, ctx, diags);
                }
            }
            Statement::Repeat(r) => check_context_refs_in_stmts(&r.body, ctx, diags),
            Statement::ForLoop(f) => check_context_refs_in_stmts(&f.body, ctx, diags),
            Statement::LoopUntil(l) => check_context_refs_in_stmts(&l.body, ctx, diags),
            Statement::TryCatch(tc) => {
                check_context_refs_in_stmts(&tc.try_body, ctx, diags);
                if let Some(cb) = &tc.catch_body {
                    check_context_refs_in_stmts(cb, ctx, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_context_refs_in_stmts(fb, ctx, diags);
                }
            }
            _ => {}
        }
    }
}

/// Check a context value for unresolved identifier references.
fn check_context_value(
    value: &Value,
    span: Span,
    ctx: &ValidationContext,
    diags: &mut Vec<Diagnostic>,
) {
    match value {
        Value::Array(elements) => {
            for elem in elements {
                check_context_value(elem, span, ctx, diags);
            }
        }
        Value::Identifier(name) => {
            if !ctx.is_name_defined(name) {
                diags.push(Diagnostic::warning(
                    "T04",
                    format!(
                        "Context reference '{}' at line {} does not resolve to a defined agent, skill, or binding.",
                        name, span.line
                    ),
                    span,
                ));
            }
        }
        _ => {}
    }
}

// ── T05: Parallel arm context references exist ──────────────────────

/// T05: Parallel arm context references MUST refer to existing arms
/// within the same parallel block.
fn check_t05_parallel_arm_refs(doc: &CantDocument, _ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        if let Section::Workflow(wf) = section {
            check_parallel_arm_context_in_stmts(&wf.body, &mut diags);
        }
    }
    diags
}

/// Recursively check parallel blocks for arm context references.
fn check_parallel_arm_context_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        if let Statement::Parallel(block) = stmt {
            // Collect arm names in this block
            let arm_names: Vec<&str> = block.arms.iter().map(|a| a.name.as_str()).collect();

            // Check each arm's body for context references to other arms
            for arm in &block.arms {
                check_arm_body_context_refs(&arm.body, &arm_names, &arm.name, diags);
            }
        }

        // Recurse into nested structures
        match stmt {
            Statement::Conditional(cond) => {
                check_parallel_arm_context_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_parallel_arm_context_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_parallel_arm_context_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_parallel_arm_context_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_parallel_arm_context_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_parallel_arm_context_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_parallel_arm_context_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_parallel_arm_context_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_parallel_arm_context_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

/// Check an arm's body statement for context property references to other arms.
fn check_arm_body_context_refs(
    body: &Statement,
    arm_names: &[&str],
    current_arm: &str,
    diags: &mut Vec<Diagnostic>,
) {
    if let Statement::Session(sess) = body {
        for prop in &sess.properties {
            if prop.key.value == "context" {
                check_arm_context_value(&prop.value, arm_names, current_arm, prop.span, diags);
            }
        }
    }
}

/// Check a context value for arm references that don't exist in the parallel block.
fn check_arm_context_value(
    value: &Value,
    arm_names: &[&str],
    current_arm: &str,
    span: Span,
    diags: &mut Vec<Diagnostic>,
) {
    match value {
        Value::Identifier(name) => {
            // Only check references that look like they could be arm names
            // (not built-in references like "active-tasks")
            if !name.contains('-') && !arm_names.contains(&name.as_str()) {
                diags.push(Diagnostic::warning(
                    "T05",
                    format!(
                        "Parallel arm '{}' references context '{}' at line {} which is not a sibling arm. Available arms: {}.",
                        current_arm,
                        name,
                        span.line,
                        arm_names.join(", ")
                    ),
                    span,
                ));
            }
        }
        Value::Array(elements) => {
            for elem in elements {
                check_arm_context_value(elem, arm_names, current_arm, span, diags);
            }
        }
        _ => {}
    }
}

// ── T06: Approval gate message evaluates to string ──────────────────

/// T06: Approval gate `message` property MUST evaluate to a string.
fn check_t06_approval_message_type(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        if let Section::Workflow(wf) = section {
            check_approval_messages_in_stmts(&wf.body, &mut diags);
        }
    }
    diags
}

/// Recursively check approval gate messages in statements.
fn check_approval_messages_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::ApprovalGate(gate) => {
                for prop in &gate.properties {
                    if prop.key.value == "message" {
                        if !is_value_string_like(&prop.value) {
                            diags.push(Diagnostic::error(
                                "T06",
                                format!(
                                    "Approval gate message at line {} must evaluate to a string.",
                                    prop.span.line
                                ),
                                prop.span,
                            ));
                        }
                    }
                }
            }
            Statement::Conditional(cond) => {
                check_approval_messages_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_approval_messages_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_approval_messages_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_approval_messages_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_approval_messages_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_approval_messages_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_approval_messages_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_approval_messages_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_approval_messages_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

/// Returns true if the value is string-compatible.
fn is_value_string_like(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Identifier(_))
}

// ── T07: Single-pass interpolation ──────────────────────────────────

/// T07: Interpolated values MUST NOT contain nested `${` sequences.
/// CANT uses single-pass interpolation: the result of `${expr}` is NOT
/// re-evaluated for further interpolation.
fn check_t07_no_nested_interpolation(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        match section {
            Section::Workflow(wf) => check_nested_interp_in_stmts(&wf.body, &mut diags),
            Section::Hook(hook) => check_nested_interp_in_stmts(&hook.body, &mut diags),
            Section::Agent(agent) => {
                for hook in &agent.hooks {
                    check_nested_interp_in_stmts(&hook.body, &mut diags);
                }
            }
            _ => {}
        }
    }
    diags
}

/// Recursively check for nested interpolation in statements.
fn check_nested_interp_in_stmts(stmts: &[Statement], diags: &mut Vec<Diagnostic>) {
    for stmt in stmts {
        match stmt {
            Statement::Expression(expr) => check_nested_interp_in_expr(expr, diags),
            Statement::Binding(b) => check_nested_interp_in_expr(&b.value, diags),
            Statement::Output(out) => check_nested_interp_in_expr(&out.value, diags),
            Statement::Conditional(cond) => {
                check_nested_interp_in_stmts(&cond.then_body, diags);
                for elif in &cond.elif_branches {
                    check_nested_interp_in_stmts(&elif.body, diags);
                }
                if let Some(else_body) = &cond.else_body {
                    check_nested_interp_in_stmts(else_body, diags);
                }
            }
            Statement::Repeat(r) => check_nested_interp_in_stmts(&r.body, diags),
            Statement::ForLoop(f) => check_nested_interp_in_stmts(&f.body, diags),
            Statement::LoopUntil(l) => check_nested_interp_in_stmts(&l.body, diags),
            Statement::TryCatch(tc) => {
                check_nested_interp_in_stmts(&tc.try_body, diags);
                if let Some(cb) = &tc.catch_body {
                    check_nested_interp_in_stmts(cb, diags);
                }
                if let Some(fb) = &tc.finally_body {
                    check_nested_interp_in_stmts(fb, diags);
                }
            }
            _ => {}
        }
    }
}

/// Check for nested interpolation within expressions.
fn check_nested_interp_in_expr(expr: &Expression, diags: &mut Vec<Diagnostic>) {
    match expr {
        Expression::String(s) => {
            for seg in &s.segments {
                if let StringSegment::Interpolation(inner) = seg {
                    // Check if the inner expression itself contains string interpolation
                    if contains_interpolation(inner) {
                        diags.push(Diagnostic::error(
                            "T07",
                            format!(
                                "Nested interpolation detected at line {}. CANT uses single-pass interpolation; '${{...}}' inside an interpolated value will NOT be re-evaluated.",
                                s.span.line
                            ),
                            s.span,
                        ));
                    }
                }
            }
        }
        Expression::Interpolation(interp) => {
            if contains_interpolation(&interp.expression) {
                diags.push(Diagnostic::error(
                    "T07",
                    format!(
                        "Nested interpolation detected at line {}. CANT uses single-pass interpolation.",
                        interp.span.line
                    ),
                    interp.span,
                ));
            }
        }
        Expression::Comparison(cmp) => {
            check_nested_interp_in_expr(&cmp.left, diags);
            check_nested_interp_in_expr(&cmp.right, diags);
        }
        Expression::Logical(log) => {
            check_nested_interp_in_expr(&log.left, diags);
            check_nested_interp_in_expr(&log.right, diags);
        }
        _ => {}
    }
}

/// Returns true if the expression tree contains an interpolation node.
fn contains_interpolation(expr: &Expression) -> bool {
    match expr {
        Expression::Interpolation(_) => true,
        Expression::String(s) => s
            .segments
            .iter()
            .any(|seg| matches!(seg, StringSegment::Interpolation(_))),
        Expression::Comparison(cmp) => {
            contains_interpolation(&cmp.left) || contains_interpolation(&cmp.right)
        }
        Expression::Logical(log) => {
            contains_interpolation(&log.left) || contains_interpolation(&log.right)
        }
        Expression::Negation(neg) => contains_interpolation(&neg.operand),
        Expression::PropertyAccess(pa) => contains_interpolation(&pa.object),
        Expression::Array(arr) => arr.elements.iter().any(contains_interpolation),
        _ => false,
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
        let diags = check_t01_property_types(&doc);
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
        let diags = check_t01_property_types(&doc);
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
        let diags = check_t01_property_types(&doc);
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
        let diags = check_t01_property_types(&doc);
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
        let diags = check_t01_property_types(&doc);
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
        let diags = check_t01_property_types(&doc);
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
        let diags = check_t02_comparison_types(&doc);
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
        let diags = check_t02_comparison_types(&doc);
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
        let diags = check_t02_comparison_types(&doc);
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
        let diags = check_t03_interpolation_operands(&doc);
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
        let diags = check_t03_interpolation_operands(&doc);
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
        let diags = check_t03_interpolation_operands(&doc);
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
        let diags = check_t04_context_references(&doc, &ctx);
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
        let diags = check_t04_context_references(&doc, &ctx);
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
        let diags = check_t04_context_references(&doc, &ctx);
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
        let diags = check_t06_approval_message_type(&doc);
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
        let diags = check_t06_approval_message_type(&doc);
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
        let diags = check_t06_approval_message_type(&doc);
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
        let diags = check_t07_no_nested_interpolation(&doc);
        assert!(diags.is_empty());
    }

    #[test]
    fn t07_nested_interpolation_error() {
        // "${outer_${inner}}" — the inner expression is itself an interpolation
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
        let diags = check_t07_no_nested_interpolation(&doc);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_id, "T07");
    }

    #[test]
    fn t07_string_with_interpolation_inside_interpolation() {
        // "${a_string_with_${x}}" — inner string contains interpolation
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
        let diags = check_t07_no_nested_interpolation(&doc);
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
}
