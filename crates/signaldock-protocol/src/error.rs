//! Structured error codes, categories, and error payloads.
//!
//! Provides machine-readable error classification so that API clients
//! can programmatically handle failures, determine retryability, and
//! map errors to appropriate HTTP status codes.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

/// Machine-readable error code identifying a specific failure.
///
/// Each variant serializes to a `SCREAMING_SNAKE_CASE` string
/// (e.g. `E_VALIDATION_SCHEMA`) and maps to an [`ErrorCategory`]
/// and default retry behavior via [`ErrorCode::category`] and
/// [`ErrorCode::retryable`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ErrorCode {
    /// Request body failed JSON schema validation.
    #[serde(rename = "E_VALIDATION_SCHEMA")]
    EValidationSchema,
    /// A required field is missing from the request.
    #[serde(rename = "E_VALIDATION_MISSING_FIELD")]
    EValidationMissingField,
    /// A field value has an invalid format (e.g. bad UUID).
    #[serde(rename = "E_VALIDATION_INVALID_FORMAT")]
    EValidationInvalidFormat,
    /// A field value violates a domain constraint.
    #[serde(rename = "E_VALIDATION_CONSTRAINT")]
    EValidationConstraint,
    /// Authentication is required but was not provided.
    #[serde(rename = "E_AUTH_UNAUTHORIZED")]
    EAuthUnauthorized,
    /// The provided authentication token is malformed.
    #[serde(rename = "E_AUTH_INVALID_TOKEN")]
    EAuthInvalidToken,
    /// The authentication token has expired.
    #[serde(rename = "E_AUTH_EXPIRED_TOKEN")]
    EAuthExpiredToken,
    /// The authenticated principal lacks access to this resource.
    #[serde(rename = "E_AUTH_FORBIDDEN")]
    EAuthForbidden,
    /// The principal lacks the specific permission required.
    #[serde(rename = "E_AUTH_INSUFFICIENT_PERMISSIONS")]
    EAuthInsufficientPermissions,
    /// The requested agent was not found.
    #[serde(rename = "E_NOT_FOUND_AGENT")]
    ENotFoundAgent,
    /// The requested conversation was not found.
    #[serde(rename = "E_NOT_FOUND_CONVERSATION")]
    ENotFoundConversation,
    /// The requested message was not found.
    #[serde(rename = "E_NOT_FOUND_MESSAGE")]
    ENotFoundMessage,
    /// The requested user was not found.
    #[serde(rename = "E_NOT_FOUND_USER")]
    ENotFoundUser,
    /// A generic resource was not found.
    #[serde(rename = "E_NOT_FOUND_RESOURCE")]
    ENotFoundResource,
    /// A duplicate resource already exists.
    #[serde(rename = "E_CONFLICT_DUPLICATE")]
    EConflictDuplicate,
    /// The agent has already been claimed by a user.
    #[serde(rename = "E_CONFLICT_ALREADY_CLAIMED")]
    EConflictAlreadyClaimed,
    /// The resource already exists and cannot be recreated.
    #[serde(rename = "E_CONFLICT_ALREADY_EXISTS")]
    EConflictAlreadyExists,
    /// The caller has exceeded the allowed request rate.
    #[serde(rename = "E_RATE_LIMIT")]
    ERateLimit,
    /// An unspecified internal server error occurred.
    #[serde(rename = "E_INTERNAL_ERROR")]
    EInternalError,
    /// A database operation failed.
    #[serde(rename = "E_INTERNAL_DATABASE")]
    EInternalDatabase,
    /// An internal service dependency is unavailable.
    #[serde(rename = "E_INTERNAL_SERVICE")]
    EInternalService,
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Broad classification of an [`ErrorCode`].
///
/// Maps directly to an HTTP status code via
/// [`ErrorCategory::http_status`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCategory {
    /// Input validation failure (HTTP 400).
    Validation,
    /// Authentication failure (HTTP 401).
    Auth,
    /// Authorization / permission failure (HTTP 403).
    Permission,
    /// Resource not found (HTTP 404).
    NotFound,
    /// Resource conflict (HTTP 409).
    Conflict,
    /// Rate limit exceeded (HTTP 429).
    RateLimit,
    /// Temporary / transient failure (HTTP 503).
    Transient,
    /// Internal server error (HTTP 500).
    Internal,
}

impl ErrorCategory {
    /// Returns the HTTP status code for this category.
    pub fn http_status(&self) -> u16 {
        match self {
            Self::Validation => 400,
            Self::Auth => 401,
            Self::Permission => 403,
            Self::NotFound => 404,
            Self::Conflict => 409,
            Self::RateLimit => 429,
            Self::Transient => 503,
            Self::Internal => 500,
        }
    }
}

