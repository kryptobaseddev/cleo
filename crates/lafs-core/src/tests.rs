use super::*;

/// Helper to build a deterministic [`LafsMeta`] for tests.
fn test_meta() -> LafsMeta {
    LafsMeta {
        spec_version: "1.2.3".to_string(),
        schema_version: "2026.2.1".to_string(),
        timestamp: "2026-03-24T12:00:00Z".to_string(),
        operation: "tasks.list".to_string(),
        request_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_string(),
        transport: LafsTransport::Cli,
        strict: true,
        mvi: MviLevel::Standard,
        context_version: 1,
        session_id: None,
        warnings: None,
    }
}

/// Helper to build a deterministic [`LafsError`] for tests.
fn test_error() -> LafsError {
    LafsError {
        code: "E_NOT_FOUND".to_string(),
        message: "Task not found".to_string(),
        category: LafsErrorCategory::NotFound,
        retryable: false,
        retry_after_ms: None,
        details: serde_json::json!({}),
        agent_action: Some(LafsAgentAction::Stop),
        escalation_required: None,
        suggested_action: None,
        doc_url: None,
    }
}

// ── Transport serialization ──────────────────────────────────────────

#[test]
fn transport_serializes_as_lowercase() {
    assert_eq!(
        serde_json::to_string(&LafsTransport::Cli).ok(),
        Some("\"cli\"".to_string())
    );
    assert_eq!(
        serde_json::to_string(&LafsTransport::Http).ok(),
        Some("\"http\"".to_string())
    );
    assert_eq!(
        serde_json::to_string(&LafsTransport::Grpc).ok(),
        Some("\"grpc\"".to_string())
    );
    assert_eq!(
        serde_json::to_string(&LafsTransport::Sdk).ok(),
        Some("\"sdk\"".to_string())
    );
}

#[test]
fn transport_deserializes_from_lowercase() {
    let cli: LafsTransport = serde_json::from_str("\"cli\"").unwrap_or(LafsTransport::Sdk);
    assert_eq!(cli, LafsTransport::Cli);
}

// ── Error category serialization ─────────────────────────────────────

#[test]
fn error_category_serializes_as_screaming_snake() {
    assert_eq!(
        serde_json::to_string(&LafsErrorCategory::Validation).ok(),
        Some("\"VALIDATION\"".to_string())
    );
    assert_eq!(
        serde_json::to_string(&LafsErrorCategory::NotFound).ok(),
        Some("\"NOT_FOUND\"".to_string())
    );
    assert_eq!(
        serde_json::to_string(&LafsErrorCategory::RateLimit).ok(),
        Some("\"RATE_LIMIT\"".to_string())
    );
}

#[test]
fn error_category_round_trips() {
    let categories = [
        LafsErrorCategory::Validation,
        LafsErrorCategory::Auth,
        LafsErrorCategory::Permission,
        LafsErrorCategory::NotFound,
        LafsErrorCategory::Conflict,
        LafsErrorCategory::RateLimit,
        LafsErrorCategory::Transient,
        LafsErrorCategory::Internal,
        LafsErrorCategory::Contract,
        LafsErrorCategory::Migration,
    ];
    for cat in categories {
        let json = serde_json::to_string(&cat);
        assert!(json.is_ok(), "Failed to serialize {cat:?}");
        let back: Result<LafsErrorCategory, _> =
            serde_json::from_str(json.as_ref().map_or("", String::as_str));
        assert!(back.is_ok(), "Failed to deserialize {cat:?}");
        assert_eq!(back.ok(), Some(cat));
    }
}

// ── MVI level serialization ──────────────────────────────────────────

#[test]
fn mvi_level_serializes_as_lowercase() {
    assert_eq!(
        serde_json::to_string(&MviLevel::Minimal).ok(),
        Some("\"minimal\"".to_string())
    );
    assert_eq!(
        serde_json::to_string(&MviLevel::Standard).ok(),
        Some("\"standard\"".to_string())
    );
    assert_eq!(
        serde_json::to_string(&MviLevel::Full).ok(),
        Some("\"full\"".to_string())
    );
    assert_eq!(
        serde_json::to_string(&MviLevel::Custom).ok(),
        Some("\"custom\"".to_string())
    );
}

// ── Agent action serialization ───────────────────────────────────────

