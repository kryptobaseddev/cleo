"""Example: Basic LAFS SDK Usage

This example demonstrates how to use the LAFS Python SDK to:
1. Create a client and discover capabilities
2. Make API calls with budgets
3. Handle errors
4. Work with envelopes

This example uses a mock server for demonstration. In production,
replace the base_url with your actual LAFS-compliant API endpoint.
"""

import json
import sys
from lafs import (
    LAFSClient,
    Envelope,
    EnvelopeValidator,
    TokenEstimator,
    BudgetEnforcer,
    LAFSBudgetExceeded,
    LAFSError,
    LAFSConnectionError,
)


def print_section(title: str):
    """Print a formatted section header."""
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}\n")


def example_1_token_estimation():
    """Example 1: Token Estimation"""
    print_section("Example 1: Token Estimation")

    estimator = TokenEstimator()

    # Estimate tokens for various values
    test_values = [
        ("Simple string", "Hello, LAFS!"),
        ("Number", 42),
        ("Small array", [1, 2, 3]),
        ("Small object", {"name": "test", "value": 123}),
        ("Nested object", {"user": {"name": "Alice", "age": 30}}),
    ]

    for name, value in test_values:
        tokens = estimator.estimate(value)
        print(f"{name}: {tokens} tokens")

    # Estimate from JSON string
    json_data = '{"operation": "tasks.list", "limit": 10}'
    tokens = estimator.estimate_json(json_data)
    print(f"\nJSON string: {tokens} tokens")


def example_2_envelope_creation():
    """Example 2: Creating LAFS Envelopes"""
    print_section("Example 2: Creating LAFS Envelopes")

    # Create a success envelope
    success_envelope = Envelope.success_response(
        result={"users": [{"id": "1", "name": "Alice"}, {"id": "2", "name": "Bob"}]},
        operation="users.list",
        request_id="req_001",
        page={"mode": "cursor", "nextCursor": "abc123", "hasMore": True},
    )

    print("Success Envelope:")
    print(json.dumps(success_envelope.to_dict(), indent=2))

    # Create an error envelope
    error_envelope = Envelope.error_response(
        code="E_NOT_FOUND_RESOURCE",
        message="User with ID '999' not found",
        operation="users.get",
        request_id="req_002",
        category="NOT_FOUND",
        retryable=False,
        details={"resourceId": "999", "resourceType": "user"},
    )

    print("\n\nError Envelope:")
    print(json.dumps(error_envelope.to_dict(), indent=2))


def example_3_envelope_validation():
    """Example 3: Envelope Validation"""
    print_section("Example 3: Envelope Validation")

    validator = EnvelopeValidator()

    # Valid envelope
    valid_envelope = Envelope.success_response(
        result={"data": "test"}, operation="test.op", request_id="req_003"
    )

    errors = validator.validate(valid_envelope)
    print(f"Valid envelope errors: {errors}")
    print(f"Is valid: {validator.is_valid(valid_envelope)}")

    # Invalid envelope (missing required fields)
    invalid_envelope = {
        "success": True
        # Missing _meta, $schema, etc.
    }

    errors = validator.validate(invalid_envelope)
    print(f"\nInvalid envelope errors:")
    for error in errors:
        print(f"  - {error}")


def example_4_budget_enforcement():
    """Example 4: Budget Enforcement"""
    print_section("Example 4: Budget Enforcement")

    # Create budget enforcer with 50 token limit
    enforcer = BudgetEnforcer(budget=50)

    # Small data (within budget)
    small_data = {"result": {"id": "1", "name": "Test"}}

    try:
        result = enforcer.enforce(small_data)
        print("Small data: Within budget ✓")
        print(f"  Estimated tokens: {result['_meta']['_tokenEstimate']['estimated']}")
    except LAFSBudgetExceeded as e:
        print(f"Small data: Budget exceeded: {e}")

    # Large data (exceeds budget)
    large_data = {
        "result": {
            "items": [
                {
                    "id": str(i),
                    "name": f"Item {i}",
                    "description": f"This is a long description for item {i}",
                }
                for i in range(100)
            ]
        }
    }

    try:
        result = enforcer.enforce(large_data)
        print("\nLarge data: Within budget ✓")
        print(f"  Estimated tokens: {result['_meta']['_tokenEstimate']['estimated']}")
    except LAFSBudgetExceeded as e:
        print(f"\nLarge data: Budget exceeded ✓")
        print(f"  Budget: {e.budget} tokens")
        print(f"  Estimated: {e.estimated_tokens} tokens")
        print(f"  Excess: {e.excess_tokens} tokens")


def example_5_budget_with_max_items():
    """Example 5: Budget with Max Items"""
    print_section("Example 5: Budget with Max Items")

    # Enforce max 5 items
    enforcer = BudgetEnforcer(budget=1000, max_items=5)

    data = {
        "result": [{"id": str(i), "name": f"Item {i}"} for i in range(20)],
        "_meta": {},
    }

    result = enforcer.enforce(data)

    print(f"Original items: 20")
    print(f"After enforcement: {len(result['result'])} items")

    if "warnings" in result.get("_meta", {}):
        for warning in result["_meta"]["warnings"]:
            print(f"\nWarning: {warning['message']}")


