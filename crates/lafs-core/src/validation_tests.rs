use super::*;

/// Valid envelope JSON matching the TypeScript `structuredValidation.test.ts` fixture.
fn valid_envelope_json() -> String {
    serde_json::json!({
        "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
        "_meta": {
            "specVersion": "1.0.0",
            "schemaVersion": "1.0.0",
            "timestamp": "2026-03-15T00:00:00Z",
            "operation": "test.list",
            "requestId": "req_structured_01",
            "transport": "cli",
            "strict": true,
            "mvi": "minimal",
            "contextVersion": 0
        },
        "success": true,
        "result": { "items": [] }
    })
    .to_string()
}

#[test]
fn validate_valid_envelope_returns_ok() {
    let result = validate_envelope_json(&valid_envelope_json());
    assert!(result.is_ok(), "Valid envelope should pass validation");
}

#[test]
fn validate_invalid_json_returns_error() {
    let result = validate_envelope_json("not json");
    assert!(matches!(result, Err(ValidateEnvelopeError::InvalidJson(_))));
}

#[test]
fn validate_pattern_violation_returns_pattern_keyword() {
    let json = serde_json::json!({
        "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
        "_meta": {
            "specVersion": "not-a-semver",
            "schemaVersion": "1.0.0",
            "timestamp": "2026-03-15T00:00:00Z",
            "operation": "test.list",
            "requestId": "req_01",
            "transport": "cli",
            "strict": true,
            "mvi": "minimal",
            "contextVersion": 0
        },
        "success": true,
        "result": {}
    })
    .to_string();

    let result = validate_envelope_json(&json);
    let errors = match result {
        Err(ValidateEnvelopeError::SchemaErrors(e)) => e,
        other => panic!("Expected SchemaErrors, got {other:?}"),
    };

    let pattern_error = errors.iter().find(|e| e.keyword == "pattern");
    assert!(pattern_error.is_some(), "Should have a pattern error");
    #[allow(clippy::unwrap_used)]
    let pe = pattern_error.unwrap();
    assert!(
        pe.path.contains("specVersion"),
        "Path should reference specVersion"
    );
    assert!(
        pe.params.get("pattern").is_some(),
        "Params should include pattern field"
    );
}

#[test]
fn validate_missing_required_field_returns_required_keyword() {
    let json = serde_json::json!({
        "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
        "_meta": {
            "specVersion": "1.0.0",
            "schemaVersion": "1.0.0",
            "timestamp": "2026-03-15T00:00:00Z",
            "operation": "test.list",
            "requestId": "req_01",
            "transport": "cli",
            "strict": true,
            "mvi": "minimal",
            "contextVersion": 0
        },
        "success": true
        // missing "result"
    })
    .to_string();

    let result = validate_envelope_json(&json);
    let errors = match result {
        Err(ValidateEnvelopeError::SchemaErrors(e)) => e,
        other => panic!("Expected SchemaErrors, got {other:?}"),
    };

    let required_error = errors.iter().find(|e| e.keyword == "required");
    assert!(required_error.is_some(), "Should have a required error");
}

#[test]
fn validate_enum_violation_returns_enum_keyword() {
    let json = serde_json::json!({
        "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
        "_meta": {
            "specVersion": "1.0.0",
            "schemaVersion": "1.0.0",
            "timestamp": "2026-03-15T00:00:00Z",
            "operation": "test.list",
            "requestId": "req_01",
            "transport": "websocket",
            "strict": true,
            "mvi": "minimal",
            "contextVersion": 0
        },
        "success": true,
        "result": {}
    })
    .to_string();

    let result = validate_envelope_json(&json);
    let errors = match result {
        Err(ValidateEnvelopeError::SchemaErrors(e)) => e,
        other => panic!("Expected SchemaErrors, got {other:?}"),
    };

    let enum_error = errors.iter().find(|e| e.keyword == "enum");
    assert!(enum_error.is_some(), "Should have an enum error");
}

#[test]
fn validate_multiple_errors_returns_all() {
    let json = serde_json::json!({
        "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
        "_meta": {
            "specVersion": "bad",
            "schemaVersion": "bad",
            "timestamp": "not-a-date",
            "operation": "",
            "requestId": "ab",
            "transport": "invalid_transport",
            "strict": true,
            "mvi": "minimal",
            "contextVersion": 0
        },
        "success": true,
        "result": { "items": [] }
    })
    .to_string();

    let result = validate_envelope_json(&json);
    let errors = match result {
        Err(ValidateEnvelopeError::SchemaErrors(e)) => e,
        other => panic!("Expected SchemaErrors, got {other:?}"),
    };

    // Multiple violations: 2 patterns, 1 format, 1 minLength, 1 enum, 1 minLength
    assert!(
        errors.len() >= 4,
        "Should have multiple errors, got {}",
        errors.len()
    );

    // Each error should have all required fields
    for error in &errors {
        assert!(!error.path.is_empty(), "Path should not be empty");
        assert!(!error.keyword.is_empty(), "Keyword should not be empty");
        assert!(!error.message.is_empty(), "Message should not be empty");
    }
}

#[test]
fn validate_error_display_format() {
    let json = serde_json::json!({
        "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
        "success": true
    })
    .to_string();

    let result = validate_envelope_json(&json);
    #[allow(clippy::unwrap_used)]
    let err = result.unwrap_err();
    let display = format!("{err}");
    assert!(
        display.contains("Schema validation failed"),
        "Display should contain summary"
    );
}