#[test]
fn agent_action_serializes_as_snake_case() {
    assert_eq!(
        serde_json::to_string(&LafsAgentAction::Retry).ok(),
        Some("\"retry\"".to_string())
    );
    assert_eq!(
        serde_json::to_string(&LafsAgentAction::RetryModified).ok(),
        Some("\"retry_modified\"".to_string())
    );
    assert_eq!(
        serde_json::to_string(&LafsAgentAction::RefreshContext).ok(),
        Some("\"refresh_context\"".to_string())
    );
    assert_eq!(
        serde_json::to_string(&LafsAgentAction::Authenticate).ok(),
        Some("\"authenticate\"".to_string())
    );
}

// ── Warning serialization ────────────────────────────────────────────

#[test]
fn warning_remove_by_serializes_as_camel_case() {
    let warning = Warning {
        code: "W_DEPRECATED".to_string(),
        message: "Field X is deprecated".to_string(),
        deprecated: Some("fieldX".to_string()),
        replacement: Some("fieldY".to_string()),
        remove_by: Some("2027.1.0".to_string()),
    };
    let json = serde_json::to_value(&warning);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();
    assert_eq!(
        val.get("removeBy").and_then(|v| v.as_str()),
        Some("2027.1.0")
    );
    // Ensure snake_case key is NOT present
    assert!(val.get("remove_by").is_none());
}

#[test]
fn warning_omits_none_fields() {
    let warning = Warning {
        code: "W_TEST".to_string(),
        message: "test".to_string(),
        deprecated: None,
        replacement: None,
        remove_by: None,
    };
    let json = serde_json::to_value(&warning);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();
    assert!(val.get("deprecated").is_none());
    assert!(val.get("replacement").is_none());
    assert!(val.get("removeBy").is_none());
}

// ── LafsMeta ─────────────────────────────────────────────────────────

#[test]
fn meta_new_sets_defaults() {
    let meta = LafsMeta::new("tasks.show", LafsTransport::Http);
    assert_eq!(meta.spec_version, "1.2.3");
    assert_eq!(meta.schema_version, "2026.2.1");
    assert_eq!(meta.operation, "tasks.show");
    assert_eq!(meta.transport, LafsTransport::Http);
    assert!(meta.strict);
    assert_eq!(meta.mvi, MviLevel::Standard);
    assert_eq!(meta.context_version, 1);
    assert!(meta.session_id.is_none());
    assert!(meta.warnings.is_none());
    // request_id should be a valid UUID v4 (36 chars with hyphens)
    assert_eq!(meta.request_id.len(), 36);
    // timestamp should be non-empty
    assert!(!meta.timestamp.is_empty());
}

#[test]
fn meta_serializes_camel_case_keys() {
    let meta = test_meta();
    let json = serde_json::to_value(&meta);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();
    assert!(val.get("specVersion").is_some());
    assert!(val.get("schemaVersion").is_some());
    assert!(val.get("requestId").is_some());
    assert!(val.get("contextVersion").is_some());
    // snake_case keys must NOT be present
    assert!(val.get("spec_version").is_none());
    assert!(val.get("schema_version").is_none());
    assert!(val.get("request_id").is_none());
    assert!(val.get("context_version").is_none());
}

#[test]
fn meta_omits_none_session_id_and_warnings() {
    let meta = test_meta();
    let json = serde_json::to_value(&meta);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();
    assert!(val.get("sessionId").is_none());
    assert!(val.get("warnings").is_none());
}

// ── LafsError ────────────────────────────────────────────────────────

#[test]
fn error_serializes_camel_case_keys() {
    let err = LafsError {
        code: "E_RATE_LIMIT".to_string(),
        message: "Too many requests".to_string(),
        category: LafsErrorCategory::RateLimit,
        retryable: true,
        retry_after_ms: Some(5000),
        details: serde_json::json!({"limit": 100}),
        agent_action: Some(LafsAgentAction::Wait),
        escalation_required: Some(false),
        suggested_action: Some("Wait 5 seconds".to_string()),
        doc_url: Some("https://docs.example.com/rate-limit".to_string()),
    };
    let json = serde_json::to_value(&err);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();
    assert!(val.get("retryAfterMs").is_some());
    assert!(val.get("agentAction").is_some());
    assert!(val.get("escalationRequired").is_some());
    assert!(val.get("suggestedAction").is_some());
    assert!(val.get("docUrl").is_some());
    // snake_case keys must NOT be present
    assert!(val.get("retry_after_ms").is_none());
    assert!(val.get("agent_action").is_none());
    assert!(val.get("escalation_required").is_none());
    assert!(val.get("suggested_action").is_none());
    assert!(val.get("doc_url").is_none());
}

