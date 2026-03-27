//! Document state management for the CANT LSP server.
//!
//! Maintains per-file parsed ASTs and source text so that other providers
//! (diagnostics, completions, hover, etc.) can operate without re-parsing.

use cant_core::dsl::ast::CantDocument;
use std::collections::HashMap;
use tower_lsp::lsp_types::Url;

/// Stores the current state of every open `.cant` document.
pub struct DocumentStore {
    /// Parsed ASTs keyed by document URI.
    documents: HashMap<String, DocumentState>,
}

/// The cached state of a single open document.
pub struct DocumentState {
    /// The raw source text of the document.
    pub text: String,
    /// The most recent successful parse result.  `None` if the document
    /// could not be parsed.
    pub ast: Option<CantDocument>,
    /// Parse errors from the most recent parse attempt.
    pub parse_errors: Vec<cant_core::dsl::error::ParseError>,
}

impl DocumentStore {
    /// Creates a new empty document store.
    pub fn new() -> Self {
        Self {
            documents: HashMap::new(),
        }
    }

    /// Updates the stored document with new source text, re-parsing immediately.
    pub fn update(&mut self, uri: &Url, text: String) {
        let key = uri.to_string();
        let (ast, parse_errors) = match cant_core::parse_document(&text) {
            Ok(doc) => (Some(doc), Vec::new()),
            Err(errs) => (None, errs),
        };
        self.documents.insert(
            key,
            DocumentState {
                text,
                ast,
                parse_errors,
            },
        );
    }

    /// Retrieves the cached document state for a given URI.
    pub fn get(&self, uri: &Url) -> Option<&DocumentState> {
        self.documents.get(&uri.to_string())
    }

    /// Removes a document from the store (e.g., when the file is closed).
    pub fn remove(&mut self, uri: &Url) {
        self.documents.remove(&uri.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_uri(name: &str) -> Url {
        Url::parse(&format!("file:///tmp/{name}.cant")).unwrap_or_else(|_| panic!("bad test URI"))
    }

    #[test]
    fn store_update_and_get() {
        let mut store = DocumentStore::new();
        let uri = test_uri("test");
        store.update(&uri, "agent foo:\n  model: opus\n".to_string());
        let doc = store.get(&uri);
        assert!(doc.is_some());
        assert_eq!(doc.unwrap().text, "agent foo:\n  model: opus\n");
    }

    #[test]
    fn store_remove() {
        let mut store = DocumentStore::new();
        let uri = test_uri("removable");
        store.update(&uri, "agent bar:\n  model: sonnet\n".to_string());
        assert!(store.get(&uri).is_some());
        store.remove(&uri);
        assert!(store.get(&uri).is_none());
    }

    #[test]
    fn store_update_replaces_previous() {
        let mut store = DocumentStore::new();
        let uri = test_uri("replace");
        store.update(&uri, "agent v1:\n  model: opus\n".to_string());
        store.update(&uri, "agent v2:\n  model: haiku\n".to_string());
        let doc = store.get(&uri).unwrap();
        assert!(doc.text.contains("v2"));
    }

    #[test]
    fn store_missing_uri_returns_none() {
        let store = DocumentStore::new();
        let uri = test_uri("nonexistent");
        assert!(store.get(&uri).is_none());
    }

    #[test]
    fn store_invalid_document_stores_errors() {
        let mut store = DocumentStore::new();
        let uri = test_uri("bad");
        // A totally invalid document may or may not parse depending on
        // cant-core's error recovery.  We just verify no panic.
        store.update(&uri, "!!!invalid$$$".to_string());
        let doc = store.get(&uri);
        assert!(doc.is_some());
    }
}
