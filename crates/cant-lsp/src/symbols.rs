//! Document symbol provider for the CANT DSL LSP.
//!
//! Extracts an outline of a `.cant` document as LSP [`DocumentSymbol`] items.
//! Each top-level construct (agent, skill, hook, workflow, pipeline, binding)
//! is mapped to an appropriate [`SymbolKind`].

use crate::diagnostics::span_to_range;
use cant_core::dsl::ast::{CantDocument, HookDef, Section};
use tower_lsp::lsp_types::{DocumentSymbol, SymbolKind};

/// Extracts document symbols from a parsed CANT document.
///
/// Returns a flat list of top-level symbols. Agent blocks also include
/// inline hook definitions as children.
#[allow(deprecated)] // DocumentSymbol::deprecated field is itself deprecated in the LSP spec
pub fn document_symbols(doc: &CantDocument) -> Vec<DocumentSymbol> {
    let mut symbols = Vec::new();

    for section in &doc.sections {
        match section {
            Section::Agent(agent) => {
                let range = span_to_range(&agent.span);
                let selection_range = span_to_range(&agent.name.span);
                let children: Vec<DocumentSymbol> =
                    agent.hooks.iter().map(hook_to_symbol).collect();

                symbols.push(DocumentSymbol {
                    name: agent.name.value.clone(),
                    detail: Some("agent".to_string()),
                    kind: SymbolKind::CLASS,
                    tags: None,
                    deprecated: None,
                    range,
                    selection_range,
                    children: if children.is_empty() {
                        None
                    } else {
                        Some(children)
                    },
                });
            }
            Section::Skill(skill) => {
                symbols.push(DocumentSymbol {
                    name: skill.name.value.clone(),
                    detail: Some("skill".to_string()),
                    kind: SymbolKind::MODULE,
                    tags: None,
                    deprecated: None,
                    range: span_to_range(&skill.span),
                    selection_range: span_to_range(&skill.name.span),
                    children: None,
                });
            }
            Section::Hook(hook) => {
                symbols.push(hook_to_symbol(hook));
            }
            Section::Workflow(workflow) => {
                symbols.push(DocumentSymbol {
                    name: workflow.name.value.clone(),
                    detail: Some("workflow".to_string()),
                    kind: SymbolKind::FUNCTION,
                    tags: None,
                    deprecated: None,
                    range: span_to_range(&workflow.span),
                    selection_range: span_to_range(&workflow.name.span),
                    children: None,
                });
            }
            Section::Pipeline(pipeline) => {
                symbols.push(DocumentSymbol {
                    name: pipeline.name.value.clone(),
                    detail: Some("pipeline".to_string()),
                    kind: SymbolKind::FUNCTION,
                    tags: None,
                    deprecated: None,
                    range: span_to_range(&pipeline.span),
                    selection_range: span_to_range(&pipeline.name.span),
                    children: None,
                });
            }
            Section::Binding(binding) => {
                symbols.push(DocumentSymbol {
                    name: binding.name.value.clone(),
                    detail: Some("let".to_string()),
                    kind: SymbolKind::VARIABLE,
                    tags: None,
                    deprecated: None,
                    range: span_to_range(&binding.span),
                    selection_range: span_to_range(&binding.name.span),
                    children: None,
                });
            }
            Section::Import(import) => {
                let name = import.alias.clone().unwrap_or_else(|| import.path.clone());
                symbols.push(DocumentSymbol {
                    name,
                    detail: Some("import".to_string()),
                    kind: SymbolKind::PACKAGE,
                    tags: None,
                    deprecated: None,
                    range: span_to_range(&import.span),
                    selection_range: span_to_range(&import.span),
                    children: None,
                });
            }
            Section::Comment(_) => {
                // Comments are not included in the symbol outline.
            }
            Section::Team(team) => {
                symbols.push(DocumentSymbol {
                    name: team.name.value.clone(),
                    detail: Some("team".to_string()),
                    kind: SymbolKind::NAMESPACE,
                    tags: None,
                    deprecated: None,
                    range: span_to_range(&team.span),
                    selection_range: span_to_range(&team.name.span),
                    children: None,
                });
            }
            Section::Tool(tool) => {
                symbols.push(DocumentSymbol {
                    name: tool.name.value.clone(),
                    detail: Some("tool".to_string()),
                    kind: SymbolKind::FUNCTION,
                    tags: None,
                    deprecated: None,
                    range: span_to_range(&tool.span),
                    selection_range: span_to_range(&tool.name.span),
                    children: None,
                });
            }
        }
    }

    symbols
}

