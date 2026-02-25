---
name: ct-test-writer-bats
description: BATS (Bash Automated Testing System) test creation for comprehensive integration and unit testing. Creates idempotent tests with happy path, error handling, and edge case coverage. Includes fixture creation and JSON output validation. Use when writing tests, creating test suites, adding test coverage, or validating bash implementations. Triggers on test writing tasks, test coverage needs, or BATS test creation.
version: 2.0.0
tier: 2
core: false
category: specialist
protocol: testing
dependencies: []
sharedResources:
  - subagent-protocol-base
  - task-system-integration
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# Test Writer (BATS) Context Injection

**Protocol**: @protocols/implementation.md
**Type**: Context Injection (cleo-subagent)
**Version**: 2.0.0

---

## Purpose

Context injection for test writing tasks spawned via cleo-subagent. Provides domain expertise for creating comprehensive integration and unit tests using the BATS (Bash Automated Testing System) framework.

---

## Capabilities

1. **Integration Tests** - Test command workflows end-to-end
2. **Unit Tests** - Test individual functions
3. **Fixture Creation** - Create test data and mocks
4. **Error Case Testing** - Verify error handling

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Execution Sequence

1. Read task: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. Start task: `{{TASK_START_CMD}} {{TASK_ID}}` (if not already started by orchestrator)
3. Create test file(s) in appropriate tests/ subdirectory
4. Run tests and verify they pass
5. Write output file and append manifest
6. Complete task: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
7. Return summary message

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST create test file in appropriate tests/ subdirectory
2. MUST run tests and verify they pass
3. MUST append ONE line to: `{{MANIFEST_PATH}}`
4. MUST return ONLY: "Tests complete. See MANIFEST.jsonl for summary."
5. MUST NOT return full test content in response

---

## BATS Test Structure

### Directory Layout

```
tests/
├── integration/          # End-to-end workflow tests
│   └── {feature}.bats
├── unit/                 # Individual function tests
│   └── {module}.bats
├── fixtures/             # Test data
│   └── {feature}/
├── test_helper/          # BATS support libraries
│   ├── bats-support/
│   └── bats-assert/
└── run-all-tests.sh      # Test runner
```

### Basic Test File

```bash
#!/usr/bin/env bats

# Load test helpers
load '../test_helper/bats-support/load'
load '../test_helper/bats-assert/load'

# Setup runs before each test
setup() {
  export TEST_DIR=$(mktemp -d)
  cd "$TEST_DIR"
  # Initialize test environment
}

# Teardown runs after each test
teardown() {
  cd /
  rm -rf "$TEST_DIR"
}

@test "descriptive test name that explains what is tested" {
  # Arrange
  # ... setup test conditions

  # Act
  run command_under_test

  # Assert
  assert_success
  assert_output --partial "expected output"
}

@test "error case: handles missing input gracefully" {
  run command_under_test --missing-required-arg
  assert_failure
  assert_output --partial "error"
}
```

---

## BATS Assertions

### Status Assertions

```bash
assert_success              # Exit code 0
assert_failure              # Exit code non-zero
assert_equal "$actual" "$expected"
```

### Output Assertions

```bash
assert_output "exact match"
assert_output --partial "substring"
assert_output --regexp "pattern.*match"
refute_output --partial "should not contain"
```

### File Assertions

```bash
assert [ -f "$file" ]       # File exists
assert [ -d "$dir" ]        # Directory exists
assert [ -s "$file" ]       # File is not empty
```

---

## Test Categories

### 1. Happy Path Tests

Test normal successful operations:

```bash
@test "command succeeds with valid input" {
  run {{CLI_CMD}} add "Test task"
  assert_success
  assert_output --partial "T"
}
```

### 2. Error Handling Tests

Test all error conditions:

```bash
@test "command fails with invalid task ID" {
  run {{CLI_CMD}} show INVALID
  assert_failure
  assert_output --partial "not found"
}
```

### 3. Edge Case Tests

Test boundary conditions:

```bash
@test "handles empty input gracefully" {
  run {{CLI_CMD}} add ""
  assert_failure
}

@test "handles very long input" {
  local long_title=$(printf 'x%.0s' {1..1000})
  run {{CLI_CMD}} add "$long_title"
  # Verify behavior
}
```

