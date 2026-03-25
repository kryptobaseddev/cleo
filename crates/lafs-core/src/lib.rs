//! Canonical LAFS envelope types and validation for the CLEO ecosystem.
//!
//! Provides the primary definitions for the LAFS
//! (LLM-Agent-First Schema) response envelopes, mirroring the canonical
//! TypeScript types from `@cleocode/lafs`.
//!
//! # Overview
//!
//! Every CLEO operation returns a [`LafsEnvelope`] containing:
//! - `_meta` ([`LafsMeta`]) — protocol metadata (spec version, transport, MVI level, etc.)
//! - `success` — whether the operation succeeded
//! - `result` / `error` — the payload or structured error
//! - `page` ([`LafsPage`]) — optional pagination information
//!
//! # Example
//!
//! ```
//! use lafs_core::{LafsEnvelope, LafsMeta, LafsTransport};
//!
//! let meta = LafsMeta::new("tasks.list", LafsTransport::Cli);
//! let envelope = LafsEnvelope::success(serde_json::json!({"tasks": []}), meta);
//! assert!(envelope.success);
//! ```

use serde::{Deserialize, Serialize};

// ── Transport ────────────────────────────────────────────────────────────

/// The transport mechanism used to deliver a LAFS envelope.
///
/// Serializes as lowercase strings: `"cli"`, `"http"`, `"grpc"`, `"sdk"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LafsTransport {
    /// Command-line interface transport.
    Cli,
    /// HTTP/REST transport.
    Http,
    /// gRPC transport.
    Grpc,
    /// Direct SDK/library call transport.
    Sdk,
}

// ── Error Category ───────────────────────────────────────────────────────

/// The high-level category of a LAFS error.
///
/// Serializes as `SCREAMING_SNAKE_CASE`: `"VALIDATION"`, `"AUTH"`, `"NOT_FOUND"`, etc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LafsErrorCategory {
    /// Input validation failure.
    Validation,
    /// Authentication failure (identity not verified).
    Auth,
    /// Authorization failure (insufficient permissions).
    Permission,
    /// Requested resource was not found.
    NotFound,
    /// State conflict (e.g., concurrent modification).
    Conflict,
    /// Rate limit exceeded.
    RateLimit,
    /// Transient/retryable server error.
    Transient,
    /// Internal server error.
    Internal,
    /// Contract violation between caller and service.
    Contract,
    /// Migration-related error.
    Migration,
}

// ── MVI Level ────────────────────────────────────────────────────────────

/// The Minimum Viable Information level for envelope output.
///
/// Controls how much detail is included in responses. Serializes as
/// lowercase: `"minimal"`, `"standard"`, `"full"`, `"custom"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MviLevel {
    /// Bare minimum fields only.
    Minimal,
    /// Standard level of detail (default).
    Standard,
    /// Full detail including all optional fields.
    Full,
    /// Custom MVI configuration.
    Custom,
}

// ── Agent Action ─────────────────────────────────────────────────────────

/// Suggested action for an agent to take in response to an error.
///
/// Serializes as `snake_case`: `"retry"`, `"retry_modified"`, `"escalate"`, etc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LafsAgentAction {
    /// Retry the same request unchanged.
    Retry,
    /// Retry with modified parameters.
    RetryModified,
    /// Escalate to a human or higher-authority agent.
    Escalate,
    /// Stop further attempts.
    Stop,
    /// Wait before retrying (see `retry_after_ms`).
    Wait,
    /// Refresh context/cache and retry.
    RefreshContext,
    /// Re-authenticate before retrying.
    Authenticate,
}

// ── Warning ──────────────────────────────────────────────────────────────

/// A deprecation or informational warning attached to a LAFS response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Warning {
    /// Machine-readable warning code.
    pub code: String,
    /// Human-readable warning message.
    pub message: String,
    /// The deprecated field or feature, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deprecated: Option<String>,
    /// The recommended replacement, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement: Option<String>,
    /// The version or date by which the deprecated feature will be removed.
    #[serde(rename = "removeBy", skip_serializing_if = "Option::is_none")]
    pub remove_by: Option<String>,
}

// ── Meta ─────────────────────────────────────────────────────────────────

/// Protocol metadata attached to every LAFS envelope.
///
/// Contains version information, transport details, MVI level, and
/// correlation identifiers for tracing agent workflows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LafsMeta {
    /// LAFS specification version (e.g., `"1.2.3"`).
    pub spec_version: String,
    /// Schema version (e.g., `"2026.2.1"`).
    pub schema_version: String,
    /// ISO 8601 timestamp of when the envelope was created.
    pub timestamp: String,
    /// The operation that produced this envelope (e.g., `"tasks.list"`).
    pub operation: String,
    /// Unique request identifier for correlation.
    pub request_id: String,
    /// The transport mechanism used.
    pub transport: LafsTransport,
    /// Whether strict validation mode is enabled.
    pub strict: bool,
    /// The Minimum Viable Information level.
    pub mvi: MviLevel,
    /// Monotonically increasing context version for cache invalidation.
    pub context_version: u32,
    /// Session identifier for correlating multi-step agent workflows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Warnings about deprecations or other non-fatal issues.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<Warning>>,
}