def example_6_client_discovery():
    """Example 6: Client and Discovery (Simulation)"""
    print_section("Example 6: Client and Discovery (Simulated)")

    # Create client
    # Note: This would connect to a real LAFS service in production
    client = LAFSClient(base_url="https://api.example.com", api_key="your-api-key-here")

    print("LAFS Client created successfully")
    print(f"  Base URL: {client.base_url}")
    print(f"  Timeout: {client.timeout}s")

    # In production, you would call:
    # discovery = client.discover()
    # print(f"Service: {discovery.service['name']}")
    # print(f"Supports budgets: {discovery.supports_budget()}")

    print("\nNote: Discovery requires a running LAFS server.")
    print("      See the full documentation for server setup.")


def example_7_error_handling():
    """Example 7: Error Handling"""
    print_section("Example 7: Error Handling")

    # Simulate different error scenarios

    # 1. Budget exceeded error
    try:
        enforcer = BudgetEnforcer(budget=10)
        large_data = {"result": {"data": "x" * 1000}}
        enforcer.enforce(large_data)
    except LAFSBudgetExceeded as e:
        print("1. Budget Exceeded Error:")
        print(f"   Code: {e.to_error_dict()['code']}")
        print(f"   Message: {e}")
        print(f"   Retryable: {e.to_error_dict()['retryable']}")

    # 2. Connection error (would happen in real client)
    print("\n2. Connection errors are raised as LAFSConnectionError")
    print("   - Network failures")
    print("   - Timeout errors")
    print("   - DNS resolution failures")

    # 3. API errors
    print("\n3. API errors are raised as LAFSError")
    print("   - Invalid operations")
    print("   - Authentication failures")
    print("   - Server errors")


def example_8_complete_workflow():
    """Example 8: Complete Workflow"""
    print_section("Example 8: Complete Workflow")

    print("This example shows a complete agent workflow:")
    print()

    # Step 1: Create estimator and enforcer
    estimator = TokenEstimator()
    enforcer = BudgetEnforcer(budget=200, max_items=10)
    validator = EnvelopeValidator()

    # Step 2: Prepare request data
    request_data = {
        "users": [
            {"id": str(i), "name": f"User {i}", "email": f"user{i}@example.com"}
            for i in range(50)
        ]
    }

    # Step 3: Check if data is within budget
    within_budget, estimated = enforcer.check_budget(request_data)
    print(f"Step 1: Check budget")
    print(f"  Within budget: {within_budget}")
    print(f"  Estimated tokens: {estimated}")
    print(f"  Budget: {enforcer.budget}")

    # Step 4: Create envelope
    envelope = Envelope.success_response(
        result=request_data, operation="users.list", request_id="req_123"
    )

    print(f"\nStep 2: Create envelope")
    print(f"  Operation: {envelope.meta['operation']}")
    print(f"  Request ID: {envelope.meta['requestId']}")

    # Step 5: Enforce budget
    try:
        enforced = enforcer.enforce(envelope.to_dict())
        print(f"\nStep 3: Enforce budget")
        result = enforced.get("result", {})
        if "users" in result:
            print(f"  Success: Users returned = {len(result['users'])}")
        elif "items" in result:
            print(f"  Success: Items returned = {len(result['items'])}")
        else:
            print(f"  Success: Result keys = {list(result.keys())}")
        print(
            f"  Final token estimate: {enforced['_meta']['_tokenEstimate']['estimated']}"
        )

        if "warnings" in enforced.get("_meta", {}):
            print(f"  Warnings: {len(enforced['_meta']['warnings'])}")
            for w in enforced["_meta"]["warnings"]:
                print(f"    - {w['code']}: {w['message']}")

        # Step 6: Validate response
        print(f"\nStep 4: Validate envelope")
        is_valid = validator.is_valid(enforced)
        print(f"  Valid: {is_valid}")

        print(f"\n✓ Workflow completed successfully!")

    except LAFSBudgetExceeded as e:
        print(f"\n✗ Budget exceeded: {e}")


def main():
    """Run all examples."""
    print("=" * 60)
    print("  LAFS Python SDK - Usage Examples")
    print("=" * 60)

    examples = [
        example_1_token_estimation,
        example_2_envelope_creation,
        example_3_envelope_validation,
        example_4_budget_enforcement,
        example_5_budget_with_max_items,
        example_6_client_discovery,
        example_7_error_handling,
        example_8_complete_workflow,
    ]

    try:
        for example in examples:
            example()

        print("\n" + "=" * 60)
        print("  All examples completed successfully!")
        print("=" * 60)
        return 0

    except Exception as e:
        print(f"\n✗ Error running examples: {e}")
        import traceback

        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
