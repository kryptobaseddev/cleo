"""Tests for LAFS budget enforcement."""

import pytest
import json
from lafs.budget import TokenEstimator, BudgetEnforcer, LAFSBudgetExceeded
from lafs.envelope import Envelope


class TestTokenEstimator:
    """Test token estimation algorithm."""

    def test_null_value(self):
        estimator = TokenEstimator()
        assert estimator.estimate(None) == 1

    def test_boolean_values(self):
        estimator = TokenEstimator()
        assert estimator.estimate(True) == 1
        assert estimator.estimate(False) == 1

    def test_numeric_values(self):
        estimator = TokenEstimator()
        # Small numbers
        assert estimator.estimate(0) == 1
        assert estimator.estimate(42) == 1
        # Larger numbers (1 token per 4 digits)
        assert estimator.estimate(1234) == 1
        assert estimator.estimate(12345) == 2
        assert estimator.estimate(123456789) == 3

    def test_string_values(self):
        estimator = TokenEstimator()
        # Empty string still costs 1 token
        assert estimator.estimate("") == 1
        # Short string (4 chars = 1 token at ratio 4.0)
        assert estimator.estimate("test") == 1
        # Longer string
        assert estimator.estimate("hello world") == 2  # 11/4 = 2.75 -> int() = 2

    def test_unicode_strings(self):
        estimator = TokenEstimator()
        # Emoji should count as 1 grapheme
        assert estimator.estimate("🎉") == 1
        # CJK characters
        assert estimator.estimate("中文") == 1  # 2/4 = 0.5 -> 1

    def test_array_values(self):
        estimator = TokenEstimator()
        # Empty array
        assert estimator.estimate([]) == 2
        # Array with items
        assert estimator.estimate([1, 2, 3]) == 7  # [] + 3*1 + 2 commas = 2+3+2

    def test_object_values(self):
        estimator = TokenEstimator()
        # Empty object
        assert estimator.estimate({}) == 2
        # Simple object
        obj = {"name": "test"}
        # {} + key(1) + :,(2) + value(1) = 2 + 1 + 2 + 1 = 6
        assert estimator.estimate(obj) == 6

    def test_nested_objects(self):
        estimator = TokenEstimator()
        obj = {"user": {"name": "Alice", "age": 30}}
        result = estimator.estimate(obj)
        assert result > 0

    def test_circular_reference(self):
        estimator = TokenEstimator()
        a = {"name": "test"}
        a["self"] = a  # Circular reference
        # Should handle gracefully
        result = estimator.estimate(a)
        assert result > 0

    def test_max_depth_protection(self):
        estimator = TokenEstimator(max_depth=5)
        # Create deeply nested structure
        data = {"level": 0}
        for i in range(1, 10):
            data = {"level": i, "nested": data}
        # Should hit max depth and return infinity
        result = estimator.estimate(data)
        assert result == float("inf") or result > 1000000

    def test_estimate_json(self):
        estimator = TokenEstimator()
        json_str = '{"name": "test", "value": 123}'
        result = estimator.estimate_json(json_str)
        assert result > 0

    def test_estimate_json_invalid(self):
        estimator = TokenEstimator()
        with pytest.raises(ValueError, match="Invalid JSON"):
            estimator.estimate_json("not valid json")


