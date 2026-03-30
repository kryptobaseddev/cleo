#![forbid(unsafe_code)]
//! Entry point for the CANT DSL Language Server.
//!
//! Starts a `tower-lsp` server connected via stdio (stdin/stdout).
//! The server delegates all language intelligence to the [`backend`] module.

mod backend;
mod completions;
mod diagnostics;
mod document;
mod goto;
mod hover;
mod symbols;

use backend::CantBackend;
use document::DocumentStore;
use tower_lsp::{LspService, Server};

#[tokio::main]
async fn main() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let (service, socket) =
        LspService::new(|client| CantBackend::new(client, DocumentStore::new()));

    Server::new(stdin, stdout, socket).serve(service).await;
}
