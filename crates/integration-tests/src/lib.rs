//! Integration tests for the CLEO Rust crate ecosystem
//!
//! Tests the interaction between lafs-core and cant-core
//! to ensure they work together correctly.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[cfg(test)]
mod tests {
    use cant_core::parse;
    use lafs_core::{LafsEnvelope, LafsMeta, LafsTransport};

    #[test]
    fn test_cant_parsing_integration() {
        // Parse a CANT message
        let cant_msg = parse("/done @all T1234 #shipped\n\nTask completed");

        assert_eq!(cant_msg.directive.as_deref(), Some("done"));
        assert_eq!(
            cant_msg.directive_type,
            cant_core::DirectiveType::Actionable
        );
        assert!(cant_msg.addresses.contains(&"all".to_string()));
        assert!(cant_msg.task_refs.contains(&"T1234".to_string()));
        assert!(cant_msg.tags.contains(&"shipped".to_string()));
    }

    #[test]
    fn test_lafs_envelope_creation() {
        // Create LAFS envelope
        let meta = LafsMeta::new("test.op", LafsTransport::Http);
        let envelope = LafsEnvelope::success(serde_json::json!({"result": "ok"}), meta);

        assert!(envelope.success);
        assert!(envelope.error.is_none());
    }

    #[test]
    fn test_full_pipeline() {
        // Step 1: Parse CANT message
        let cant_result = parse("/done @signaldock-dev T5678 #phase-0\n\nCompleted");

        // Step 2: Create LAFS response (cleo-conduit-core retired, T13954)
        let response_meta = LafsMeta::new("messages.send", LafsTransport::Http);
        let response = LafsEnvelope::success(
            serde_json::json!({
                "messageId": "msg-456",
                "directive": cant_result.directive,
                "taskRefs": cant_result.task_refs
            }),
            response_meta,
        );

        // Verify pipeline worked
        assert!(response.success);
        assert_eq!(cant_result.directive.as_deref(), Some("done"));
    }

    #[test]
    fn test_cant_lsp_parse_valid() {
        // Verify the parse pathway used internally by cant-lsp.
        // cant-lsp calls cant_core::parse_document then cant_core::validate_document —
        // we exercise both steps here without spinning up the LSP server.
        //
        // CANT DSL uses `agent Name:` syntax with colon + indented properties.
        // Documents optionally begin with a YAML-style `---` frontmatter block.
        // Format matches the doc comment example in cant_core::dsl::parse_document.
        let doc_content = "---\nkind: agent\n---\nagent cleo-prime:\n  model: opus\n";
        let doc = cant_core::parse_document(doc_content)
            .expect("valid .cant document should parse without errors");

        // Confirm the agent block was found.
        let has_agent = doc.sections.iter().any(
            |s| matches!(s, cant_core::dsl::ast::Section::Agent(a) if a.name.value == "cleo-prime"),
        );
        assert!(has_agent, "expected an agent named cleo-prime in the AST");

        // Run the same validation path that cant-lsp::diagnostics invokes.
        let diagnostics = cant_core::validate_document(&doc);
        // A well-formed document should have no error-severity diagnostics.
        let errors: Vec<_> = diagnostics
            .iter()
            .filter(|d| d.severity == cant_core::validate::diagnostic::Severity::Error)
            .collect();
        assert!(
            errors.is_empty(),
            "unexpected validation errors: {:?}",
            errors.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
    }
}
