//! Import safety rules: S03, S09, S10, S11.
//!
//! S03: Circular import chain detection.
//! S09: Import path traversal prevention.
//! S10: Symlink escape prevention.
//! S11: Import chain depth limit.

use crate::dsl::ast::CantDocument;
use crate::dsl::ast::Section;
use crate::dsl::span::Span;

use crate::validate::context::ValidationContext;
use crate::validate::diagnostic::Diagnostic;

// ── S09: Import path traversal prevention ──────────────────────────

/// S09: Import paths MUST NOT escape the project root via `..` traversal.
pub fn check_import_path_traversal(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        if let Section::Import(imp) = section {
            if path_escapes_root(&imp.path) {
                diags.push(Diagnostic::error(
                    "S09",
                    format!(
                        "Import path '{}' escapes the project root. Imports MUST resolve within the project directory.",
                        imp.path
                    ),
                    imp.span,
                ));
            }
        }
    }

    diags
}

/// Checks whether a relative path escapes the project root by resolving
/// `..` components. Returns true if the net path goes above the starting
/// directory.
pub(super) fn path_escapes_root(path: &str) -> bool {
    let mut depth: i32 = 0;
    for component in path.split('/') {
        match component {
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            "" | "." => {}
            _ => {
                depth += 1;
            }
        }
    }
    false
}

// ── S10: Symlink escape prevention ─────────────────────────────────

/// S10: Import paths MUST NOT follow symlinks resolving outside project root.
///
/// Note: This is a static-analysis level check. Full symlink resolution requires
/// filesystem access and is performed at import resolution time (runtime). The
/// static check flags patterns known to be suspicious (e.g., `/` prefixed paths).
pub fn check_import_symlink_escape(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    for section in &doc.sections {
        if let Section::Import(imp) = section {
            // Static check: absolute paths are never relative to project root
            if imp.path.starts_with('/') {
                diags.push(Diagnostic::error(
                    "S10",
                    format!(
                        "Import '{}' uses an absolute path. Imports MUST be relative to the project root to prevent symlink escape.",
                        imp.path
                    ),
                    imp.span,
                ));
            }
        }
    }

    diags
}

// ── S11: Import chain depth limit ──────────────────────────────────

/// S11: Import chain depth MUST NOT exceed the configured maximum.
pub fn check_import_depth(ctx: &ValidationContext) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    let depth = ctx.import_chain.len() as u32;
    if depth > ctx.limits.max_import_depth {
        let last_path = ctx.import_chain.last().cloned().unwrap_or_default();
        diags.push(Diagnostic::error(
            "S11",
            format!(
                "Import chain depth of {} exceeds the maximum of {} at '{}'. Flatten your import hierarchy.",
                depth, ctx.limits.max_import_depth, last_path
            ),
            Span::dummy(),
        ));
    }
    diags
}

// ── S03: Circular import chains ────────────────────────────────────

/// S03: Check for circular import chains.
///
/// Note: Full cycle detection requires resolving imports across files. This
/// check validates the import_chain in the context. Call before processing
/// each import to verify the target is not already in the chain.
pub fn check_circular_import(path: &str, ctx: &ValidationContext, span: Span) -> Vec<Diagnostic> {
    let mut diags = Vec::new();

    if ctx.import_chain.contains(&path.to_string()) {
        let chain_str = ctx.import_chain.join(" -> ");
        diags.push(Diagnostic::error(
            "S03",
            format!(
                "Circular import chain detected: {chain_str} -> {path}. Break the cycle by extracting shared definitions."
            ),
            span,
        ));
    }

    diags
}