#[test]
fn error_omits_none_optional_fields() {
    let err = test_error();
    let json = serde_json::to_value(&err);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();
    assert!(val.get("retryAfterMs").is_none());
    assert!(val.get("escalationRequired").is_none());
    assert!(val.get("suggestedAction").is_none());
    assert!(val.get("docUrl").is_none());
}

// ── Pagination ───────────────────────────────────────────────────────

#[test]
fn page_cursor_serializes_with_mode_tag() {
    let page = LafsPage::Cursor(LafsPageCursor {
        next_cursor: Some("abc123".to_string()),
        has_more: true,
        limit: Some(20),
        total: Some(100),
    });
    let json = serde_json::to_value(&page);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();
    assert_eq!(val.get("mode").and_then(|v| v.as_str()), Some("cursor"));
    assert_eq!(
        val.get("nextCursor").and_then(|v| v.as_str()),
        Some("abc123")
    );
    assert_eq!(val.get("hasMore").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(val.get("limit").and_then(|v| v.as_u64()), Some(20));
    assert_eq!(val.get("total").and_then(|v| v.as_u64()), Some(100));
}

#[test]
fn page_offset_serializes_with_mode_tag() {
    let page = LafsPage::Offset(LafsPageOffset {
        limit: 50,
        offset: 100,
        has_more: false,
        total: Some(150),
    });
    let json = serde_json::to_value(&page);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();
    assert_eq!(val.get("mode").and_then(|v| v.as_str()), Some("offset"));
    assert_eq!(val.get("limit").and_then(|v| v.as_u64()), Some(50));
    assert_eq!(val.get("offset").and_then(|v| v.as_u64()), Some(100));
    assert_eq!(val.get("hasMore").and_then(|v| v.as_bool()), Some(false));
}

#[test]
fn page_none_serializes_with_mode_tag() {
    let page = LafsPage::None(LafsPageNone {});
    let json = serde_json::to_value(&page);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();
    assert_eq!(val.get("mode").and_then(|v| v.as_str()), Some("none"));
}

#[test]
fn page_cursor_deserializes_from_json() {
    let json_str = r#"{"mode":"cursor","nextCursor":"xyz","hasMore":true,"limit":10}"#;
    let page: Result<LafsPage, _> = serde_json::from_str(json_str);
    assert!(page.is_ok());
    match page.unwrap_or(LafsPage::None(LafsPageNone {})) {
        LafsPage::Cursor(c) => {
            assert_eq!(c.next_cursor.as_deref(), Some("xyz"));
            assert!(c.has_more);
            assert_eq!(c.limit, Some(10));
        }
        _ => panic!("Expected Cursor variant"),
    }
}

#[test]
fn page_offset_deserializes_from_json() {
    let json_str = r#"{"mode":"offset","limit":25,"offset":50,"hasMore":false}"#;
    let page: Result<LafsPage, _> = serde_json::from_str(json_str);
    assert!(page.is_ok());
    match page.unwrap_or(LafsPage::None(LafsPageNone {})) {
        LafsPage::Offset(o) => {
            assert_eq!(o.limit, 25);
            assert_eq!(o.offset, 50);
            assert!(!o.has_more);
            assert!(o.total.is_none());
        }
        _ => panic!("Expected Offset variant"),
    }
}

#[test]
fn page_none_deserializes_from_json() {
    let json_str = r#"{"mode":"none"}"#;
    let page: Result<LafsPage, _> = serde_json::from_str(json_str);
    assert!(page.is_ok());
    assert!(matches!(
        page.unwrap_or(LafsPage::Cursor(LafsPageCursor {
            next_cursor: None,
            has_more: false,
            limit: None,
            total: None,
        })),
        LafsPage::None(_)
    ));
}

// ── Envelope builders ────────────────────────────────────────────────

#[test]
fn success_envelope_has_correct_structure() {
    let meta = test_meta();
    let result = serde_json::json!({"tasks": [{"id": "T1"}]});
    let envelope = LafsEnvelope::success(result.clone(), meta);

    assert!(envelope.success);
    assert_eq!(envelope.result, Some(result));
    assert!(envelope.error.is_none());
    assert!(envelope.page.is_none());
    assert!(envelope.extensions.is_none());
    assert_eq!(
        envelope.schema,
        "https://lafs.dev/schemas/v1/envelope.schema.json"
    );
}

#[test]
fn error_envelope_has_correct_structure() {
    let meta = test_meta();
    let err = test_error();
    let envelope = LafsEnvelope::error(err, meta);

    assert!(!envelope.success);
    assert!(envelope.result.is_none());
    assert_eq!(
        envelope.error.as_ref().map(|e| e.code.as_str()),
        Some("E_NOT_FOUND")
    );
    assert_eq!(
        envelope.schema,
        "https://lafs.dev/schemas/v1/envelope.schema.json"
    );
}

// ── Full JSON round-trip ─────────────────────────────────────────────

#[test]
fn success_envelope_serializes_to_valid_json() {
    let meta = test_meta();
    let envelope = LafsEnvelope::success(serde_json::json!({"count": 42}), meta);
    let json = serde_json::to_value(&envelope);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();

    // Top-level keys
    assert_eq!(
        val.get("$schema").and_then(|v| v.as_str()),
        Some("https://lafs.dev/schemas/v1/envelope.schema.json")
    );
    assert_eq!(val.get("success").and_then(|v| v.as_bool()), Some(true));
    assert!(val.get("_meta").is_some());
    assert!(val.get("result").is_some());
    // error, page, _extensions should be absent (skip_serializing_if)
    assert!(val.get("error").is_none());
    assert!(val.get("page").is_none());
    assert!(val.get("_extensions").is_none());

    // Meta camelCase
    let meta_val = val.get("_meta");
    assert!(meta_val.is_some());
    let m = meta_val.unwrap_or(&serde_json::Value::Null);
    assert_eq!(
        m.get("specVersion").and_then(|v| v.as_str()),
        Some("1.2.3")
    );
    assert_eq!(m.get("transport").and_then(|v| v.as_str()), Some("cli"));
    assert_eq!(m.get("mvi").and_then(|v| v.as_str()), Some("standard"));
}

#[test]
fn error_envelope_serializes_to_valid_json() {
    let meta = test_meta();
    let err = LafsError {
        code: "E_VALIDATION".to_string(),
        message: "Invalid input".to_string(),
        category: LafsErrorCategory::Validation,
        retryable: false,
        retry_after_ms: None,
        details: serde_json::json!({"field": "name"}),
        agent_action: Some(LafsAgentAction::Stop),
        escalation_required: None,
        suggested_action: None,
        doc_url: None,
    };
    let envelope = LafsEnvelope::error(err, meta);
    let json = serde_json::to_value(&envelope);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();

    assert_eq!(val.get("success").and_then(|v| v.as_bool()), Some(false));
    assert!(val.get("result").is_none());

    let err_val = val.get("error");
    assert!(err_val.is_some());
    let e = err_val.unwrap_or(&serde_json::Value::Null);
    assert_eq!(
        e.get("code").and_then(|v| v.as_str()),
        Some("E_VALIDATION")
    );
    assert_eq!(
        e.get("category").and_then(|v| v.as_str()),
        Some("VALIDATION")
    );
    assert_eq!(e.get("agentAction").and_then(|v| v.as_str()), Some("stop"));
}

#[test]
fn success_envelope_deserializes_from_json_string() {
    let json_str = r#"{
        "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
        "_meta": {
            "specVersion": "1.2.3",
            "schemaVersion": "2026.2.1",
            "timestamp": "2026-03-24T12:00:00Z",
            "operation": "tasks.list",
            "requestId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "transport": "cli",
            "strict": true,
            "mvi": "standard",
            "contextVersion": 1
        },
        "success": true,
        "result": {"items": [1, 2, 3]}
    }"#;
    let envelope: Result<LafsEnvelope, _> = serde_json::from_str(json_str);
    assert!(envelope.is_ok());
    let env =
        envelope.unwrap_or_else(|_| LafsEnvelope::success(serde_json::Value::Null, test_meta()));
    assert!(env.success);
    assert_eq!(env.meta.operation, "tasks.list");
    assert_eq!(env.meta.transport, LafsTransport::Cli);
    assert_eq!(env.meta.mvi, MviLevel::Standard);
    assert_eq!(env.meta.context_version, 1);
    assert!(env.error.is_none());
}

