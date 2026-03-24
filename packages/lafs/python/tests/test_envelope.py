"""Tests for LAFS envelope module."""

import pytest
import json
from datetime import datetime
from lafs.envelope import Envelope, EnvelopeValidator, LAFSValidationError


class TestEnvelope:
    """Test envelope creation and manipulation."""

    def test_basic_envelope_creation(self):
        envelope = Envelope(
            success=True,
            result={"data": "test"},
            meta={"operation": "test.op", "requestId": "req_001"},
        )

        assert envelope.success is True
        assert envelope.result == {"data": "test"}
        assert envelope.error is None

    def test_success_response(self):
        envelope = Envelope.success_response(
            result={"users": [{"id": "1"}]},
            operation="users.list",
            request_id="req_002",
            page={"mode": "cursor", "hasMore": False},
        )

        assert envelope.success is True
        assert envelope.result == {"users": [{"id": "1"}]}
        assert envelope.page == {"mode": "cursor", "hasMore": False}
        assert envelope.meta["operation"] == "users.list"
        assert envelope.meta["requestId"] == "req_002"
        assert "timestamp" in envelope.meta

    def test_error_response(self):
        envelope = Envelope.error_response(
            code="E_NOT_FOUND",
            message="Resource not found",
            operation="users.get",
            request_id="req_003",
            category="NOT_FOUND",
            retryable=False,
            details={"resourceId": "999"},
        )

        assert envelope.success is False
        assert envelope.result is None
        assert envelope.error["code"] == "E_NOT_FOUND"
        assert envelope.error["message"] == "Resource not found"
        assert envelope.error["category"] == "NOT_FOUND"
        assert envelope.error["retryable"] is False
        assert envelope.error["details"]["resourceId"] == "999"

    def test_to_dict(self):
        envelope = Envelope.success_response(
            result={"data": "test"}, operation="test.op", request_id="req_004"
        )

        data = envelope.to_dict()

        assert "$schema" in data
        assert "_meta" in data
        assert data["success"] is True
        assert "result" in data

    def test_to_json(self):
        envelope = Envelope.success_response(
            result={"data": "test"}, operation="test.op", request_id="req_005"
        )

        json_str = envelope.to_json()
        parsed = json.loads(json_str)

        assert parsed["success"] is True
        assert parsed["result"]["data"] == "test"

    def test_from_dict(self):
        data = {
            "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
            "_meta": {
                "specVersion": "1.0.0",
                "operation": "test.op",
                "requestId": "req_006",
            },
            "success": True,
            "result": {"data": "test"},
        }

        envelope = Envelope.from_dict(data)

        assert envelope.success is True
        assert envelope.result == {"data": "test"}
        assert envelope.meta["operation"] == "test.op"

    def test_from_json(self):
        json_str = json.dumps(
            {
                "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
                "_meta": {
                    "specVersion": "1.0.0",
                    "operation": "test.op",
                    "requestId": "req_007",
                },
                "success": True,
                "result": {"data": "test"},
            }
        )

        envelope = Envelope.from_json(json_str)

        assert envelope.success is True
        assert envelope.result == {"data": "test"}