impl LafsMeta {
    /// Creates a new [`LafsMeta`] with sensible defaults.
    ///
    /// Sets `spec_version` to `"1.2.3"`, `schema_version` to `"2026.2.1"`,
    /// `mvi` to [`MviLevel::Standard`], `strict` to `true`,
    /// `context_version` to `1`, and generates a UUID v4 `request_id`
    /// and an ISO 8601 `timestamp`.
    ///
    /// # Arguments
    ///
    /// * `operation` - The operation name (e.g., `"tasks.list"`).
    /// * `transport` - The transport mechanism used.
    pub fn new(operation: impl Into<String>, transport: LafsTransport) -> Self {
        Self {
            spec_version: "1.2.3".to_string(),
            schema_version: "2026.2.1".to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            operation: operation.into(),
            request_id: uuid::Uuid::new_v4().to_string(),
            transport,
            strict: true,
            mvi: MviLevel::Standard,
            context_version: 1,
            session_id: None,
            warnings: None,
        }
    }
}

// ── Error ────────────────────────────────────────────────────────────────

/// A structured error in a LAFS envelope.
///
/// Contains machine-readable error details including category, retryability,
/// and agent-specific guidance for automated recovery.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LafsError {
    /// Machine-readable error code (e.g., `"E_NOT_FOUND"`).
    pub code: String,
    /// Human-readable error message.
    pub message: String,
    /// High-level error category.
    pub category: LafsErrorCategory,
    /// Whether the operation may succeed if retried.
    pub retryable: bool,
    /// Suggested delay in milliseconds before retrying, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    /// Additional structured details about the error.
    pub details: serde_json::Value,
    /// Suggested action for an agent to take.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_action: Option<LafsAgentAction>,
    /// Whether human escalation is required.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub escalation_required: Option<bool>,
    /// Human-readable description of the suggested recovery action.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_action: Option<String>,
    /// URL to documentation about this error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_url: Option<String>,
}

// ── Pagination ───────────────────────────────────────────────────────────

/// Cursor-based pagination metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LafsPageCursor {
    /// Opaque cursor for the next page, or `None` if no more pages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// Whether more results are available.
    pub has_more: bool,
    /// Maximum number of results per page, if specified.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Total number of results across all pages, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

/// Offset-based pagination metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LafsPageOffset {
    /// Maximum number of results per page.
    pub limit: u32,
    /// Zero-based offset into the result set.
    pub offset: u32,
    /// Whether more results are available.
    pub has_more: bool,
    /// Total number of results, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

/// Marker indicating no pagination is used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LafsPageNone {}

/// Pagination metadata for a LAFS envelope.
///
/// Internally tagged on the `"mode"` field. Variants:
/// - `"cursor"` — cursor-based pagination
/// - `"offset"` — offset-based pagination
/// - `"none"` — no pagination
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode")]
pub enum LafsPage {
    /// Cursor-based pagination.
    #[serde(rename = "cursor")]
    Cursor(LafsPageCursor),
    /// Offset-based pagination.
    #[serde(rename = "offset")]
    Offset(LafsPageOffset),
    /// No pagination.
    #[serde(rename = "none")]
    None(LafsPageNone),
}

// ── Envelope ─────────────────────────────────────────────────────────────

/// The top-level LAFS response envelope.
///
/// Every CLEO operation returns one of these. Use [`LafsEnvelope::success`] or
/// [`LafsEnvelope::error`] to construct envelopes with correct invariants.
///
/// # JSON shape
///
/// ```json
/// {
///   "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
///   "_meta": { ... },
///   "success": true,
///   "result": { ... },
///   "error": null,
///   "page": null,
///   "_extensions": null
/// }
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LafsEnvelope {
    /// JSON Schema URI for the envelope.
    #[serde(rename = "$schema")]
    pub schema: String,
    /// Protocol metadata.
    #[serde(rename = "_meta")]
    pub meta: LafsMeta,
    /// Whether the operation succeeded.
    pub success: bool,
    /// The operation result payload (present when `success` is `true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// The structured error (present when `success` is `false`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<LafsError>,
    /// Pagination metadata, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<LafsPage>,
    /// Extension data for protocol-level consumers.
    #[serde(rename = "_extensions", skip_serializing_if = "Option::is_none")]
    pub extensions: Option<serde_json::Value>,
}

/// Default JSON Schema URI for LAFS envelopes.
const DEFAULT_SCHEMA: &str = "https://lafs.dev/schemas/v1/envelope.schema.json";

impl LafsEnvelope {
    /// Creates a success envelope with the given result and metadata.
    ///
    /// Sets `success` to `true`, `error` to `None`, and uses the default
    /// `$schema` URI.
    ///
    /// # Arguments
    ///
    /// * `result` - The operation result as a JSON value.
    /// * `meta` - Protocol metadata for this response.
    pub fn success(result: serde_json::Value, meta: LafsMeta) -> Self {
        Self {
            schema: DEFAULT_SCHEMA.to_string(),
            meta,
            success: true,
            result: Some(result),
            error: None,
            page: None,
            extensions: None,
        }
    }

    /// Creates an error envelope with the given error and metadata.
    ///
    /// Sets `success` to `false`, `result` to `None`, and uses the default
    /// `$schema` URI.
    ///
    /// # Arguments
    ///
    /// * `error` - The structured error.
    /// * `meta` - Protocol metadata for this response.
    pub fn error(error: LafsError, meta: LafsMeta) -> Self {
        Self {
            schema: DEFAULT_SCHEMA.to_string(),
            meta,
            success: false,
            result: None,
            error: Some(error),
            page: None,
            extensions: None,
        }
    }
}

#[cfg(test)]
mod tests;
