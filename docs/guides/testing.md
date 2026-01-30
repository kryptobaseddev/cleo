# Testing Guide

Comprehensive BATS test suite for cleo CLI.

## Quick Start

```bash
# Run all tests (16 parallel jobs by default)
./tests/run-all-tests.sh

# Maximum speed - use all CPU cores
./tests/run-all-tests.sh --fast

# Run specific test file
bats tests/unit/add-task.bats

# Run with filter
bats tests/unit/*.bats --filter "priority"
```

## Prerequisites

1. **BATS** (Bash Automated Testing System) - v1.5.0+ required for parallel
   ```bash
   # macOS
   brew install bats-core

   # Debian/Ubuntu
   sudo apt-get install bats

   # Fedora
   sudo dnf install bats
   ```

2. **GNU parallel** (required for parallel test execution)
   ```bash
   # macOS
   brew install parallel

   # Debian/Ubuntu
   sudo apt-get install parallel

   # Fedora
   sudo dnf install parallel
   ```

3. **Git submodules** (helper libraries)
   ```bash
   git submodule update --init --recursive
   ```

4. **jq** (JSON processor)
   ```bash
   # macOS
   brew install jq

   # Debian/Ubuntu
   sudo apt-get install jq
   ```

## Test Structure

```
tests/
├── run-all-tests.sh         # Test runner
├── unit/                    # Unit tests (per-script)
│   ├── add-task.bats
│   ├── archive.bats
│   ├── complete-task.bats
│   ├── export.bats
│   ├── focus.bats
│   └── ...
├── integration/             # Multi-script workflow tests
│   ├── workflow.bats
│   └── error-recovery.bats
├── test_helper/             # Shared test utilities
│   ├── common_setup.bash    # Setup/teardown, paths
│   ├── assertions.bash      # Custom assertions
│   └── fixtures.bash        # Test data generators
└── fixtures/                # Static test fixtures
```

## Test Categories

| Category | Location | Purpose |
|----------|----------|---------|
| Unit | `tests/unit/` | Individual script testing |
| Integration | `tests/integration/` | Multi-script workflows |
| Edge Cases | `tests/unit/edge-cases.bats` | Boundary conditions |

## Writing Tests

Use the optimized `setup_file()` pattern for best performance:

```bash
#!/usr/bin/env bats

# File-level setup (runs once per file - load libraries here)
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

# Per-test setup (runs before each test)
setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test
}

# Per-test teardown
teardown() {
    common_teardown_per_test
}

# File-level teardown (runs once per file)
teardown_file() {
    common_teardown_file
}

@test "descriptive test name" {
    create_empty_todo
    run bash "$ADD_SCRIPT" "Test task"
    assert_success
    assert_output --partial "Added"
}
```

> **Note**: All test files must use `setup_file()` for parallel execution compatibility.

## Common Assertions

| Assertion | Purpose |
|-----------|---------|
| `assert_success` | Exit code 0 |
| `assert_failure` | Non-zero exit |
| `assert_output --partial "text"` | Output contains text |
| `assert_valid_json` | Valid JSON output |
| `assert_task_exists "T001"` | Task in todo.json |
| `assert_task_status "T001" "done"` | Task has status |

## Fixtures

Reusable test data generators:

| Function | Description |
|----------|-------------|
| `create_empty_todo` | Empty todo.json |
| `create_independent_tasks` | 3 tasks, no dependencies |
| `create_linear_chain` | T001 ← T002 ← T003 |
| `create_complex_deps` | Multi-branch dependency graph |
| `create_blocked_tasks` | Tasks with blocked status |

## Debugging

```bash
# Verbose output
bats tests/unit/add-task.bats --trace

# Print debug info in tests
@test "debug example" {
    echo "# Debug: $TODO_FILE" >&3
    run bash "$ADD_SCRIPT" "Test"
    echo "# Output: $output" >&3
}
```

## Detailed Documentation

For complete test documentation including:
- All available helpers and assertions
- Fixture file formats
- CI/CD integration
- Contribution guidelines

See: [tests/README.md](../tests/README.md)
