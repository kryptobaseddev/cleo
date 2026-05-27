//! Workflow validation rules W01--W11.
//!
//! These rules enforce structural constraints on workflow constructs:
//! approval gate requirements, parallel arm uniqueness, expression types,
//! reachability, and configurable safety limits.

mod helpers;
mod limits;
mod rules;

use crate::dsl::ast::{CantDocument, Section};

use super::context::ValidationContext;
use super::diagnostic::Diagnostic;

/// Runs all workflow checks (W01--W11) against `doc`.
pub fn check_all(doc: &CantDocument, ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for section in &doc.sections {
        if let Section::Workflow(wf) = section {
            diags.extend(rules::check_w01_approval_message(wf));
            diags.extend(rules::check_w02_parallel_arm_names(wf));
            diags.extend(rules::check_w03_session_prompts(wf));
            diags.extend(rules::check_w04_loop_iterables(wf));
            diags.extend(rules::check_w05_try_blocks(wf));
            diags.extend(rules::check_w06_workflow_names(wf));
            diags.extend(limits::check_w07_unreachable_code(wf));
            diags.extend(limits::check_w08_timeout_limits(wf, ctx));
            diags.extend(limits::check_w09_parallel_arm_limits(wf, ctx));
            diags.extend(limits::check_w10_repeat_count_limits(wf, ctx));
            diags.extend(limits::check_w11_nesting_depth(wf, ctx));
        }
    }
    diags
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
