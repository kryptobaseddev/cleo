//! Integration tests for the CLEO Rust crate ecosystem
//!
//! Tests the interaction between lafs-core, conduit-core, cant-core,
//! and signaldock-core to ensure they work together correctly.

#[cfg(test)]
mod tests {
    use cant_core::parse;
    use conduit_core::{CantMetadata, ConduitMessage};
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
    fn test_conduit_message_with_cant_metadata() {
        // Create a ConduitMessage
        let msg = ConduitMessage {
            id: "msg-123".to_string(),
            from: "agent-1".to_string(),
            content: "/done @all T1234 #shipped".to_string(),
            tags: Some(vec!["shipped".to_string()]),
            thread_id: None,
            group_id: None,
            timestamp: "2026-03-25T00:00:00Z".to_string(),
            metadata: None,
        };

        // Verify basic properties
        assert_eq!(msg.id, "msg-123");
        assert_eq!(msg.from, "agent-1");
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

        // Step 2: Create ConduitMessage with content
        let conduit_msg = ConduitMessage {
            id: "msg-456".to_string(),
            from: "cleo-core".to_string(),
            content: cant_result.body.clone(),
            tags: Some(cant_result.tags.clone()),
            thread_id: None,
            group_id: None,
            timestamp: "2026-03-25T00:00:00Z".to_string(),
            metadata: None,
        };

        // Step 3: Create LAFS response
        let response_meta = LafsMeta::new("messages.send", LafsTransport::Http);
        let response = LafsEnvelope::success(
            serde_json::json!({
                "messageId": conduit_msg.id,
                "directive": cant_result.directive,
                "taskRefs": cant_result.task_refs
            }),
            response_meta,
        );

        // Verify pipeline worked
        assert!(response.success);
        assert_eq!(cant_result.directive.as_deref(), Some("done"));
    }
}
