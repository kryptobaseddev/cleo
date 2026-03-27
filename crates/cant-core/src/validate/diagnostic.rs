//! Diagnostic output types for the CANT validation engine.
//!
//! These types are the bridge between the validator and consumers such as
//! the LSP server (Phase 5) and CLI linter.

use crate::dsl::span::Span;
use serde::{Deserialize, Serialize};

/// A diagnostic produced by the validation engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    /// Severity level of this diagnostic.
    pub severity: Severity,
    /// The validation rule that produced this diagnostic (e.g., "S01", "P06").
    pub rule_id: String,
    /// Human-readable diagnostic message.
    pub message: String,
    /// Source location of the issue.
    pub span: Span,
    /// Optional suggested fix for LSP code actions.
    pub fix: Option<Fix>,
}

/// Severity levels for validation diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Severity {
    /// A fatal error that MUST be resolved.
    Error,
    /// A warning indicating a potential issue.
    Warning,
    /// An informational diagnostic.
    Info,
    /// A hint for improvement.
    Hint,
}

/// A suggested code fix for LSP code actions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fix {
    /// Description of what the fix does.
    pub description: String,
    /// The text edits to apply.
    pub edits: Vec<TextEdit>,
}

/// A single text replacement within a source file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextEdit {
    /// The span of text to replace.
    pub span: Span,
    /// The new text to insert in place of the span.
    pub new_text: String,
}

impl Diagnostic {
    /// Creates an error-severity diagnostic.
    pub fn error(rule_id: impl Into<String>, message: impl Into<String>, span: Span) -> Self {
        Self {
            severity: Severity::Error,
            rule_id: rule_id.into(),
            message: message.into(),
            span,
            fix: None,
        }
    }

    /// Creates a warning-severity diagnostic.
    pub fn warning(rule_id: impl Into<String>, message: impl Into<String>, span: Span) -> Self {
        Self {
            severity: Severity::Warning,
            rule_id: rule_id.into(),
            message: message.into(),
            span,
            fix: None,
        }
    }

    /// Creates an info-severity diagnostic.
    pub fn info(rule_id: impl Into<String>, message: impl Into<String>, span: Span) -> Self {
        Self {
            severity: Severity::Info,
            rule_id: rule_id.into(),
            message: message.into(),
            span,
            fix: None,
        }
    }

    /// Attaches a fix suggestion to this diagnostic.
    pub fn with_fix(mut self, fix: Fix) -> Self {
        self.fix = Some(fix);
        self
    }
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let severity_str = match self.severity {
            Severity::Error => "ERROR",
            Severity::Warning => "WARN",
            Severity::Info => "INFO",
            Severity::Hint => "HINT",
        };
        write!(
            f,
            "[{severity_str}] {}: {}:{} {}",
            self.rule_id, self.span.line, self.span.col, self.message
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_error_creation() {
        let d = Diagnostic::error("S01", "unresolved reference 'x'", Span::new(0, 5, 1, 1));
        assert_eq!(d.severity, Severity::Error);
        assert_eq!(d.rule_id, "S01");
        assert!(d.fix.is_none());
    }

    #[test]
    fn diagnostic_warning_creation() {
        let d = Diagnostic::warning("S02", "shadowed binding 'x'", Span::new(10, 15, 2, 3));
        assert_eq!(d.severity, Severity::Warning);
        assert_eq!(d.rule_id, "S02");
    }

    #[test]
    fn diagnostic_with_fix() {
        let d = Diagnostic::error("S01", "unresolved 'x'", Span::dummy()).with_fix(Fix {
            description: "Add let binding".to_string(),
            edits: vec![TextEdit {
                span: Span::dummy(),
                new_text: "let x = 0".to_string(),
            }],
        });
        assert!(d.fix.is_some());
        assert_eq!(d.fix.unwrap().edits.len(), 1);
    }

    #[test]
    fn diagnostic_display_format() {
        let d = Diagnostic::error("P06", "shell injection risk", Span::new(0, 10, 3, 5));
        let s = format!("{d}");
        assert!(s.contains("[ERROR]"));
        assert!(s.contains("P06"));
        assert!(s.contains("3:5"));
        assert!(s.contains("shell injection risk"));
    }

    #[test]
    fn diagnostic_info_creation() {
        let d = Diagnostic::info("T01", "type mismatch", Span::dummy());
        assert_eq!(d.severity, Severity::Info);
    }
}