class TestEnvelopeValidator:
    """Test envelope validation."""

    def test_valid_success_envelope(self):
        validator = EnvelopeValidator()
        envelope = Envelope.success_response(
            result={"data": "test"}, operation="test.op", request_id="req_008"
        )

        errors = validator.validate(envelope)

        assert len(errors) == 0
        assert validator.is_valid(envelope) is True

    def test_valid_error_envelope(self):
        validator = EnvelopeValidator()
        envelope = Envelope.error_response(
            code="E_NOT_FOUND",
            message="Not found",
            operation="test.op",
            request_id="req_009",
        )

        errors = validator.validate(envelope)

        assert len(errors) == 0
        assert validator.is_valid(envelope) is True

    def test_missing_required_fields(self):
        validator = EnvelopeValidator()
        data = {"success": True}

        errors = validator.validate(data)

        assert len(errors) > 0
        assert any("$schema" in e for e in errors)
        assert any("_meta" in e for e in errors)

    def test_invalid_error_code_format(self):
        validator = EnvelopeValidator()
        data = {
            "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
            "_meta": {
                "specVersion": "1.0.0",
                "schemaVersion": "1.0.0",
                "timestamp": "2026-01-01T00:00:00Z",
                "operation": "test.op",
                "requestId": "req_010",
            },
            "success": False,
            "error": {
                "code": "INVALID_CODE",  # Missing E_ prefix
                "message": "Error message",
            },
        }

        errors = validator.validate(data)

        assert any("error code format" in e.lower() for e in errors)

    def test_valid_error_code_format(self):
        validator = EnvelopeValidator()
        data = {
            "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
            "_meta": {
                "specVersion": "1.0.0",
                "schemaVersion": "1.0.0",
                "timestamp": "2026-01-01T00:00:00Z",
                "operation": "test.op",
                "requestId": "req_011",
            },
            "success": False,
            "error": {"code": "E_VALIDATION_SCHEMA", "message": "Invalid schema"},
        }

        errors = validator.validate(data)

        assert not any("error code format" in e.lower() for e in errors)

    def test_envelope_invariants_success(self):
        validator = EnvelopeValidator()
        # Success with error should fail
        data = {
            "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
            "_meta": {
                "specVersion": "1.0.0",
                "schemaVersion": "1.0.0",
                "timestamp": "2026-01-01T00:00:00Z",
                "operation": "test.op",
                "requestId": "req_012",
            },
            "success": True,
            "result": {"data": "test"},
            "error": {"code": "E_ERROR", "message": "Should not be here"},
        }

        errors = validator.validate(data)

        assert any("success=true implies error" in e.lower() for e in errors)

    def test_envelope_invariants_failure(self):
        validator = EnvelopeValidator()
        # Failure with result should fail
        data = {
            "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
            "_meta": {
                "specVersion": "1.0.0",
                "schemaVersion": "1.0.0",
                "timestamp": "2026-01-01T00:00:00Z",
                "operation": "test.op",
                "requestId": "req_013",
            },
            "success": False,
            "result": {"data": "should not be here"},
            "error": None,
        }

        errors = validator.validate(data)

        assert any("success=false implies result" in e.lower() for e in errors)

    def test_error_category_validation(self):
        validator = EnvelopeValidator()
        data = {
            "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
            "_meta": {
                "specVersion": "1.0.0",
                "schemaVersion": "1.0.0",
                "timestamp": "2026-01-01T00:00:00Z",
                "operation": "test.op",
                "requestId": "req_014",
            },
            "success": False,
            "error": {
                "code": "E_INVALID_CATEGORY",
                "message": "Error",
                "category": "INVALID_CATEGORY",
            },
        }

        errors = validator.validate(data)

        assert any("Invalid error category" in e for e in errors)

    def test_validate_strict_raises(self):
        validator = EnvelopeValidator()
        data = {"success": True}  # Invalid - missing required fields

        with pytest.raises(LAFSValidationError) as exc_info:
            validator.validate_strict(data)

        assert exc_info.value.code == "E_VALIDATION_SCHEMA"
        assert "Missing" in str(exc_info.value)


class TestEnvelopeRoundTrip:
    """Test envelope serialization round-trips."""

    def test_success_round_trip(self):
        original = Envelope.success_response(
            result={"users": [{"id": "1", "name": "Alice"}]},
            operation="users.list",
            request_id="req_roundtrip_1",
            page={"mode": "cursor", "hasMore": True},
        )

        json_str = original.to_json()
        restored = Envelope.from_json(json_str)

        assert restored.success == original.success
        assert restored.result == original.result
        assert restored.page == original.page

    def test_error_round_trip(self):
        original = Envelope.error_response(
            code="E_NOT_FOUND_RESOURCE",
            message="User not found",
            operation="users.get",
            request_id="req_roundtrip_2",
            category="NOT_FOUND",
            details={"userId": "999"},
        )

        json_str = original.to_json()
        restored = Envelope.from_json(json_str)

        assert restored.success == original.success
        assert restored.error == original.error


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
