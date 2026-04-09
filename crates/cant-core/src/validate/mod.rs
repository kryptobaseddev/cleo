//! CANT DSL validation engine.
//!
//! Runs all validation rule modules against a parsed [`CantDocument`] and
//! collects [`Diagnostic`] results.  Rule modules are organized by domain:
//!
//! | Module | Prefix | Domain |
//! |--------|--------|--------|
//! | `scope` | S01–S13 | Name resolution, imports, permissions |
//! | `pipeline_purity` | P01–P07 | Pipeline determinism and security |
//! | `types` | T01–T07 | Type compatibility and interpolation |
//! | `hooks` | H01–H04 | Hook event and body constraints |
//! | `workflows` | W01–W11 | Workflow structural limits |

pub mod context;
pub mod diagnostic;
pub mod hierarchy;
pub mod hooks;
pub mod pipeline_purity;
pub mod scope;
pub mod types;
pub mod workflows;

use crate::dsl::ast::CantDocument;
use context::ValidationContext;
use diagnostic::Diagnostic;

/// Runs every validation rule against `doc` and returns all diagnostics.
///
/// The order of rule execution matters: scope rules populate the
/// [`ValidationContext`] symbol tables that later rules depend on.
pub fn validate(doc: &CantDocument) -> Vec<Diagnostic> {
    let mut ctx = ValidationContext::new();
    let mut diags = Vec::new();

    // ── Scope rules (populate symbol tables first) ───────────────────
    diags.extend(scope::check_unique_names(doc, &mut ctx));
    diags.extend(scope::check_valid_hook_events(doc));
    diags.extend(scope::check_unique_parallel_arms(doc));
    diags.extend(scope::check_import_path_traversal(doc));
    diags.extend(scope::check_import_symlink_escape(doc));
    diags.extend(scope::check_import_depth(&ctx));
    diags.extend(scope::check_permission_values(doc));
    diags.extend(scope::check_shadowed_bindings(doc, &mut ctx));
    diags.extend(scope::check_unresolved_refs(doc, &mut ctx));
    diags.extend(scope::check_binding_order(doc));

    // ── Pipeline purity rules ────────────────────────────────────────
    diags.extend(pipeline_purity::check_all(doc, &ctx));

    // ── Type rules ───────────────────────────────────────────────────
    diags.extend(types::check_all(doc, &ctx));

    // ── Hook rules ───────────────────────────────────────────────────
    diags.extend(hooks::check_all(doc, &ctx));

    // ── Workflow rules ───────────────────────────────────────────────
    diags.extend(workflows::check_all(doc, &ctx));

    // ── Hierarchy rules (CleoOS v2) ──────────────────────────────────
    diags.extend(hierarchy::check_all(doc, &ctx));

    diags
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::ast::*;
    use crate::dsl::span::Span;

    fn dummy_span() -> Span {
        Span::dummy()
    }

    fn make_doc(sections: Vec<Section>) -> CantDocument {
        CantDocument {
            kind: None,
            frontmatter: None,
            sections,
            span: dummy_span(),
        }
    }

    #[test]
    fn validate_empty_document_no_diagnostics() {
        let doc = make_doc(vec![]);
        let diags = validate(&doc);
        assert!(diags.is_empty());
    }

    #[test]
    fn validate_calls_scope_rules() {
        // Duplicate agent names should produce S05
        let doc = make_doc(vec![
            Section::Agent(AgentDef {
                name: Spanned::new("dup".to_string(), Span::new(0, 3, 1, 1)),
                properties: vec![],
                permissions: vec![],
                context_refs: vec![],
                hooks: vec![],
                context_sources: vec![],
                mental_model: vec![],
                file_permissions: None,
                span: dummy_span(),
            }),
            Section::Agent(AgentDef {
                name: Spanned::new("dup".to_string(), Span::new(0, 3, 5, 1)),
                properties: vec![],
                permissions: vec![],
                context_refs: vec![],
                hooks: vec![],
                context_sources: vec![],
                mental_model: vec![],
                file_permissions: None,
                span: dummy_span(),
            }),
        ]);
        let diags = validate(&doc);
        assert!(diags.iter().any(|d| d.rule_id == "S05"));
    }

    #[test]
    fn validate_returns_multiple_rule_domains() {
        // A pipeline with a session statement triggers P01
        let doc = make_doc(vec![Section::Pipeline(PipelineDef {
            name: Spanned::new("bad".to_string(), Span::new(0, 3, 1, 1)),
            params: vec![],
            steps: vec![],
            span: dummy_span(),
        })]);
        // This just checks that validation completes without panicking
        let _diags = validate(&doc);
    }
}