#[test]
fn error_envelope_deserializes_from_json_string() {
    let json_str = r#"{
        "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
        "_meta": {
            "specVersion": "1.2.3",
            "schemaVersion": "2026.2.1",
            "timestamp": "2026-03-24T12:00:00Z",
            "operation": "tasks.delete",
            "requestId": "11111111-2222-3333-4444-555555555555",
            "transport": "http",
            "strict": false,
            "mvi": "full",
            "contextVersion": 3
        },
        "success": false,
        "error": {
            "code": "E_NOT_FOUND",
            "message": "Task T9999 not found",
            "category": "NOT_FOUND",
            "retryable": false,
            "details": {},
            "agentAction": "stop",
            "docUrl": "https://docs.example.com/errors/not-found"
        }
    }"#;
    let envelope: Result<LafsEnvelope, _> = serde_json::from_str(json_str);
    assert!(envelope.is_ok());
    let env =
        envelope.unwrap_or_else(|_| LafsEnvelope::success(serde_json::Value::Null, test_meta()));
    assert!(!env.success);
    assert!(env.result.is_none());
    let err = env.error.as_ref();
    assert!(err.is_some());
    let fallback = test_error();
    let e = err.unwrap_or(&fallback);
    assert_eq!(e.code, "E_NOT_FOUND");
    assert_eq!(e.category, LafsErrorCategory::NotFound);
    assert_eq!(e.agent_action, Some(LafsAgentAction::Stop));
    assert_eq!(
        e.doc_url.as_deref(),
        Some("https://docs.example.com/errors/not-found")
    );
}

