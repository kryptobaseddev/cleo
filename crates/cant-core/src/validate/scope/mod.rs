//! Scope validation rules S01--S13.
//!
//! These rules enforce name resolution, uniqueness, import safety, and
//! permission constraints across a CANT document.

mod bindings;
mod imports;
mod names;

// Re-export all public functions to maintain the same public API.
pub use bindings::{
    check_binding_order, check_permission_escalation, check_shadowed_bindings,
    check_unresolved_refs,
};
pub use imports::{
    check_circular_import, check_import_depth, check_import_path_traversal,
    check_import_symlink_escape,
};
pub use names::{
    check_permission_values, check_unique_names, check_unique_parallel_arms,
    check_valid_hook_events,
};

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
