//! Application-level error type with convenient factory methods.
//!
//! [`AppError`] wraps an [`ErrorCode`] with an HTTP status code and
//! converts to a [`StructuredError`] for API serialization.

use std::collections::HashMap;
use std::fmt;

use crate::error::{ErrorCategory, ErrorCode, StructuredError};

/// Application error combining an [`ErrorCode`], message, and HTTP
/// status code.
///
/// Use the factory methods ([`AppError::validation`],
/// [`AppError::not_found`], [`AppError::unauthorized`], etc.) to
/// construct common error types with correct codes and status codes.
///
/// Implements [`std::error::Error`] and [`fmt::Display`] for
/// integration with the `?` operator and logging.
///
/// # Examples
///
/// ```
/// use signaldock_protocol::AppError;
///
/// let err = AppError::not_found("Agent", Some("cleo"));
/// assert_eq!(err.status_code, 404);
///
/// let err = AppError::internal(None);
/// assert_eq!(err.status_code, 500);
/// assert!(err.retryable);
/// ```
#[derive(Debug, Clone)]
pub struct AppError {
    /// Machine-readable error code.
    pub code: ErrorCode,
    /// Human-readable error description.
    pub message: String,
    /// Broad error classification.
    pub category: ErrorCategory,
    /// Whether the client should retry this request.
    pub retryable: bool,
    /// Suggested delay before retrying, in milliseconds.
    pub retry_after_ms: Option<u64>,
    /// Additional structured context (field errors, IDs, etc.).
    pub details: Option<HashMap<String, serde_json::Value>>,
    /// HTTP status code derived from the [`ErrorCategory`].
    pub status_code: u16,
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl AppError {
    /// Creates an [`AppError`] from an [`ErrorCode`], deriving the
    /// category, status code, and retry behavior automatically.
    pub fn new(
        code: ErrorCode,
        message: impl Into<String>,
        details: Option<HashMap<String, serde_json::Value>>,
    ) -> Self {
        let category = code.category();
        let status_code = category.http_status();
        Self {
            retryable: code.retryable(),
            retry_after_ms: code.default_retry_after_ms(),
            code,
            message: message.into(),
            category,
            details,
            status_code,
        }
    }

    /// Converts this error into a [`StructuredError`] for API
    /// serialization.
    pub fn to_structured(&self) -> StructuredError {
        StructuredError {
            code: self.code.clone(),
            message: self.message.clone(),
            category: self.category.clone(),
            retryable: self.retryable,
            retry_after_ms: self.retry_after_ms,
            details: self.details.clone(),
        }
    }

    /// Creates a validation error (HTTP 400) with
    /// [`ErrorCode::EValidationSchema`].
    pub fn validation(
        message: impl Into<String>,
        details: Option<HashMap<String, serde_json::Value>>,
    ) -> Self {
        Self::new(ErrorCode::EValidationSchema, message, details)
    }

    /// Creates a not-found error (HTTP 404) with a resource-specific
    /// [`ErrorCode`].
    ///
    /// Recognized resource names: `"agent"`, `"conversation"`,
    /// `"message"`, `"user"`. All others map to
    /// [`ErrorCode::ENotFoundResource`].
    pub fn not_found(resource: &str, id: Option<&str>) -> Self {
        let code = match resource.to_lowercase().as_str() {
            "agent" => ErrorCode::ENotFoundAgent,
            "conversation" => ErrorCode::ENotFoundConversation,
            "message" => ErrorCode::ENotFoundMessage,
            "user" => ErrorCode::ENotFoundUser,
            _ => ErrorCode::ENotFoundResource,
        };
        let msg = match id {
            Some(id) => format!("{resource} not found: {id}"),
            None => format!("{resource} not found"),
        };
        Self::new(code, msg, None)
    }

    /// Creates an unauthorized error (HTTP 401) with
    /// [`ErrorCode::EAuthUnauthorized`].
    pub fn unauthorized(message: Option<&str>) -> Self {
        Self::new(
            ErrorCode::EAuthUnauthorized,
            message.unwrap_or("Authentication required"),
            None,
        )
    }

    /// Creates a forbidden error (HTTP 403) with
    /// [`ErrorCode::EAuthForbidden`].
    pub fn forbidden(message: Option<&str>) -> Self {
        Self::new(
            ErrorCode::EAuthForbidden,
            message.unwrap_or("Insufficient permissions"),
            None,
        )
    }

    /// Creates a conflict error (HTTP 409) with
    /// [`ErrorCode::EConflictDuplicate`].
    pub fn conflict(
        message: impl Into<String>,
        details: Option<HashMap<String, serde_json::Value>>,
    ) -> Self {
        Self::new(ErrorCode::EConflictDuplicate, message, details)
    }

    /// Creates a rate-limit error (HTTP 429) with
    /// [`ErrorCode::ERateLimit`].
    ///
    /// If `retry_after_ms` is provided, it overrides the default
    /// retry delay.
    pub fn rate_limit(retry_after_ms: Option<u64>) -> Self {
        let mut err = Self::new(
            ErrorCode::ERateLimit,
            "Rate limit exceeded. Please try again later.",
            None,
        );
        if let Some(ms) = retry_after_ms {
            err.retry_after_ms = Some(ms);
        }
        err
    }

    /// Creates an internal server error (HTTP 500) with
    /// [`ErrorCode::EInternalError`].
    pub fn internal(message: Option<&str>) -> Self {
        Self::new(
            ErrorCode::EInternalError,
            message.unwrap_or("Internal server error"),
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_error_factories() {
        let err = AppError::validation("bad input", None);
        assert_eq!(err.status_code, 400);
        assert!(!err.retryable);

        let err = AppError::not_found("Agent", Some("cleo"));
        assert_eq!(err.code, ErrorCode::ENotFoundAgent);

        let err = AppError::rate_limit(Some(30_000));
        assert_eq!(err.retry_after_ms, Some(30_000));
        assert!(err.retryable);
    }

    #[test]
    fn test_to_structured() {
        let err = AppError::internal(None);
        let s = err.to_structured();
        assert_eq!(s.code, ErrorCode::EInternalError);
        assert!(s.retryable);
    }
}