#[test]
fn envelope_with_pagination_round_trips() {
    let meta = test_meta();
    let mut envelope = LafsEnvelope::success(serde_json::json!({"items": []}), meta);
    envelope.page = Some(LafsPage::Cursor(LafsPageCursor {
        next_cursor: Some("cursor-abc".to_string()),
        has_more: true,
        limit: Some(10),
        total: Some(42),
    }));

    let json_str = serde_json::to_string(&envelope);
    assert!(json_str.is_ok());
    let deserialized: Result<LafsEnvelope, _> =
        serde_json::from_str(json_str.as_ref().map_or("", String::as_str));
    assert!(deserialized.is_ok());
    let env2 =
        deserialized.unwrap_or_else(|_| LafsEnvelope::success(serde_json::Value::Null, test_meta()));
    assert!(matches!(env2.page, Some(LafsPage::Cursor(_))));
}

#[test]
fn envelope_with_extensions_round_trips() {
    let meta = test_meta();
    let mut envelope = LafsEnvelope::success(serde_json::json!({}), meta);
    envelope.extensions = Some(serde_json::json!({"custom": "data"}));

    let json = serde_json::to_value(&envelope);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();
    assert_eq!(
        val.get("_extensions")
            .and_then(|v| v.get("custom"))
            .and_then(|v| v.as_str()),
        Some("data")
    );
}

#[test]
fn envelope_with_warnings_round_trips() {
    let mut meta = test_meta();
    meta.warnings = Some(vec![Warning {
        code: "W_OLD_API".to_string(),
        message: "This API is deprecated".to_string(),
        deprecated: Some("v1/tasks".to_string()),
        replacement: Some("v2/tasks".to_string()),
        remove_by: Some("2027.1.0".to_string()),
    }]);
    let envelope = LafsEnvelope::success(serde_json::json!({}), meta);

    let json_str = serde_json::to_string(&envelope);
    assert!(json_str.is_ok());
    let deserialized: Result<LafsEnvelope, _> =
        serde_json::from_str(json_str.as_ref().map_or("", String::as_str));
    assert!(deserialized.is_ok());
    let env2 =
        deserialized.unwrap_or_else(|_| LafsEnvelope::success(serde_json::Value::Null, test_meta()));
    let warnings = env2.meta.warnings.as_ref();
    assert!(warnings.is_some());
    assert_eq!(warnings.map_or(0, Vec::len), 1);
    let fallback_vec = vec![];
    let w = &warnings.unwrap_or(&fallback_vec)[0];
    assert_eq!(w.remove_by.as_deref(), Some("2027.1.0"));
}

#[test]
fn meta_new_generates_unique_request_ids() {
    let m1 = LafsMeta::new("op1", LafsTransport::Cli);
    let m2 = LafsMeta::new("op2", LafsTransport::Cli);
    assert_ne!(m1.request_id, m2.request_id);
}

#[test]
fn envelope_with_session_id_serializes_correctly() {
    let mut meta = test_meta();
    meta.session_id = Some("sess-12345".to_string());
    let envelope = LafsEnvelope::success(serde_json::json!({}), meta);

    let json = serde_json::to_value(&envelope);
    assert!(json.is_ok());
    let val = json.unwrap_or_default();
    let meta_val = val.get("_meta");
    assert!(meta_val.is_some());
    assert_eq!(
        meta_val
            .and_then(|m| m.get("sessionId"))
            .and_then(|v| v.as_str()),
        Some("sess-12345")
    );
}
