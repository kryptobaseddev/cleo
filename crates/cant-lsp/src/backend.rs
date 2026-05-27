//! LSP backend implementing the `LanguageServer` trait from `tower-lsp`.
//!
//! Wires all provider modules (diagnostics, completions, hover, goto,
//! symbols) into the LSP protocol lifecycle.

use crate::completions;
use crate::diagnostics;
use crate::document::DocumentStore;
use crate::goto;
use crate::hover;
use crate::symbols;

use std::sync::Mutex;
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer};

/// The CANT DSL language server backend.
pub struct CantBackend {
    /// The LSP client handle for sending notifications (e.g., diagnostics).
    client: Client,
    /// Thread-safe mutable document store.
    documents: Mutex<DocumentStore>,
}

impl CantBackend {
    /// Creates a new backend instance.
    pub fn new(client: Client, documents: DocumentStore) -> Self {
        Self {
            client,
            documents: Mutex::new(documents),
        }
    }

    /// Parses a document and publishes diagnostics to the client.
    async fn publish_diagnostics(&self, uri: Url, text: String) {
        // Update the document store (re-parses the file).
        {
            let Ok(mut store) = self.documents.lock() else {
                return;
            };
            store.update(&uri, text);
        }

        // Collect diagnostics from the parsed AST.
        let lsp_diags = {
            let Ok(store) = self.documents.lock() else {
                return;
            };
            let Some(doc_state) = store.get(&uri) else {
                return;
            };

            match &doc_state.ast {
                Some(ast) => {
                    let cant_diags = cant_core::validate_document(ast);
                    diagnostics::to_lsp_diagnostics(&cant_diags)
                }
                None => {
                    // Parse errors -- convert to diagnostics.
                    doc_state
                        .parse_errors
                        .iter()
                        .map(|err| Diagnostic {
                            range: diagnostics::span_to_range(&err.span),
                            severity: Some(DiagnosticSeverity::ERROR),
                            code: None,
                            source: Some("cant-lsp".to_string()),
                            message: err.message.clone(),
                            ..Default::default()
                        })
                        .collect()
                }
            }
        };

        self.client.publish_diagnostics(uri, lsp_diags, None).await;
    }

    /// Extracts the word at the given position from the document text.
    fn word_at_position(text: &str, position: &Position) -> Option<(String, String)> {
        let lines: Vec<&str> = text.lines().collect();
        let line_idx = position.line as usize;
        if line_idx >= lines.len() {
            return None;
        }
        let line = lines[line_idx];
        let col = position.character as usize;

        // Find word boundaries around the cursor
        let chars: Vec<char> = line.chars().collect();
        let mut start = col.min(chars.len());
        let mut end = start;

        // Extend left to find word start
        while start > 0 && is_word_char(chars[start - 1]) {
            start -= 1;
        }
        // Include leading `/` or `@` for directives/addresses
        if start > 0 && (chars[start - 1] == '/' || chars[start - 1] == '@') {
            start -= 1;
        }
        // Extend right to find word end
        while end < chars.len() && is_word_char(chars[end]) {
            end += 1;
        }

        if start == end {
            return None;
        }

        let word: String = chars[start..end].iter().collect();
        Some((word, line.to_string()))
    }
}

/// Returns `true` if `c` is a valid word character for CANT identifiers.
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '-' || c == '_'
}

