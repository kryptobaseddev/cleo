//! Converts `cant_core` diagnostics into LSP diagnostic types.
//!
//! The validation engine in `cant_core::validate` produces its own
//! [`cant_core::validate::diagnostic::Diagnostic`] type. This module maps
//! those to [`tower_lsp::lsp_types::Diagnostic`] so the LSP server can
//! publish them to the client.

use cant_core::dsl::span::Span as CantSpan;
use cant_core::validate::diagnostic::{
    Diagnostic as CantDiagnostic, Fix, Severity as CantSeverity,
};
use tower_lsp::lsp_types::{
    CodeAction, CodeActionKind, DiagnosticSeverity, NumberOrString, Position, Range,
    TextEdit as LspTextEdit, WorkspaceEdit,
};

/// Converts a `cant_core` [`Span`] to an LSP [`Range`].
///
/// CANT spans use 1-based line/col numbers while LSP uses 0-based positions.
pub fn span_to_range(span: &CantSpan) -> Range {
    // CANT spans are 1-based; LSP positions are 0-based.
    let start_line = span.line.saturating_sub(1);
    let start_col = span.col.saturating_sub(1);

    // We don't have an explicit end line/col in the Span struct, so we
    // estimate the end position on the same line using byte offsets.
    let length = span.end.saturating_sub(span.start) as u32;

    Range {
        start: Position::new(start_line, start_col),
        end: Position::new(start_line, start_col + length),
    }
}

/// Converts a `cant_core` [`Severity`] to an LSP [`DiagnosticSeverity`].
pub fn severity_to_lsp(severity: &CantSeverity) -> DiagnosticSeverity {
    match severity {
        CantSeverity::Error => DiagnosticSeverity::ERROR,
        CantSeverity::Warning => DiagnosticSeverity::WARNING,
        CantSeverity::Info => DiagnosticSeverity::INFORMATION,
        CantSeverity::Hint => DiagnosticSeverity::HINT,
    }
}

/// Converts a single `cant_core` [`Diagnostic`] to an LSP [`Diagnostic`].
pub fn to_lsp_diagnostic(diag: &CantDiagnostic) -> tower_lsp::lsp_types::Diagnostic {
    tower_lsp::lsp_types::Diagnostic {
        range: span_to_range(&diag.span),
        severity: Some(severity_to_lsp(&diag.severity)),
        code: Some(NumberOrString::String(diag.rule_id.clone())),
        code_description: None,
        source: Some("cant-lsp".to_string()),
        message: diag.message.clone(),
        related_information: None,
        tags: None,
        data: None,
    }
}

/// Converts a batch of `cant_core` diagnostics to LSP diagnostics.
pub fn to_lsp_diagnostics(diags: &[CantDiagnostic]) -> Vec<tower_lsp::lsp_types::Diagnostic> {
    diags.iter().map(to_lsp_diagnostic).collect()
}

