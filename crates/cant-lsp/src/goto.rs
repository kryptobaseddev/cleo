//! Go-to-definition provider for the CANT DSL LSP.
//!
//! Resolves the definition site of agent references, skill references,
//! import paths, and variable bindings.

use cant_core::dsl::ast::{CantDocument, Section};
use cant_core::dsl::span::Span as CantSpan;

/// The result of a go-to-definition lookup.
#[derive(Debug, Clone)]
pub struct DefinitionLocation {
    /// The span of the definition in the source document.
    pub span: CantSpan,
    /// An optional file path if the definition is in a different file.
    /// `None` means the definition is in the same document.
    pub file_path: Option<String>,
}

/// Finds the definition site for a word in the current document.
///
/// Searches for agent definitions, skill definitions, import paths, and
/// let/const bindings that match the given `word`.
pub fn find_definition(word: &str, doc: &CantDocument) -> Option<DefinitionLocation> {
    let name = word.strip_prefix('@').unwrap_or(word);

    // Search agent definitions
    for section in &doc.sections {
        match section {
            Section::Agent(agent) if agent.name.value == name => {
                return Some(DefinitionLocation {
                    span: agent.name.span,
                    file_path: None,
                });
            }
            Section::Skill(skill) if skill.name.value == name => {
                return Some(DefinitionLocation {
                    span: skill.name.span,
                    file_path: None,
                });
            }
            Section::Import(import) => {
                // If the word matches an import alias, jump to the imported file.
                if let Some(alias) = &import.alias {
                    if alias == name {
                        return Some(DefinitionLocation {
                            span: import.span,
                            file_path: Some(import.path.clone()),
                        });
                    }
                }
                // If the word matches the import path basename without extension
                let basename = import
                    .path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&import.path)
                    .trim_end_matches(".cant");
                if basename == name {
                    return Some(DefinitionLocation {
                        span: import.span,
                        file_path: Some(import.path.clone()),
                    });
                }
            }
            Section::Binding(binding) if binding.name.value == name => {
                return Some(DefinitionLocation {
                    span: binding.name.span,
                    file_path: None,
                });
            }
            _ => {}
        }
    }

    None
}

/// Resolves an import path relative to a base directory.
///
/// Returns the resolved absolute path if the import path is relative.
/// For bare/skill imports, returns `None` (would need skill resolution).
pub fn resolve_import_path(import_path: &str, base_dir: &str) -> Option<String> {
    if import_path.starts_with("./") || import_path.starts_with("../") {
        // Relative path -- resolve against base directory
        let resolved = format!("{base_dir}/{import_path}");
        Some(resolved)
    } else if import_path.starts_with('@') {
        // Skill import -- resolve against .cleo/skills/
        let skill_name = import_path.trim_start_matches('@');
        Some(format!(".cleo/skills/{skill_name}.cant"))
    } else {
        // Bare import -- would need more complex resolution
        None
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

    #[test]
    fn find_agent_definition() {
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
        let loc = find_definition("ops-lead", &doc);
        assert!(loc.is_some());
        let loc = loc.unwrap();
        assert_eq!(loc.span.line, 1);
        assert_eq!(loc.span.col, 7);
        assert!(loc.file_path.is_none());
    }

    #[test]
    fn find_agent_definition_with_at_prefix() {
        let doc = make_doc(vec![Section::Agent(AgentDef {
            name: Spanned::new("scanner".to_string(), Span::new(6, 13, 1, 7)),
            properties: vec![],
            permissions: vec![],
            context_refs: vec![],
            hooks: vec![],
            context_sources: vec![],
            mental_model: vec![],
            file_permissions: None,
            span: Span::new(0, 40, 1, 1),
        })]);
        let loc = find_definition("@scanner", &doc);
        assert!(loc.is_some());
    }

    #[test]
    fn find_skill_definition() {
        let doc = make_doc(vec![Section::Skill(SkillDef {
            name: Spanned::new("ct-deploy".to_string(), Span::new(6, 15, 1, 7)),
            properties: vec![],
            span: Span::new(0, 50, 1, 1),
        })]);
        let loc = find_definition("ct-deploy", &doc);
        assert!(loc.is_some());
    }

    #[test]
    fn find_import_by_alias() {
        let doc = make_doc(vec![Section::Import(ImportStatement {
            path: "./agents/scanner.cant".to_string(),
            alias: Some("scanner".to_string()),
            span: Span::new(0, 40, 1, 1),
        })]);
        let loc = find_definition("scanner", &doc);
        assert!(loc.is_some());
        assert_eq!(
            loc.unwrap().file_path,
            Some("./agents/scanner.cant".to_string())
        );
    }

    #[test]
    fn find_binding_definition() {
        let doc = make_doc(vec![Section::Binding(LetBinding {
            name: Spanned::new("status".to_string(), Span::new(4, 10, 1, 5)),
            value: Expression::Name(NameExpr {
                name: "task.status".to_string(),
                span: Span::dummy(),
            }),
            span: Span::new(0, 30, 1, 1),
        })]);
        let loc = find_definition("status", &doc);
        assert!(loc.is_some());
        assert_eq!(loc.unwrap().span.col, 5);
    }

    #[test]
    fn find_definition_not_found() {
        let doc = make_doc(vec![]);
        assert!(find_definition("nonexistent", &doc).is_none());
    }

    #[test]
    fn resolve_relative_import() {
        let resolved = resolve_import_path("./agents/scanner.cant", "/project");
        assert_eq!(resolved, Some("/project/./agents/scanner.cant".to_string()));
    }

    #[test]
    fn resolve_skill_import() {
        let resolved = resolve_import_path("@ct-deploy", "/project");
        assert_eq!(resolved, Some(".cleo/skills/ct-deploy.cant".to_string()));
    }

    #[test]
    fn resolve_bare_import_returns_none() {
        let resolved = resolve_import_path("some-module", "/project");
        assert!(resolved.is_none());
    }
}
