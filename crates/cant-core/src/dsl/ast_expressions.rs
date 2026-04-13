//! Expression AST node types for the CANT DSL.
//!
//! Defines the expression language used in hook bodies, workflow statements,
//! and binding right-hand sides. The expression language is intentionally
//! minimal: no function definitions, no closures, no arithmetic operators.
//!
//! All types in this module are re-exported from [`super::ast`] so that
//! consumers see a unified `ast` module.

use serde::{Deserialize, Serialize};

use super::ast::DurationUnit;
use super::span::Span;

/// Expression types in the CANT expression language.
///
/// The expression language is intentionally minimal: no function definitions,
/// no closures, no arithmetic operators.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Expression {
    /// A name reference (variable or identifier).
    Name(NameExpr),
    /// A string literal.
    String(StringExpr),
    /// A numeric literal.
    Number(NumberExpr),
    /// A boolean literal.
    Boolean(BooleanExpr),
    /// A duration literal.
    Duration(DurationExpr),
    /// A task reference (e.g., `T1234`).
    TaskRef(TaskRefExpr),
    /// An address reference (e.g., `@ops-lead`).
    Address(AddressExpr),
    /// An array literal.
    Array(ArrayExpr),
    /// Property access (e.g., `agent.name`).
    PropertyAccess(PropertyAccessExpr),
    /// A comparison (e.g., `a == b`).
    Comparison(ComparisonExpr),
    /// A logical operation (e.g., `a and b`).
    Logical(LogicalExpr),
    /// A negation (e.g., `not expr`).
    Negation(NegationExpr),
    /// String interpolation expression.
    Interpolation(InterpolationExpr),
}

/// A name/identifier expression.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NameExpr {
    /// The identifier name.
    pub name: String,
    /// Source location.
    pub span: Span,
}

/// A string literal expression (may contain interpolation segments).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StringExpr {
    /// The segments of the string (literal text and interpolation expressions).
    pub segments: Vec<StringSegment>,
    /// Source location.
    pub span: Span,
}

/// A segment within a string literal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StringSegment {
    /// Literal text content.
    Literal(String),
    /// An interpolated expression `${expr}`.
    Interpolation(Expression),
}

/// A numeric literal expression.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NumberExpr {
    /// The numeric value.
    pub value: f64,
    /// Source location.
    pub span: Span,
}

/// A boolean literal expression.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BooleanExpr {
    /// The boolean value.
    pub value: bool,
    /// Source location.
    pub span: Span,
}

/// A duration literal expression (e.g., `30s`, `5m`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DurationExpr {
    /// The numeric amount.
    pub amount: u64,
    /// The time unit.
    pub unit: DurationUnit,
    /// Source location.
    pub span: Span,
}

/// A task reference expression (e.g., `T1234`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRefExpr {
    /// The task ID string including the `T` prefix.
    pub id: String,
    /// Source location.
    pub span: Span,
}

/// An address expression (e.g., `@ops-lead`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddressExpr {
    /// The address name without the `@` prefix.
    pub name: String,
    /// Source location.
    pub span: Span,
}

/// An array literal expression.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArrayExpr {
    /// The array elements.
    pub elements: Vec<Expression>,
    /// Source location.
    pub span: Span,
}

/// A property access expression (e.g., `agent.name`, `a.b.c`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertyAccessExpr {
    /// The object being accessed.
    pub object: Box<Expression>,
    /// The property name.
    pub property: String,
    /// Source location.
    pub span: Span,
}

/// A comparison expression.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComparisonExpr {
    /// Left operand.
    pub left: Box<Expression>,
    /// Comparison operator.
    pub op: ComparisonOp,
    /// Right operand.
    pub right: Box<Expression>,
    /// Source location.
    pub span: Span,
}

/// Comparison operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComparisonOp {
    /// `==`
    Eq,
    /// `!=`
    Ne,
    /// `>`
    Gt,
    /// `<`
    Lt,
    /// `>=`
    Ge,
    /// `<=`
    Le,
}

/// A logical operation expression.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogicalExpr {
    /// Left operand.
    pub left: Box<Expression>,
    /// Logical operator.
    pub op: LogicalOp,
    /// Right operand.
    pub right: Box<Expression>,
    /// Source location.
    pub span: Span,
}

/// Logical operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogicalOp {
    /// `and`
    And,
    /// `or`
    Or,
}

/// A negation expression (e.g., `not expr`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NegationExpr {
    /// The operand being negated.
    pub operand: Box<Expression>,
    /// Source location.
    pub span: Span,
}

/// A string interpolation expression (`${expr}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterpolationExpr {
    /// The interpolated expression.
    pub expression: Box<Expression>,
    /// Source location.
    pub span: Span,
}
