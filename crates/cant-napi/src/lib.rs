//! napi-rs bindings for the cant-core CANT parser.
//!
//! This crate provides Node.js native addon bindings for the CANT parser,
//! replacing the previous wasm-bindgen approach. It wraps [`cant_core::parse`]
//! and [`cant_core::classify_directive`] with napi-rs `#[napi]` exports for
//! synchronous, high-performance access from TypeScript/JavaScript.

use napi_derive::napi;

/// The classification of a directive extracted from a CANT message.
///
/// Maps to the Rust [`cant_core::DirectiveType`] enum, exposed as a
/// string enum for JavaScript consumers.
#[napi(string_enum)]
pub enum JsDirectiveType {
    /// Maps to a CQRS mutation (e.g., `/done`, `/claim`, `/blocked`).
    Actionable,
    /// Signals routing without direct state mutation (e.g., `/action`, `/review`).
    Routing,
    /// Carries context only; triggers no operation (e.g., `/ack`, `/info`).
    Informational,
}

/// The structured result of parsing a CANT message, exposed to JavaScript.
///
/// Contains all extracted elements from both the header and body of the message.
/// Fields use camelCase naming automatically via napi-rs conversion.
#[napi(object)]
pub struct JsParsedCantMessage {
    /// The directive verb if present (e.g., `"done"` from `/done`), or `None`.
    pub directive: Option<String>,
    /// The classification of the directive as a lowercase string.
    pub directive_type: String,
    /// All `@`-addresses found in the message, without the `@` prefix.
    pub addresses: Vec<String>,
    /// All task references found in the message, including the `T` prefix.
    pub task_refs: Vec<String>,
    /// All `#`-tags found in the message, without the `#` prefix.
    pub tags: Vec<String>,
    /// The raw text of the first line (the header).
    pub header_raw: String,
    /// Everything after the first newline (the body).
    pub body: String,
}

/// Parse a CANT message and return the structured result.
///
/// This is the primary entry point for CANT parsing from Node.js.
/// It delegates to [`cant_core::parse`] and converts the result into
/// a JavaScript-compatible object.
///
/// # Arguments
///
/// * `content` - The raw CANT message text to parse.
#[napi]
pub fn cant_parse(content: String) -> JsParsedCantMessage {
    let msg = cant_core::parse(&content);
    JsParsedCantMessage {
        directive: msg.directive,
        directive_type: match msg.directive_type {
            cant_core::DirectiveType::Actionable => "actionable".to_string(),
            cant_core::DirectiveType::Routing => "routing".to_string(),
            cant_core::DirectiveType::Informational => "informational".to_string(),
        },
        addresses: msg.addresses,
        task_refs: msg.task_refs,
        tags: msg.tags,
        header_raw: msg.header_raw,
        body: msg.body,
    }
}

/// Classify a directive verb into its [`JsDirectiveType`].
///
/// Delegates to [`cant_core::classify_directive`] and returns the
/// corresponding napi string enum variant.
///
/// # Arguments
///
/// * `verb` - The directive verb to classify (e.g., `"done"`, `"action"`).
#[napi]
pub fn cant_classify_directive(verb: String) -> JsDirectiveType {
    match cant_core::classify_directive(&verb) {
        cant_core::DirectiveType::Actionable => JsDirectiveType::Actionable,
        cant_core::DirectiveType::Routing => JsDirectiveType::Routing,
        cant_core::DirectiveType::Informational => JsDirectiveType::Informational,
    }
}