/// Converts a hook definition to a document symbol.
#[allow(deprecated)]
fn hook_to_symbol(hook: &HookDef) -> DocumentSymbol {
    DocumentSymbol {
        name: format!("on {}", hook.event.value),
        detail: Some("hook".to_string()),
        kind: SymbolKind::EVENT,
        tags: None,
        deprecated: None,
        range: span_to_range(&hook.span),
        selection_range: span_to_range(&hook.event.span),
        children: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cant_core::dsl::ast::*;
    use cant_core::dsl::span::Span;

    fn make_doc(sections: Vec<Section>) -> CantDocument {
        CantDocument {
            kind: None,
            frontmatter: None,
            sections,
            span: Span::dummy(),
        }
    }

    fn dummy_span() -> Span {
        Span::dummy()
    }

    #[test]
    fn empty_document_no_symbols() {
        let doc = make_doc(vec![]);
        let syms = document_symbols(&doc);
        assert!(syms.is_empty());
    }

    #[test]
    fn agent_symbol_kind_is_class() {
        let doc = make_doc(vec![Section::Agent(AgentDef {
            name: Spanned::new("ops-lead".to_string(), Span::new(6, 14, 1, 7)),
            properties: vec![],
            permissions: vec![],
            context_refs: vec![],
            hooks: vec![],
            context_sources: vec![],
            mental_model: vec![],
            file_permissions: None,
            span: Span::new(0, 50, 1, 1),
        })]);
        let syms = document_symbols(&doc);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].kind, SymbolKind::CLASS);
        assert_eq!(syms[0].name, "ops-lead");
    }

    #[test]
    fn skill_symbol_kind_is_module() {
        let doc = make_doc(vec![Section::Skill(SkillDef {
            name: Spanned::new("ct-deploy".to_string(), Span::new(6, 15, 1, 7)),
            properties: vec![],
            span: Span::new(0, 50, 1, 1),
        })]);
        let syms = document_symbols(&doc);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].kind, SymbolKind::MODULE);
    }

    #[test]
    fn hook_symbol_kind_is_event() {
        let doc = make_doc(vec![Section::Hook(HookDef {
            event: Spanned::new("SessionStart".to_string(), Span::new(3, 15, 1, 4)),
            body: vec![],
            span: Span::new(0, 40, 1, 1),
        })]);
        let syms = document_symbols(&doc);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].kind, SymbolKind::EVENT);
        assert_eq!(syms[0].name, "on SessionStart");
    }

    #[test]
    fn workflow_symbol_kind_is_function() {
        let doc = make_doc(vec![Section::Workflow(WorkflowDef {
            name: Spanned::new("review".to_string(), Span::new(9, 15, 1, 10)),
            params: vec![],
            body: vec![],
            span: Span::new(0, 50, 1, 1),
        })]);
        let syms = document_symbols(&doc);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].kind, SymbolKind::FUNCTION);
        assert_eq!(syms[0].detail, Some("workflow".to_string()));
    }

    #[test]
    fn pipeline_symbol_kind_is_function() {
        let doc = make_doc(vec![Section::Pipeline(PipelineDef {
            name: Spanned::new("deploy".to_string(), Span::new(9, 15, 1, 10)),
            params: vec![],
            steps: vec![],
            span: Span::new(0, 50, 1, 1),
        })]);
        let syms = document_symbols(&doc);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].kind, SymbolKind::FUNCTION);
        assert_eq!(syms[0].detail, Some("pipeline".to_string()));
    }

    #[test]
    fn binding_symbol_kind_is_variable() {
        let doc = make_doc(vec![Section::Binding(LetBinding {
            name: Spanned::new("status".to_string(), Span::new(4, 10, 1, 5)),
            value: Expression::Name(NameExpr {
                name: "x".to_string(),
                span: dummy_span(),
            }),
            span: Span::new(0, 20, 1, 1),
        })]);
        let syms = document_symbols(&doc);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].kind, SymbolKind::VARIABLE);
    }

    #[test]
    fn import_symbol_uses_alias() {
        let doc = make_doc(vec![Section::Import(ImportStatement {
            path: "./agents/scanner.cant".to_string(),
            alias: Some("scanner".to_string()),
            span: Span::new(0, 40, 1, 1),
        })]);
        let syms = document_symbols(&doc);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "scanner");
        assert_eq!(syms[0].kind, SymbolKind::PACKAGE);
    }

    #[test]
    fn import_symbol_uses_path_when_no_alias() {
        let doc = make_doc(vec![Section::Import(ImportStatement {
            path: "./agents/scanner.cant".to_string(),
            alias: None,
            span: Span::new(0, 40, 1, 1),
        })]);
        let syms = document_symbols(&doc);
        assert_eq!(syms[0].name, "./agents/scanner.cant");
    }

    #[test]
    fn agent_with_hooks_has_children() {
        let doc = make_doc(vec![Section::Agent(AgentDef {
            name: Spanned::new("ops".to_string(), Span::new(6, 9, 1, 7)),
            properties: vec![],
            permissions: vec![],
            context_refs: vec![],
            hooks: vec![HookDef {
                event: Spanned::new("SessionStart".to_string(), Span::new(20, 32, 3, 3)),
                body: vec![],
                span: Span::new(17, 60, 3, 1),
            }],
            context_sources: vec![],
            mental_model: vec![],
            file_permissions: None,
            span: Span::new(0, 70, 1, 1),
        })]);
        let syms = document_symbols(&doc);
        assert_eq!(syms.len(), 1);
        let children = syms[0].children.as_ref().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "on SessionStart");
    }

    #[test]
    fn comment_sections_excluded() {
        let doc = make_doc(vec![Section::Comment(cant_core::dsl::ast::Comment {
            text: " a comment".to_string(),
            span: dummy_span(),
        })]);
        let syms = document_symbols(&doc);
        assert!(syms.is_empty());
    }

    #[test]
    fn multiple_sections_all_listed() {
        let doc = make_doc(vec![
            Section::Agent(AgentDef {
                name: Spanned::new("a".to_string(), Span::new(6, 7, 1, 7)),
                properties: vec![],
                permissions: vec![],
                context_refs: vec![],
                hooks: vec![],
                context_sources: vec![],
                mental_model: vec![],
                file_permissions: None,
                span: Span::new(0, 20, 1, 1),
            }),
            Section::Skill(SkillDef {
                name: Spanned::new("s".to_string(), Span::new(6, 7, 3, 7)),
                properties: vec![],
                span: Span::new(0, 20, 3, 1),
            }),
            Section::Workflow(WorkflowDef {
                name: Spanned::new("w".to_string(), Span::new(9, 10, 5, 10)),
                params: vec![],
                body: vec![],
                span: Span::new(0, 30, 5, 1),
            }),
        ]);
        let syms = document_symbols(&doc);
        assert_eq!(syms.len(), 3);
    }
}
