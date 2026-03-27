//! Pipeline purity validation rules P01--P07.
//!
//! Pipelines MUST be deterministic: they cannot contain LLM sessions,
//! discretion conditions, approval gates, or shell-injectable commands.

mod rules;

use crate::dsl::ast::{CantDocument, Section};

use super::context::ValidationContext;
use super::diagnostic::Diagnostic;

/// Runs all pipeline purity checks (P01--P07) against `doc`.
pub fn check_all(doc: &CantDocument, ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        if let Section::Pipeline(pipe) = section {
            diags.extend(rules::check_p01_no_sessions(pipe));
            diags.extend(rules::check_p02_no_discretion(pipe));
            diags.extend(rules::check_p03_no_approval_gates(pipe));
            diags.extend(rules::check_p04_no_llm_calls(pipe));
            diags.extend(rules::check_p05_deterministic_steps(pipe));
            diags.extend(rules::check_p06_no_shell_interpolation(pipe));
            diags.extend(rules::check_p07_command_allowlist(pipe, ctx));
        }
        // Also check inline pipeline statements inside workflows
        if let Section::Workflow(wf) = section {
            rules::check_inline_pipelines(&wf.body, ctx, &mut diags);
        }
    }
    diags
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