/// Converts a `cant_core` [`Fix`] into an LSP [`CodeAction`].
///
/// Returns `None` if the fix has no edits.
#[allow(dead_code)] // Public API -- not yet wired into the LSP handler loop
pub fn fix_to_code_action(fix: &Fix, uri: &tower_lsp::lsp_types::Url) -> Option<CodeAction> {
    if fix.edits.is_empty() {
        return None;
    }

    let text_edits: Vec<LspTextEdit> = fix
        .edits
        .iter()
        .map(|edit| LspTextEdit {
            range: span_to_range(&edit.span),
            new_text: edit.new_text.clone(),
        })
        .collect();

    let mut changes = std::collections::HashMap::new();
    changes.insert(uri.clone(), text_edits);

    Some(CodeAction {
        title: fix.description.clone(),
        kind: Some(CodeActionKind::QUICKFIX),
        diagnostics: None,
        edit: Some(WorkspaceEdit {
            changes: Some(changes),
            ..Default::default()
        }),
        command: None,
        is_preferred: Some(true),
        disabled: None,
        data: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cant_core::dsl::span::Span;
    use cant_core::validate::diagnostic::{Diagnostic as CantDiag, Fix, Severity, TextEdit};

    #[test]
    fn span_to_range_basic() {
        let span = Span::new(0, 10, 1, 1);
        let range = span_to_range(&span);
        assert_eq!(range.start.line, 0);
        assert_eq!(range.start.character, 0);
        assert_eq!(range.end.line, 0);
        assert_eq!(range.end.character, 10);
    }

    #[test]
    fn span_to_range_offset_position() {
        let span = Span::new(5, 15, 3, 7);
        let range = span_to_range(&span);
        assert_eq!(range.start.line, 2); // 3 - 1
        assert_eq!(range.start.character, 6); // 7 - 1
        assert_eq!(range.end.character, 16); // 6 + (15 - 5)
    }

    #[test]
    fn span_to_range_zero_line_col() {
        // Dummy span with 0-based line/col (the dummy case)
        let span = Span::dummy();
        let range = span_to_range(&span);
        assert_eq!(range.start.line, 0);
        assert_eq!(range.start.character, 0);
        assert_eq!(range.end.line, 0);
        assert_eq!(range.end.character, 0);
    }

    #[test]
    fn severity_error_maps() {
        assert_eq!(severity_to_lsp(&Severity::Error), DiagnosticSeverity::ERROR);
    }

    #[test]
    fn severity_warning_maps() {
        assert_eq!(
            severity_to_lsp(&Severity::Warning),
            DiagnosticSeverity::WARNING
        );
    }

    #[test]
    fn severity_info_maps() {
        assert_eq!(
            severity_to_lsp(&Severity::Info),
            DiagnosticSeverity::INFORMATION
        );
    }

    #[test]
    fn severity_hint_maps() {
        assert_eq!(severity_to_lsp(&Severity::Hint), DiagnosticSeverity::HINT);
    }

    #[test]
    fn to_lsp_diagnostic_fields() {
        let d = CantDiag::error("S01", "unresolved ref", Span::new(0, 5, 1, 1));
        let lsp = to_lsp_diagnostic(&d);
        assert_eq!(lsp.message, "unresolved ref");
        assert_eq!(lsp.code, Some(NumberOrString::String("S01".to_string())));
        assert_eq!(lsp.source, Some("cant-lsp".to_string()));
        assert_eq!(lsp.severity, Some(DiagnosticSeverity::ERROR));
    }

    #[test]
    fn to_lsp_diagnostic_warning() {
        let d = CantDiag::warning("S02", "shadowed binding", Span::new(10, 20, 2, 5));
        let lsp = to_lsp_diagnostic(&d);
        assert_eq!(lsp.severity, Some(DiagnosticSeverity::WARNING));
        assert_eq!(lsp.range.start.line, 1);
        assert_eq!(lsp.range.start.character, 4);
    }

    #[test]
    fn to_lsp_diagnostics_batch() {
        let diags = vec![
            CantDiag::error("S01", "err1", Span::dummy()),
            CantDiag::warning("S02", "warn1", Span::dummy()),
            CantDiag::info("T01", "info1", Span::dummy()),
        ];
        let lsp = to_lsp_diagnostics(&diags);
        assert_eq!(lsp.len(), 3);
    }

    #[test]
    fn fix_to_code_action_with_edits() {
        let fix = Fix {
            description: "Add let binding".to_string(),
            edits: vec![TextEdit {
                span: Span::new(0, 5, 1, 1),
                new_text: "let x = 0".to_string(),
            }],
        };
        let uri = tower_lsp::lsp_types::Url::parse("file:///tmp/test.cant")
            .unwrap_or_else(|_| panic!("bad URI"));
        let action = fix_to_code_action(&fix, &uri);
        assert!(action.is_some());
        let action = action.unwrap();
        assert_eq!(action.title, "Add let binding");
        assert!(action.is_preferred.unwrap_or(false));
    }

    #[test]
    fn fix_to_code_action_empty_edits_returns_none() {
        let fix = Fix {
            description: "Empty fix".to_string(),
            edits: vec![],
        };
        let uri = tower_lsp::lsp_types::Url::parse("file:///tmp/test.cant")
            .unwrap_or_else(|_| panic!("bad URI"));
        assert!(fix_to_code_action(&fix, &uri).is_none());
    }
}
