//! Parse error types with source locations and severity levels.
//!
//! This module defines the error types emitted by the CANT DSL parser.
//! Each error carries a [`Span`] for precise source location and a
//! [`Severity`] for tooling integration (LSP diagnostics, CLI output).

use super::span::Span;
use serde::{Deserialize, Serialize};

/// Severity level for parse diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Severity {
    /// A fatal error that prevents successful parsing.
    Error,
    /// A warning that does not prevent parsing but indicates a potential issue.
    Warning,
}

/// A diagnostic error produced during CANT document parsing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParseError {
    /// Human-readable description of the error.
    pub message: String,
    /// Source location of the error.
    pub span: Span,
    /// Severity of the diagnostic.
    pub severity: Severity,
}

impl ParseError {
    /// Creates a new error-severity parse error.
    pub fn error(message: impl Into<String>, span: Span) -> Self {
        Self {
            message: message.into(),
            span,
            severity: Severity::Error,
        }
    }

    /// Creates a new warning-severity parse error.
    pub fn warning(message: impl Into<String>, span: Span) -> Self {
        Self {
            message: message.into(),
            span,
            severity: Severity::Warning,
        }
    }
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{}] {}:{}  {}",
            match self.severity {
                Severity::Error => "ERROR",
                Severity::Warning => "WARN",
            },
            self.span.line,
            self.span.col,
            self.message
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_creation() {
        let e = ParseError::error("bad token", Span::new(0, 1, 1, 1));
        assert_eq!(e.severity, Severity::Error);
        assert_eq!(e.message, "bad token");
    }

    #[test]
    fn warning_creation() {
        let w = ParseError::warning("shadowed binding", Span::new(5, 10, 2, 3));
        assert_eq!(w.severity, Severity::Warning);
        assert_eq!(w.span.line, 2);
    }

    #[test]
    fn display_format() {
        let e = ParseError::error("unexpected token", Span::new(0, 1, 3, 7));
        let s = format!("{e}");
        assert!(s.contains("[ERROR]"));
        assert!(s.contains("3:7"));
        assert!(s.contains("unexpected token"));
    }
}
