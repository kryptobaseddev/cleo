//! Context-aware completion provider for the CANT DSL LSP.
//!
//! Provides completions for keywords, directive verbs, CAAMP event names,
//! model identifiers, agent property keys, and references to agents defined
//! in the current document.

use cant_core::dsl::ast::{CanonicalEvent, CantDocument, Section};
use tower_lsp::lsp_types::{CompletionItem, CompletionItemKind};

// ── Keyword lists ─────────────────────────────────────────────────────

/// Top-level CANT DSL keywords.
pub const TOP_LEVEL_KEYWORDS: &[&str] = &[
    "agent", "skill", "on", "workflow", "pipeline", "@import", "let", "const",
];

/// Directive verbs (after `/`).
pub const DIRECTIVE_VERBS: &[&str] = &[
    "claim", "done", "blocked", "approve", "decision", "checkin", "action", "review", "proposal",
    "ack", "response", "info", "status",
];

/// Model identifier completions.
pub const MODEL_NAMES: &[&str] = &["opus", "sonnet", "haiku"];

/// Property keys valid inside an `agent` block.
pub const AGENT_PROPERTY_KEYS: &[&str] = &[
    "model",
    "prompt",
    "persist",
    "skills",
    "permissions",
    "context",
    "description",
];

/// Control flow keywords that appear inside workflow/hook bodies.
pub const BODY_KEYWORDS: &[&str] = &[
    "if", "elif", "else", "loop", "repeat", "for", "in", "try", "catch", "finally", "parallel",
    "session", "step", "output", "approve", "until", "while", "and", "or", "not",
];

// ── Completion builders ───────────────────────────────────────────────

/// Returns completions for directive verbs (triggered after `/`).
pub fn directive_completions() -> Vec<CompletionItem> {
    DIRECTIVE_VERBS
        .iter()
        .map(|verb| CompletionItem {
            label: format!("/{verb}"),
            kind: Some(CompletionItemKind::KEYWORD),
            detail: Some(directive_detail(verb)),
            insert_text: Some(verb.to_string()),
            ..Default::default()
        })
        .collect()
}

/// Returns completions for all canonical event names (triggered after `on `).
pub fn event_completions() -> Vec<CompletionItem> {
    CanonicalEvent::ALL
        .iter()
        .map(|event| CompletionItem {
            label: event.as_str().to_string(),
            kind: Some(CompletionItemKind::EVENT),
            detail: Some(format!(
                "{} -- {}",
                event.category().as_str(),
                event.description()
            )),
            insert_text: Some(format!("{}:", event.as_str())),
            ..Default::default()
        })
        .collect()
}

/// Returns completions for model identifiers (triggered after `model:`).
pub fn model_completions() -> Vec<CompletionItem> {
    MODEL_NAMES
        .iter()
        .map(|name| CompletionItem {
            label: name.to_string(),
            kind: Some(CompletionItemKind::ENUM_MEMBER),
            detail: Some("Model identifier".to_string()),
            ..Default::default()
        })
        .collect()
}

/// Returns completions for top-level keywords.
pub fn top_level_completions() -> Vec<CompletionItem> {
    TOP_LEVEL_KEYWORDS
        .iter()
        .map(|kw| CompletionItem {
            label: kw.to_string(),
            kind: Some(CompletionItemKind::KEYWORD),
            detail: Some("Top-level keyword".to_string()),
            ..Default::default()
        })
        .collect()
}

/// Returns completions for agent block property keys.
pub fn agent_property_completions() -> Vec<CompletionItem> {
    AGENT_PROPERTY_KEYS
        .iter()
        .map(|key| CompletionItem {
            label: format!("{key}:"),
            kind: Some(CompletionItemKind::PROPERTY),
            detail: Some(property_detail(key)),
            insert_text: Some(format!("{key}: ")),
            ..Default::default()
        })
        .collect()
}

/// Returns completions for control-flow body keywords.
pub fn body_keyword_completions() -> Vec<CompletionItem> {
    BODY_KEYWORDS
        .iter()
        .map(|kw| CompletionItem {
            label: kw.to_string(),
            kind: Some(CompletionItemKind::KEYWORD),
            detail: Some("Control flow keyword".to_string()),
            ..Default::default()
        })
        .collect()
}

/// Returns `@agent-name` completions from agents defined in the document.
pub fn agent_name_completions(doc: &CantDocument) -> Vec<CompletionItem> {
    doc.sections
        .iter()
        .filter_map(|section| match section {
            Section::Agent(a) => Some(CompletionItem {
                label: format!("@{}", a.name.value),
                kind: Some(CompletionItemKind::REFERENCE),
                detail: Some("Agent reference".to_string()),
                insert_text: Some(a.name.value.clone()),
                ..Default::default()
            }),
            _ => None,
        })
        .collect()
}

