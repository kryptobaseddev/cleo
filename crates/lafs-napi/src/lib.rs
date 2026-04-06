#![deny(unsafe_code)] // napi-rs macros generate unsafe internally — forbid would conflict
//! napi-rs bindings for lafs-core schema validation.
//!
//! This crate provides Node.js native addon bindings for the LAFS envelope
//! schema validator, replacing the previous AJV-based approach. It wraps
//! [`lafs_core::validate_envelope_json`] with a `#[napi]` export that returns
//! structured validation errors matching the TypeScript `StructuredValidationError`
//! interface.

use napi_derive::napi;

/// A structured validation error exposed to JavaScript.
///
/// Matches the TypeScript `StructuredValidationError` shape in
/// `packages/lafs/src/validateEnvelope.ts`.
#[napi(object)]
pub struct JsValidationError {
    /// JSON Pointer path to the failing property (e.g., `"/_meta/mvi"`).
    pub path: String,
    /// JSON Schema keyword that triggered the error (e.g., `"required"`, `"pattern"`).
    pub keyword: String,
    /// Human-readable error message.
    pub message: String,
    /// Keyword-specific parameters (converted to a JS object via serde).
    pub params: serde_json::Value,
}

/// Result of validating a LAFS envelope against the schema.
///
/// Matches the TypeScript `EnvelopeValidationResult` shape.
#[napi(object)]
pub struct JsValidationResult {
    /// Whether the envelope conforms to the schema.
    pub valid: bool,
    /// Flattened human-readable error messages (empty when valid).
    pub errors: Vec<String>,
    /// Structured error objects with path, keyword, message, and params.
    pub structured_errors: Vec<JsValidationError>,
}

/// Validate a JSON string against the LAFS envelope schema.
///
/// This is the primary entry point for LAFS schema validation from Node.js.
/// It delegates to [`lafs_core::validate_envelope_json`] and converts the
/// result into a JavaScript-compatible object.
///
/// # Arguments
///
/// * `payload` - A JSON string representing a LAFS envelope.
///
/// # Returns
///
/// A [`JsValidationResult`] with:
/// - `valid: true`, empty errors — when the envelope conforms
/// - `valid: false`, populated errors — when validation fails
/// - Throws a napi error — when `payload` is not valid JSON
#[napi]
pub fn lafs_validate_envelope(payload: String) -> napi::Result<JsValidationResult> {
    match lafs_core::validate_envelope_json(&payload) {
        Ok(()) => Ok(JsValidationResult {
            valid: true,
            errors: vec![],
            structured_errors: vec![],
        }),
        Err(lafs_core::ValidateEnvelopeError::InvalidJson(msg)) => Err(napi::Error::new(
            napi::Status::InvalidArg,
            format!("Invalid JSON: {msg}"),
        )),
        Err(lafs_core::ValidateEnvelopeError::SchemaErrors(details)) => {
            let errors: Vec<String> = details
                .iter()
                .map(|d| format!("{} {}", d.path, d.message).trim().to_string())
                .collect();
            let structured_errors: Vec<JsValidationError> = details
                .into_iter()
                .map(|d| JsValidationError {
                    path: d.path,
                    keyword: d.keyword,
                    message: d.message,
                    params: d.params,
                })
                .collect();
            Ok(JsValidationResult {
                valid: false,
                errors,
                structured_errors,
            })
        }
    }
}
