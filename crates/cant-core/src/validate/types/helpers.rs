//! Shared helper functions for type validation.
//!
//! Provides value classification and type inference utilities used across
//! type rule modules.

use crate::dsl::ast::{Expression, Property, Value};

use crate::validate::diagnostic::Diagnostic;

/// Known property keys and their expected value types.
pub(super) struct ExpectedType {
    pub key: &'static str,
    /// A human-readable expected type name.
    pub expected: &'static str,
    /// Checker function.
    pub check: fn(&Value) -> bool,
}

/// Returns true if the value is a string-like type.
pub(super) fn is_string_like(value: &Value) -> bool {
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

/// Table of known property keys and their expected value types.
pub(super) const EXPECTED_TYPES: &[ExpectedType] = &[
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

/// Check property types against expected types.
pub(super) fn check_props_types(props: &[Property], diags: &mut Vec<Diagnostic>) {
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

/// Infer a simple type string for an expression (for type-compatibility checks).
pub(super) fn infer_expr_type(expr: &Expression) -> Option<&'static str> {
    match expr {
        Expression::String(_) => Some("string"),
        Expression::Number(_) => Some("number"),
        Expression::Boolean(_) => Some("boolean"),
        Expression::Duration(_) => Some("duration"),
        Expression::Array(_) => Some("array"),
        Expression::TaskRef(_) => Some("task_ref"),
        Expression::Address(_) => Some("address"),
        // Name, PropertyAccess, Interpolation, Comparison, Logical, Negation -- unknown at
        // static analysis time
        _ => None,
    }
}

/// Returns true if the expression is stringifiable (can be coerced to a string).
pub(super) fn is_stringifiable(expr: &Expression) -> bool {
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

/// Returns true if the value is string-compatible (for approval message checks).
pub(super) fn is_value_string_like(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Identifier(_))
}

/// Returns true if the expression tree contains an interpolation node.
pub(super) fn contains_interpolation(expr: &Expression) -> bool {
    match expr {
        Expression::Interpolation(_) => true,
        Expression::String(s) => s
            .segments
            .iter()
            .any(|seg| matches!(seg, crate::dsl::ast::StringSegment::Interpolation(_))),
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
