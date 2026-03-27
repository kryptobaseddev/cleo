//! Type validation rules T01--T07.
//!
//! These rules enforce type compatibility for property values, comparison
//! operands, string interpolation operands, and context references.

mod context_rules;
mod helpers;
mod property_rules;

use crate::dsl::ast::CantDocument;

use super::context::ValidationContext;
use super::diagnostic::Diagnostic;

/// Runs all type checks (T01--T07) against `doc`.
pub fn check_all(doc: &CantDocument, ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    diags.extend(property_rules::check_t01_property_types(doc));
    diags.extend(property_rules::check_t02_comparison_types(doc));
    diags.extend(property_rules::check_t03_interpolation_operands(doc));
    diags.extend(context_rules::check_t04_context_references(doc, ctx));
    diags.extend(context_rules::check_t05_parallel_arm_refs(doc, ctx));
    diags.extend(context_rules::check_t06_approval_message_type(doc));
    diags.extend(context_rules::check_t07_no_nested_interpolation(doc));
    diags
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
