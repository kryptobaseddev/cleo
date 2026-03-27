//! Shared helper functions for workflow validation.
//!
//! Provides span extraction, value classification, and identifier validation
//! utilities used across workflow rule modules.

use crate::dsl::ast::{Expression, Statement, Value};
use crate::dsl::span::Span;

/// Returns true if a value is string-compatible.
pub(super) fn is_string_value(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Identifier(_))
}

/// Returns true if the expression is a valid iterable (array, name, or property access).
pub(super) fn is_iterable_expr(expr: &Expression) -> bool {
    matches!(
        expr,
        Expression::Array(_) | Expression::Name(_) | Expression::PropertyAccess(_)
    )
}

/// Returns true if the name is a valid CANT identifier.
pub(super) fn is_valid_identifier(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let first = name.chars().next().unwrap();
    if !first.is_ascii_alphabetic() && first != '_' {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Returns true if the statement is a terminal (flow-ending) statement.
pub(super) fn is_terminal_stmt(stmt: &Statement) -> bool {
    matches!(stmt, Statement::Output(_))
}

/// Extract the span from a statement.
pub(super) fn stmt_span(stmt: &Statement) -> Span {
    match stmt {
        Statement::Binding(b) => b.span,
        Statement::Expression(e) => expr_span(e),
        Statement::Directive(d) => d.span,
        Statement::Property(p) => p.span,
        Statement::Comment(c) => c.span,
        Statement::Session(s) => s.span,
        Statement::Parallel(p) => p.span,
        Statement::Conditional(c) => c.span,
        Statement::Repeat(r) => r.span,
        Statement::ForLoop(f) => f.span,
        Statement::LoopUntil(l) => l.span,
        Statement::TryCatch(tc) => tc.span,
        Statement::ApprovalGate(a) => a.span,
        Statement::Pipeline(p) => p.span,
        Statement::PipeStep(ps) => ps.span,
        Statement::Output(o) => o.span,
    }
}

/// Extract span from an expression.
pub(super) fn expr_span(expr: &Expression) -> Span {
    match expr {
        Expression::Name(n) => n.span,
        Expression::String(s) => s.span,
        Expression::Number(n) => n.span,
        Expression::Boolean(b) => b.span,
        Expression::Duration(d) => d.span,
        Expression::TaskRef(t) => t.span,
        Expression::Address(a) => a.span,
        Expression::Array(a) => a.span,
        Expression::PropertyAccess(p) => p.span,
        Expression::Comparison(c) => c.span,
        Expression::Logical(l) => l.span,
        Expression::Negation(n) => n.span,
        Expression::Interpolation(i) => i.span,
    }
}

/// Convert duration amount + unit to seconds.
pub(super) fn duration_to_seconds(amount: u64, unit: crate::dsl::ast::DurationUnit) -> u64 {
    use crate::dsl::ast::DurationUnit;
    match unit {
        DurationUnit::Seconds => amount,
        DurationUnit::Minutes => amount * 60,
        DurationUnit::Hours => amount * 3600,
        DurationUnit::Days => amount * 86400,
    }
}