### 4. Integration Tests

Test workflows across commands:

```bash
@test "full workflow: create, update, complete task" {
  # Create
  run {{CLI_CMD}} add "Test task"
  assert_success
  local task_id=$(echo "$output" | jq -r '.task.id')

  # Update
  run {{CLI_CMD}} update "$task_id" --priority high
  assert_success

  # Complete
  run {{CLI_CMD}} complete "$task_id"
  assert_success
}
```

---

## Test Isolation

### CRITICAL: Tests MUST be idempotent

```bash
setup() {
  # Always use temp directory
  export TEST_DIR=$(mktemp -d)
  cd "$TEST_DIR"

  # Initialize fresh project (project-specific)
  {{CLI_CMD}} init test-project --yes 2>/dev/null || true
}

teardown() {
  # Always clean up
  cd /
  rm -rf "$TEST_DIR"
}
```

### Never:
- Modify files outside TEST_DIR
- Depend on global state
- Assume test execution order
- Leave artifacts after test

---

## JSON Output Testing

```bash
@test "JSON output has correct structure" {
  run {{CLI_CMD}} list
  assert_success

  # Validate JSON
  echo "$output" | jq -e '._meta' > /dev/null
  echo "$output" | jq -e '.tasks' > /dev/null
}

@test "JSON contains expected fields" {
  {{CLI_CMD}} add "Test"
  run {{CLI_CMD}} list

  local task=$(echo "$output" | jq '.tasks[0]')
  assert [ "$(echo "$task" | jq -r '.id')" != "null" ]
  assert [ "$(echo "$task" | jq -r '.title')" = "Test" ]
}
```

---

## Running Tests

```bash
# Run single test file
bats tests/integration/{feature}.bats

# Run all tests
./tests/run-all-tests.sh

# Run with verbose output
bats --verbose-run tests/integration/{feature}.bats

# Run specific test
bats tests/integration/{feature}.bats --filter "test name"
```

---

## Manifest Entry Format

```json
{"id":"tests-{{FEATURE_SLUG}}-{{DATE}}","file":"{{DATE}}_tests-{{FEATURE_SLUG}}.md","title":"Tests: {{FEATURE_NAME}}","date":"{{DATE}}","status":"complete","agent_type":"implementation","topics":["tests","bats","{{DOMAIN}}"],"key_findings":["Created {{N}} tests: {{X}} happy path, {{Y}} error handling, {{Z}} integration","All tests pass","Coverage: {{LIST_OF_SCENARIOS}}"],"actionable":false,"needs_followup":[],"linked_tasks":["{{TASK_ID}}"]}
```

---

## Completion Checklist

Before returning, verify:

- [ ] Task started via `{{TASK_START_CMD}}` (if not already started)
- [ ] Test file created in correct location (tests/unit/ or tests/integration/)
- [ ] Tests are idempotent (use temp directories)
- [ ] Happy path tests included
- [ ] Error handling tests included
- [ ] All tests pass when run
- [ ] Manifest entry appended
- [ ] Task completed via `{{TASK_COMPLETE_CMD}}`
- [ ] Return summary message only

---

## Anti-Patterns to Avoid

| Anti-Pattern | Problem | Solution |
|--------------|---------|----------|
| **Non-idempotent tests** | Tests affect each other | Always use temp directories |
| **Missing teardown** | Artifacts left behind | Always clean up in teardown |
| **Hardcoded paths** | Tests fail in different environments | Use `$TEST_DIR` and relative paths |
| **Order-dependent tests** | Tests fail when run in isolation | Each test must be independent |
| **Missing error cases** | Only happy path covered | Test all error conditions |
| **Vague test names** | Unclear what's being tested | Use descriptive names explaining behavior |
| **Testing implementation** | Fragile tests | Test behavior, not implementation details |

---

## Token Reference

### CLI Token (Required for portability)

| Token | Default | Description |
|-------|---------|-------------|
| `{{CLI_CMD}}` | `cleo` | CLI command being tested |

When testing a specific CLI tool, replace `{{CLI_CMD}}` with the actual command (e.g., `cleo`, `git`, `npm`).