/// Determines completions based on the line text and cursor column.
///
/// This is a lightweight heuristic: it inspects the text on the current line
/// to decide which completion set to return. A more sophisticated implementation
/// would use the AST and indentation context.
pub fn completions_for_context(line_text: &str, doc: Option<&CantDocument>) -> Vec<CompletionItem> {
    let trimmed = line_text.trim_start();

    // After `/` -> directive verbs
    if trimmed.starts_with('/') {
        return directive_completions();
    }

    // After `on ` -> CAAMP event names
    if trimmed.starts_with("on ") {
        return event_completions();
    }

    // After `model:` -> model names
    if trimmed.starts_with("model:") || trimmed.starts_with("model: ") {
        return model_completions();
    }

    // After `@import ` -> file path completions (stub — would need FS access)
    if trimmed.starts_with("@import ") {
        return vec![CompletionItem {
            label: "\"./\"".to_string(),
            kind: Some(CompletionItemKind::FILE),
            detail: Some("Import path".to_string()),
            ..Default::default()
        }];
    }

    // After `@` (but not `@import`) -> agent references from document
    if trimmed.starts_with('@') {
        if let Some(doc) = doc {
            return agent_name_completions(doc);
        }
    }

    // Indented context (inside a block) -> property keys + body keywords
    if line_text.starts_with("  ") || line_text.starts_with('\t') {
        let mut items = agent_property_completions();
        items.extend(body_keyword_completions());
        return items;
    }

    // Default: top-level keywords + body keywords
    let mut items = top_level_completions();
    items.extend(body_keyword_completions());
    items
}

// ── Detail strings ────────────────────────────────────────────────────

/// Returns a human-readable detail string for a directive verb.
fn directive_detail(verb: &str) -> String {
    match verb {
        "claim" => "actionable -- maps to tasks.claim".to_string(),
        "done" => "actionable -- maps to tasks.complete".to_string(),
        "blocked" => "actionable -- marks task as blocked".to_string(),
        "approve" => "actionable -- approves an approval gate".to_string(),
        "decision" => "actionable -- records a decision".to_string(),
        "checkin" => "actionable -- agent check-in".to_string(),
        "action" => "routing -- signals action needed".to_string(),
        "review" => "routing -- requests review".to_string(),
        "proposal" => "routing -- proposes a change".to_string(),
        "ack" => "informational -- acknowledgement".to_string(),
        "response" => "informational -- response to a request".to_string(),
        "info" => "informational -- status update".to_string(),
        "status" => "informational -- current status".to_string(),
        _ => "directive".to_string(),
    }
}

/// Returns a human-readable detail string for an agent property key.
fn property_detail(key: &str) -> String {
    match key {
        "model" => "Model identifier (opus, sonnet, haiku)".to_string(),
        "prompt" => "System prompt string".to_string(),
        "persist" => "Persistence scope (project, global, session)".to_string(),
        "skills" => "Array of skill identifiers".to_string(),
        "permissions" => "Permission declarations block".to_string(),
        "context" => "Context wiring declarations".to_string(),
        "description" => "Human-readable description".to_string(),
        _ => "Property".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test helper: human-readable detail string for a CAAMP event name.
    fn event_detail(event_name: &str) -> String {
        match CanonicalEvent::from_str(event_name) {
            Some(event) => format!("{} -- {}", event.category().as_str(), event.description()),
            None => "unknown event".to_string(),
        }
    }

    #[test]
    fn directive_completions_count() {
        let items = directive_completions();
        assert_eq!(items.len(), DIRECTIVE_VERBS.len());
    }

    #[test]
    fn directive_completions_have_slash_prefix() {
        let items = directive_completions();
        for item in &items {
            assert!(
                item.label.starts_with('/'),
                "Missing / prefix: {}",
                item.label
            );
        }
    }

    #[test]
    fn event_completions_count() {
        let items = event_completions();
        assert_eq!(items.len(), 31);
    }

    #[test]
    fn event_completions_insert_text_has_colon() {
        let items = event_completions();
        for item in &items {
            let insert = item.insert_text.as_ref().unwrap_or(&item.label);
            assert!(insert.ends_with(':'), "Missing colon: {insert}");
        }
    }

    #[test]
    fn model_completions_count() {
        let items = model_completions();
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn top_level_completions_count() {
        let items = top_level_completions();
        assert_eq!(items.len(), TOP_LEVEL_KEYWORDS.len());
    }

    #[test]
    fn agent_property_completions_count() {
        let items = agent_property_completions();
        assert_eq!(items.len(), AGENT_PROPERTY_KEYS.len());
    }

    #[test]
    fn body_keyword_completions_count() {
        let items = body_keyword_completions();
        assert_eq!(items.len(), BODY_KEYWORDS.len());
    }

    #[test]
    fn context_directive_trigger() {
        let items = completions_for_context("/", None);
        assert!(items.iter().any(|i| i.label.contains("done")));
    }

    #[test]
    fn context_event_trigger() {
        let items = completions_for_context("on ", None);
        assert!(items.iter().any(|i| i.label == "SessionStart"));
    }

    #[test]
    fn context_model_trigger() {
        let items = completions_for_context("model: ", None);
        assert!(items.iter().any(|i| i.label == "opus"));
    }

    #[test]
    fn context_import_trigger() {
        let items = completions_for_context("@import ", None);
        assert!(items.iter().any(|i| i.label.contains("./")));
    }

    #[test]
    fn context_indented_shows_properties() {
        let items = completions_for_context("  ", None);
        assert!(items.iter().any(|i| i.label.contains("model")));
    }

    #[test]
    fn context_default_shows_top_level() {
        let items = completions_for_context("", None);
        assert!(items.iter().any(|i| i.label == "agent"));
    }

    #[test]
    fn directive_detail_done() {
        assert!(directive_detail("done").contains("actionable"));
    }

    #[test]
    fn event_detail_session_start() {
        assert!(event_detail("SessionStart").contains("session"));
    }

    #[test]
    fn property_detail_model() {
        assert!(property_detail("model").contains("opus"));
    }
}
