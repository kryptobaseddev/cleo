# Testing Protocol

**Provenance**: @task T3155, @epic T3147
**Version**: 1.0.1
**Type**: Conditional Protocol
**Stage**: IVTR - T (Testing)
**Max Active**: 3 protocols (including base)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Test Creation | "test", "write tests", "add tests" | New test development |
| Test Execution | "run tests", "execute tests", "bats" | Test running |
| Coverage | "coverage", "test coverage" | Coverage improvement |
| Test Fixes | "fix test", "flaky", "failing test" | Test maintenance |

**Explicit Override**: `--protocol testing` flag on task creation.

**Lifecycle Position**: After Validation (V), before Release (R)

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| TEST-001 | MUST write tests using BATS framework for Bash |
| TEST-002 | MUST place unit tests in `tests/unit/` |
| TEST-003 | MUST place integration tests in `tests/integration/` |
| TEST-004 | MUST achieve 100% pass rate before release |
| TEST-005 | MUST test all MUST requirements from specifications |
| TEST-006 | MUST write test summary to manifest |
| TEST-007 | MUST set `agent_type: "testing"` in manifest |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| TEST-010 | SHOULD test edge cases and error paths |
| TEST-011 | SHOULD include setup/teardown fixtures |
| TEST-012 | SHOULD use descriptive test names |
| TEST-013 | SHOULD document test rationale |

### MAY

| Requirement | Description |
|-------------|-------------|
| TEST-020 | MAY add golden tests for output verification |
| TEST-021 | MAY add performance benchmarks |
| TEST-022 | MAY add stress tests for concurrency |

---

## Test Structure

### Directory Layout

```
tests/
├── unit/                    # Unit tests (isolated functions)
│   ├── protocol-validation.bats
│   ├── changelog-association.bats
│   └── lifecycle-enforcement.bats
├── integration/             # Integration tests (workflows)
│   ├── release-ship.bats
│   ├── commit-hook.bats
│   └── backfill-releases.bats
├── golden/                  # Golden output tests
│   └── output-format.bats
├── fixtures/                # Test data
│   ├── sample-todo.json
│   └── test-manifest.jsonl
└── test_helper/             # BATS helpers
    ├── bats-support/
    └── bats-assert/
```

### BATS Test Template

```bash
#!/usr/bin/env bats

load '../test_helper/bats-support/load'
load '../test_helper/bats-assert/load'

# =============================================================================
# Test: feature-name.bats
# Task: T####
# Protocol: testing
# =============================================================================

setup() {
    # Load functions to test
    source "$BATS_TEST_DIRNAME/../../lib/feature.sh"

    # Create test fixtures
    export TEST_DIR=$(mktemp -d)
}

teardown() {
    # Cleanup
    rm -rf "$TEST_DIR"
}

@test "function_name should handle normal input" {
    run function_name "normal input"
    assert_success
    assert_output --partial "expected"
}

@test "function_name should reject invalid input" {
    run function_name ""
    assert_failure
    assert_output --partial "error"
}

@test "function_name should handle edge case" {
    run function_name "edge case"
    assert_success
}
```

---

## Test Categories

### Unit Tests

Test isolated functions without external dependencies.

```bash
@test "validate_research_protocol returns 0 for valid research" {
    run validate_research_protocol "T2680"
    assert_success
}
```

### Integration Tests

Test workflows involving multiple components.

```bash
@test "release ship should populate tasks and generate changelog" {
    run cleo release create v0.99.0
    run cleo release ship v0.99.0 --dry-run
    assert_success
    assert_output --partial "tasks populated"
}
```

### Golden Tests

Verify output format hasn't changed unexpectedly.

```bash
@test "cleo list output matches golden format" {
    run cleo list --json
    assert_success
    diff <(echo "$output" | jq -S .) tests/golden/list-output.json
}
```

---

## Running Tests

### All Tests

```bash
./tests/run-all-tests.sh
```

### Specific Suite

```bash
# Unit tests only
bats tests/unit/*.bats

# Integration tests only
bats tests/integration/*.bats

# Single file
bats tests/unit/protocol-validation.bats
```

### With Coverage

```bash
# Run with TAP output for CI
bats --tap tests/unit/*.bats > test-results.tap
```

---

## Output Format

### Test Summary

```markdown
# Test Report: T####

**Date**: YYYY-MM-DD
**Tester**: agent-id
**Task**: T####

## Summary

- **Total Tests**: N
- **Passed**: X
- **Failed**: Y
- **Skipped**: Z
- **Pass Rate**: X%

## Test Files Created

| File | Tests | Status |
|------|-------|--------|
| tests/unit/feature.bats | 20 | PASS |
| tests/integration/workflow.bats | 14 | PASS |

## Coverage

| Requirement | Tests | Covered |
|-------------|-------|---------|
| IMPL-001 | 3 | Yes |
| IMPL-002 | 2 | Yes |
```

### Manifest Entry

@skills/_shared/manifest-operations.md

Use `cleo research add` to create the manifest entry:

```bash
cleo research add \
  --title "Testing: [Feature Name]" \
  --file "T####-test-report.md" \
  --topics "testing,bats,quality" \
  --findings "TESTS: N written,RESULT: X/Y passed,COVERAGE: Z requirements" \
  --status complete \
  --task T#### \
  --not-actionable \
  --agent-type testing
```

---

## Integration Points

### With Validation Protocol

```
Validation (V) ──► Testing (T)
       │                │
       │ Identifies     │ Writes tests for:
       │ gaps           │ - Uncovered paths
       │                │ - Edge cases
       │                │ - Error handling
```

### With Release Protocol

```
Testing (T) ──► Release (R)
       │              │
       │ Gates:       │ Requires:
       │ - 100% pass  │ - All tests pass
       │ - Coverage   │ - No skipped tests
```

---

## Exit Codes

| Code | Constant | Description |
|------|----------|-------------|
| 0 | SUCCESS | All tests pass |
| 1 | TEST_FAILURE | One or more tests failed |
| 69 | EXIT_TESTS_SKIPPED | Tests were skipped |
| 70 | EXIT_COVERAGE_INSUFFICIENT | Coverage below threshold |

---

## Best Practices

### Test Naming

```bash
# Good: Describes behavior
@test "populate_release_tasks should discover tasks in date window"

# Bad: Too vague
@test "test populate function"
```

### Fixtures

```bash
# Use fixtures for complex test data
setup() {
    cp tests/fixtures/sample-todo.json "$TEST_DIR/todo.json"
}
```

### Isolation

```bash
# Each test should be independent
setup() {
    export TEST_DIR=$(mktemp -d)
    export TODO_FILE="$TEST_DIR/todo.json"
}

teardown() {
    rm -rf "$TEST_DIR"
}
```

---

## Cross-Cutting: Contribution Protocol

When testing involves multi-agent work:

1. **Record tester identity** in manifest
2. **Attribute test authorship** via comments
3. **Track test consensus** if multiple testers

See: `protocols/contribution.md` for attribution requirements.

---

## References

- **Test Framework**: [BATS](https://github.com/bats-core/bats-core)
- **Existing Tests**: `tests/unit/`, `tests/integration/`
- **Test Helpers**: `tests/test_helper/bats-support/`, `tests/test_helper/bats-assert/`
- **Specification**: `docs/specs/PROTOCOL-ENFORCEMENT-SPEC.md`
