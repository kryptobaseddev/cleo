//! WASM bindings for cant-core
//!
//! Provides JavaScript/TypeScript access to the CANT parser

use crate::{DirectiveType, ParsedCANTMessage, classify_directive, parse};
use wasm_bindgen::prelude::*;

/// JavaScript-facing result of CANT parsing
#[wasm_bindgen]
pub struct CantParseResult {
    directive: Option<String>,
    directive_type: String,
    addresses: Vec<String>,
    task_refs: Vec<String>,
    tags: Vec<String>,
    header_raw: String,
    body: String,
}

#[wasm_bindgen]
impl CantParseResult {
    #[wasm_bindgen(getter)]
    pub fn directive(&self) -> Option<String> {
        self.directive.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn directive_type(&self) -> String {
        self.directive_type.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn addresses(&self) -> Vec<String> {
        self.addresses.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn task_refs(&self) -> Vec<String> {
        self.task_refs.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn tags(&self) -> Vec<String> {
        self.tags.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn header_raw(&self) -> String {
        self.header_raw.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn body(&self) -> String {
        self.body.clone()
    }
}

impl From<ParsedCANTMessage> for CantParseResult {
    fn from(msg: ParsedCANTMessage) -> Self {
        CantParseResult {
            directive: msg.directive,
            directive_type: match msg.directive_type {
                DirectiveType::Actionable => "actionable".to_string(),
                DirectiveType::Routing => "routing".to_string(),
                DirectiveType::Informational => "informational".to_string(),
            },
            addresses: msg.addresses,
            task_refs: msg.task_refs,
            tags: msg.tags,
            header_raw: msg.header_raw,
            body: msg.body,
        }
    }
}

/// Parse a CANT message from JavaScript
#[wasm_bindgen]
pub fn cant_parse(content: &str) -> CantParseResult {
    parse(content).into()
}

/// Classify a directive verb
#[wasm_bindgen]
pub fn cant_classify_directive(verb: &str) -> String {
    match classify_directive(verb) {
        DirectiveType::Actionable => "actionable".to_string(),
        DirectiveType::Routing => "routing".to_string(),
        DirectiveType::Informational => "informational".to_string(),
    }
}