#[tower_lsp::async_trait]
impl LanguageServer for CantBackend {
    async fn initialize(&self, _: InitializeParams) -> Result<InitializeResult> {
        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                completion_provider: Some(CompletionOptions {
                    trigger_characters: Some(vec![
                        "/".to_string(),
                        "@".to_string(),
                        ":".to_string(),
                        " ".to_string(),
                    ]),
                    resolve_provider: Some(false),
                    ..Default::default()
                }),
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                definition_provider: Some(OneOf::Left(true)),
                document_symbol_provider: Some(OneOf::Left(true)),
                ..Default::default()
            },
            server_info: Some(ServerInfo {
                name: "cant-lsp".to_string(),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            }),
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        self.client
            .log_message(MessageType::INFO, "cant-lsp server initialized")
            .await;
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let uri = params.text_document.uri;
        let text = params.text_document.text;
        self.publish_diagnostics(uri, text).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let uri = params.text_document.uri;
        // We use full sync, so there's exactly one change with the full text.
        if let Some(change) = params.content_changes.into_iter().next() {
            self.publish_diagnostics(uri, change.text).await;
        }
    }

    async fn did_save(&self, params: DidSaveTextDocumentParams) {
        let uri = params.text_document.uri;
        // Re-read from store if text wasn't included in the save notification.
        if let Some(text) = params.text {
            self.publish_diagnostics(uri, text).await;
        }
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        let uri = params.text_document.uri;
        if let Ok(mut store) = self.documents.lock() {
            store.remove(&uri);
        }
        // Clear diagnostics for the closed file.
        self.client.publish_diagnostics(uri, vec![], None).await;
    }

    async fn completion(&self, params: CompletionParams) -> Result<Option<CompletionResponse>> {
        let uri = &params.text_document_position.text_document.uri;
        let position = &params.text_document_position.position;

        let Ok(store) = self.documents.lock() else {
            return Ok(None);
        };
        let Some(doc_state) = store.get(uri) else {
            return Ok(None);
        };

        // Get the line text at the cursor position
        let lines: Vec<&str> = doc_state.text.lines().collect();
        let line_idx = position.line as usize;
        let line_text = if line_idx < lines.len() {
            // Only include text up to cursor position for context detection
            let line = lines[line_idx];
            let col = (position.character as usize).min(line.len());
            &line[..col]
        } else {
            ""
        };

        let items = completions::completions_for_context(line_text, doc_state.ast.as_ref());
        Ok(Some(CompletionResponse::Array(items)))
    }

    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let uri = &params.text_document_position_params.text_document.uri;
        let position = &params.text_document_position_params.position;

        let Ok(store) = self.documents.lock() else {
            return Ok(None);
        };
        let Some(doc_state) = store.get(uri) else {
            return Ok(None);
        };

        let Some((word, line_text)) = Self::word_at_position(&doc_state.text, position) else {
            return Ok(None);
        };

        let info = hover::hover_for_word(&word, &line_text, doc_state.ast.as_ref());
        Ok(info.map(|i| Hover {
            contents: HoverContents::Markup(MarkupContent {
                kind: MarkupKind::Markdown,
                value: i.contents,
            }),
            range: None,
        }))
    }

    async fn goto_definition(
        &self,
        params: GotoDefinitionParams,
    ) -> Result<Option<GotoDefinitionResponse>> {
        let uri = &params.text_document_position_params.text_document.uri;
        let position = &params.text_document_position_params.position;

        let Ok(store) = self.documents.lock() else {
            return Ok(None);
        };
        let Some(doc_state) = store.get(uri) else {
            return Ok(None);
        };
        let Some(ast) = &doc_state.ast else {
            return Ok(None);
        };

        let Some((word, _)) = Self::word_at_position(&doc_state.text, position) else {
            return Ok(None);
        };

        let Some(def_loc) = goto::find_definition(&word, ast) else {
            return Ok(None);
        };

        let target_uri = match &def_loc.file_path {
            Some(path) => {
                // Attempt to resolve relative to the document's directory.
                if let Some(base) = uri
                    .to_file_path()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_string_lossy().to_string()))
                {
                    if let Some(resolved) = goto::resolve_import_path(path, &base) {
                        Url::from_file_path(&resolved).unwrap_or_else(|_| uri.clone())
                    } else {
                        uri.clone()
                    }
                } else {
                    uri.clone()
                }
            }
            None => uri.clone(),
        };

        let range = diagnostics::span_to_range(&def_loc.span);
        Ok(Some(GotoDefinitionResponse::Scalar(Location::new(
            target_uri, range,
        ))))
    }

    async fn document_symbol(
        &self,
        params: DocumentSymbolParams,
    ) -> Result<Option<DocumentSymbolResponse>> {
        let uri = &params.text_document.uri;

        let Ok(store) = self.documents.lock() else {
            return Ok(None);
        };
        let Some(doc_state) = store.get(uri) else {
            return Ok(None);
        };
        let Some(ast) = &doc_state.ast else {
            return Ok(None);
        };

        let syms = symbols::document_symbols(ast);
        Ok(Some(DocumentSymbolResponse::Nested(syms)))
    }
}