class TestBudgetEnforcer:
    """Test budget enforcement."""

    def test_within_budget(self):
        enforcer = BudgetEnforcer(budget=100)
        envelope = {"result": {"data": "test"}}

        result = enforcer.enforce(envelope)

        assert result["result"] == {"data": "test"}
        assert "_tokenEstimate" in result.get("_meta", {})

    def test_exceeds_budget_raises(self):
        enforcer = BudgetEnforcer(budget=1)
        # Large result that definitely exceeds 1 token
        envelope = {"result": {"data": "x" * 1000}}

        with pytest.raises(LAFSBudgetExceeded) as exc_info:
            enforcer.enforce(envelope)

        assert exc_info.value.budget == 1
        assert exc_info.value.estimated_tokens > 1
        assert exc_info.value.constraint == "maxTokens"
        error_dict = exc_info.value.to_error_dict()
        assert error_dict["code"] == "E_MVI_BUDGET_EXCEEDED"

    def test_max_items_truncation(self):
        enforcer = BudgetEnforcer(budget=1000, max_items=3)
        envelope = {"result": [1, 2, 3, 4, 5], "_meta": {}}

        result = enforcer.enforce(envelope)

        assert len(result["result"]) == 3
        assert any(
            w.get("code") == "E_MVI_BUDGET_TRUNCATED"
            for w in result.get("_meta", {}).get("warnings", [])
        )

    def test_max_bytes_exceeded(self):
        enforcer = BudgetEnforcer(budget=1000, max_bytes=10)
        envelope = {"result": {"data": "this is way more than 10 bytes"}}

        with pytest.raises(LAFSBudgetExceeded) as exc_info:
            enforcer.enforce(envelope)

        assert exc_info.value.constraint == "maxBytes"

    def test_truncate_list(self):
        enforcer = BudgetEnforcer(budget=10)  # Very small budget
        envelope = {
            "result": [
                {
                    "id": "1",
                    "name": "Item 1",
                    "description": "A very long description here",
                },
                {
                    "id": "2",
                    "name": "Item 2",
                    "description": "Another long description",
                },
                {"id": "3", "name": "Item 3", "description": "Yet another description"},
            ]
        }

        # Should truncate to fit budget
        result = enforcer.enforce(envelope)

        # Result should be within budget
        estimator = TokenEstimator()
        final_estimate = estimator.estimate(result["result"])
        assert final_estimate <= 10

    def test_truncate_dict(self):
        enforcer = BudgetEnforcer(budget=15)
        envelope = {
            "result": {
                "id": "123",
                "name": "Test",
                "description": "This is a very long description that should be removed",
                "metadata": {"extra": "data"},
            }
        }

        result = enforcer.enforce(envelope)

        # Should keep essential fields
        assert "id" in result["result"] or "name" in result["result"]
        estimator = TokenEstimator()
        assert estimator.estimate(result["result"]) <= 15

    def test_check_budget(self):
        enforcer = BudgetEnforcer(budget=100)

        within_budget, estimated = enforcer.check_budget({"data": "test"})
        assert within_budget is True
        assert estimated > 0

        # Large data
        within_budget, estimated = enforcer.check_budget({"data": "x" * 10000})
        assert within_budget is False
        assert estimated > 100

    def test_budget_exceeded_error_format(self):
        error = LAFSBudgetExceeded(
            message="Budget exceeded", estimated_tokens=150, budget=100
        )

        error_dict = error.to_error_dict()

        assert error_dict["code"] == "E_MVI_BUDGET_EXCEEDED"
        assert error_dict["category"] == "VALIDATION"
        assert error_dict["retryable"] is True
        assert error_dict["details"]["estimatedTokens"] == 150
        assert error_dict["details"]["budget"] == 100
        assert error_dict["details"]["excessTokens"] == 50
        assert "suggestion" in error_dict["details"]


class TestBudgetWithEnvelope:
    """Test budget enforcement with full envelopes."""

    def test_envelope_success_response(self):
        envelope = Envelope.success_response(
            result={"users": [{"id": "1", "name": "Alice"}]},
            operation="users.list",
            request_id="req_001",
        )

        enforcer = BudgetEnforcer(budget=100)
        result = enforcer.enforce(envelope.to_dict())

        assert result["success"] is True
        assert "_tokenEstimate" in result["_meta"]

    def test_envelope_error_response(self):
        envelope = Envelope.error_response(
            code="E_NOT_FOUND",
            message="Resource not found",
            operation="users.get",
            request_id="req_002",
            category="NOT_FOUND",
        )

        enforcer = BudgetEnforcer(budget=100)
        # Error responses should still be processed
        result = enforcer.enforce(envelope.to_dict())

        assert result["success"] is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