impl ErrorCode {
    /// Returns the `SCREAMING_SNAKE_CASE` string representation.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::EValidationSchema => "E_VALIDATION_SCHEMA",
            Self::EValidationMissingField => "E_VALIDATION_MISSING_FIELD",
            Self::EValidationInvalidFormat => "E_VALIDATION_INVALID_FORMAT",
            Self::EValidationConstraint => "E_VALIDATION_CONSTRAINT",
            Self::EAuthUnauthorized => "E_AUTH_UNAUTHORIZED",
            Self::EAuthInvalidToken => "E_AUTH_INVALID_TOKEN",
            Self::EAuthExpiredToken => "E_AUTH_EXPIRED_TOKEN",
            Self::EAuthForbidden => "E_AUTH_FORBIDDEN",
            Self::EAuthInsufficientPermissions => "E_AUTH_INSUFFICIENT_PERMISSIONS",
            Self::ENotFoundAgent => "E_NOT_FOUND_AGENT",
            Self::ENotFoundConversation => "E_NOT_FOUND_CONVERSATION",
            Self::ENotFoundMessage => "E_NOT_FOUND_MESSAGE",
            Self::ENotFoundUser => "E_NOT_FOUND_USER",
            Self::ENotFoundResource => "E_NOT_FOUND_RESOURCE",
            Self::EConflictDuplicate => "E_CONFLICT_DUPLICATE",
            Self::EConflictAlreadyClaimed => "E_CONFLICT_ALREADY_CLAIMED",
            Self::EConflictAlreadyExists => "E_CONFLICT_ALREADY_EXISTS",
            Self::ERateLimit => "E_RATE_LIMIT",
            Self::EInternalError => "E_INTERNAL_ERROR",
            Self::EInternalDatabase => "E_INTERNAL_DATABASE",
            Self::EInternalService => "E_INTERNAL_SERVICE",
        }
    }

    /// Returns the [`ErrorCategory`] for this error code.
    pub fn category(&self) -> ErrorCategory {
        match self {
            Self::EValidationSchema
            | Self::EValidationMissingField
            | Self::EValidationInvalidFormat
            | Self::EValidationConstraint => ErrorCategory::Validation,
            Self::EAuthUnauthorized | Self::EAuthInvalidToken | Self::EAuthExpiredToken => {
                ErrorCategory::Auth
            }
            Self::EAuthForbidden | Self::EAuthInsufficientPermissions => ErrorCategory::Permission,
            Self::ENotFoundAgent
            | Self::ENotFoundConversation
            | Self::ENotFoundMessage
            | Self::ENotFoundUser
            | Self::ENotFoundResource => ErrorCategory::NotFound,
            Self::EConflictDuplicate
            | Self::EConflictAlreadyClaimed
            | Self::EConflictAlreadyExists => ErrorCategory::Conflict,
            Self::ERateLimit => ErrorCategory::RateLimit,
            Self::EInternalError | Self::EInternalDatabase | Self::EInternalService => {
                ErrorCategory::Internal
            }
        }
    }

    /// Returns `true` if the error is transient and the request
    /// may succeed on retry.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::ERateLimit
                | Self::EInternalError
                | Self::EInternalDatabase
                | Self::EInternalService
        )
    }

    /// Returns a suggested retry delay in milliseconds, or `None`
    /// if the error is not retryable.
    pub fn default_retry_after_ms(&self) -> Option<u64> {
        match self {
            Self::ERateLimit => Some(60_000),
            Self::EInternalError | Self::EInternalService => Some(5_000),
            Self::EInternalDatabase => Some(3_000),
            _ => None,
        }
    }
}

/// A fully-resolved error payload suitable for API serialization.
///
/// Combines an [`ErrorCode`], human-readable message,
/// [`ErrorCategory`], retry hints, and optional structured details.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredError {
    /// Machine-readable error code.
    pub code: ErrorCode,
    /// Human-readable error description.
    pub message: String,
    /// Broad error classification.
    pub category: ErrorCategory,
    /// Whether the client should retry this request.
    pub retryable: bool,
    /// Suggested delay before retrying, in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    /// Additional structured context (field errors, IDs, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<HashMap<String, serde_json::Value>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_code_roundtrip() {
        let code = ErrorCode::EValidationSchema;
        let json = serde_json::to_string(&code).unwrap();
        assert_eq!(json, "\"E_VALIDATION_SCHEMA\"");
        let parsed: ErrorCode = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, code);
    }

    #[test]
    fn test_structured_error_roundtrip() {
        let err = StructuredError {
            code: ErrorCode::ENotFoundAgent,
            message: "Agent not found".into(),
            category: ErrorCategory::NotFound,
            retryable: false,
            retry_after_ms: None,
            details: None,
        };
        let json = serde_json::to_string(&err).unwrap();
        let parsed: StructuredError = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.code, err.code);
    }

    #[test]
    fn test_error_category_roundtrip() {
        let json = serde_json::to_string(&ErrorCategory::NotFound).unwrap();
        assert_eq!(json, "\"NOT_FOUND\"");
        let parsed: ErrorCategory = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, ErrorCategory::NotFound);
    }
}
