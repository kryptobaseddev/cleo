# CLEO Test Suite

Comprehensive BATS test suite for cleo CLI tool.

## Directory Structure

```
tests/
├── README.md                 # This file
├── run-all-tests.sh         # Test runner script
├── libs/                     # BATS helper libraries (git submodules)
│   ├── bats-support/        # Core testing support
│   ├── bats-assert/         # Assertion helpers
│   └── bats-file/           # File operation assertions
├── test_helper/             # Shared test helpers
│   ├── common_setup.bash    # Common setup/teardown and paths
│   ├── assertions.bash      # Custom assertions for cleo
│   └── fixtures.bash        # Test data generators
├── unit/                    # Unit tests for individual scripts
│   ├── add-task.bats
│   ├── archive.bats
│   ├── blockers.bats
│   ├── complete-task.bats
│   ├── critical-path.bats
│   ├── deps.bats
│   ├── export.bats
│   ├── file-locking.bats
│   ├── focus.bats
│   ├── init-checksum.bats
│   ├── migrate.bats
│   ├── output-format.bats
│   ├── session.bats
│   └── validation.bats
├── integration/             # Integration tests (multi-script)
│   ├── archive-atomic.bats
│   └── circular-deps.bats
└── fixtures/                # Static test fixtures
    ├── valid/               # Valid JSON fixtures
    ├── invalid/             # Invalid JSON fixtures (for validation tests)
    ├── edge-cases/          # Edge case fixtures
    └── circular-deps/       # Circular dependency test fixtures
```

## Prerequisites

1. **BATS** - Bash Automated Testing System (v1.5.0+ for parallel)
   ```bash
   # macOS
   brew install bats-core

   # Debian/Ubuntu
   sudo apt-get install bats

   # Fedora
   sudo dnf install bats

   # From source
   git clone https://github.com/bats-core/bats-core.git
   cd bats-core && sudo ./install.sh /usr/local
   ```

2. **GNU parallel** - Required for parallel test execution
   ```bash
   # macOS
   brew install parallel

   # Debian/Ubuntu
   sudo apt-get install parallel

   # Fedora
   sudo dnf install parallel
   ```

3. **Git submodules** - Initialize helper libraries
   ```bash
   git submodule update --init --recursive
   ```

4. **jq** - JSON processor (required for many tests)
   ```bash
   # macOS
   brew install jq

   # Debian/Ubuntu
   sudo apt-get install jq
   ```

## Running Tests

### All Tests
```bash
# Run all tests
./tests/run-all-tests.sh

# Run with verbose output
./tests/run-all-tests.sh --verbose
```

### Specific Test Files
```bash
# Run a single test file
bats tests/unit/add-task.bats

# Run all unit tests
bats tests/unit/*.bats

# Run all integration tests
bats tests/integration/*.bats
```

### Specific Tests by Name
```bash
# Run tests matching a pattern
bats tests/unit/add-task.bats --filter "add task with --priority"
```

## Running Tests in Parallel

The test suite supports parallel execution for faster test runs on multi-core systems.

### Parallel Execution

```bash
# Default: 16 parallel jobs (auto-detected)
./tests/run-all-tests.sh

# Maximum speed: use all available CPU cores
./tests/run-all-tests.sh --fast

# Set specific job count
./tests/run-all-tests.sh --jobs 8

# Disable parallel (sequential mode)
./tests/run-all-tests.sh --no-parallel
```

### Performance Comparison

| Mode | Command | Typical Time |
|------|---------|--------------|
| Sequential | `--no-parallel` | ~10 min |
| Default (16 jobs) | (none) | ~2 min |
| Fast (all cores) | `--fast` | ~1.5 min |

**Requirements for parallel execution:**
- BATS 1.5.0+ (supports `--jobs` flag)
- GNU parallel (required for `--jobs` to work)
- Test isolation via `BATS_TEST_TMPDIR` (already implemented)

**Install GNU parallel:**
```bash
# Fedora
sudo dnf install parallel

# Debian/Ubuntu
sudo apt install parallel

# macOS
brew install parallel
```

## Writing New Tests

### Basic Test Structure (Optimized)

All test files should use the `setup_file()` pattern for optimal performance:

```bash
#!/usr/bin/env bats
# =============================================================================
# feature-name.bats - Unit tests for feature-name.sh
# =============================================================================
# Description of what this test file covers.
# =============================================================================

# File-level setup (runs once per file)
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

# Per-test teardown (runs after each test)
teardown() {
    common_teardown_per_test
}

# File-level teardown (runs once per file)
teardown_file() {
    common_teardown_file
}

# =============================================================================
# Section Header
# =============================================================================

@test "descriptive test name" {
    create_independent_tasks  # Use fixture helper
    run bash "$ADD_SCRIPT" "Test task"
    assert_success
    assert_output_contains_any "Task" "added"
}
```

### Available Helpers

#### From `common_setup.bash`

| Function | Description |
|----------|-------------|
| `common_setup_file` | File-level initialization (runs once per .bats file) |
| `common_setup_per_test` | Per-test setup (isolated temp directory) |
| `common_teardown_per_test` | Per-test cleanup |
| `common_teardown_file` | File-level cleanup (runs once per .bats file) |
| `common_setup` | Legacy: Combined setup (deprecated, use per_test) |
| `common_teardown` | Legacy: Combined teardown (deprecated, use per_test) |
| `$PROJECT_ROOT` | Path to cleo project root |
| `$TODO_FILE` | Path to test todo.json |
| `$CONFIG_FILE` | Path to test config.json |
| `$ARCHIVE_FILE` | Path to test archive.json |
| `$LOG_FILE` | Path to test log.json |
| `$ADD_SCRIPT` | Path to add.sh |
| `$UPDATE_SCRIPT` | Path to update.sh |
| `$COMPLETE_SCRIPT` | Path to complete.sh |
| `$VALIDATE_SCRIPT` | Path to validate.sh |
| `$BLOCKERS_SCRIPT` | Path to blockers.sh |
| `$DEPS_SCRIPT` | Path to deps.sh |
| ... | (and more script paths) |

#### From `assertions.bash`

| Assertion | Description |
|-----------|-------------|
| `assert_valid_json` | Verify output is valid JSON |
| `assert_shows_help` | Verify help text is shown |
| `assert_markdown_output` | Verify markdown format |
| `assert_output_contains_any "a" "b"` | Output contains any of the strings |
| `assert_task_exists "T001"` | Task exists in todo.json |
| `assert_task_status "T001" "done"` | Task has specific status |
| `assert_task_depends_on "T001" "T002"` | Task has dependency |
| `assert_task_not_depends_on "T001" "T002"` | Task does not have dependency |
| `assert_task_count 5` | Number of tasks matches |

#### From `fixtures.bash`

| Fixture Function | Description |
|------------------|-------------|
| `create_empty_todo` | Empty todo.json with no tasks |
| `create_independent_tasks` | 3 tasks with no dependencies |
| `create_linear_chain` | T001 ← T002 ← T003 chain |
| `create_complex_deps` | Multi-branch dependency graph |
| `create_blocked_tasks` | Tasks with blocked status |
| `create_multi_blocker_tasks` | Task blocked by multiple |
| `create_completed_blocker` | Completed task that was blocking |
| `create_tasks_with_completed` | Mix of pending and done |
| `create_circular_deps` | Invalid circular dependencies |
| `add_task_to_fixture` | Add task to existing fixture |
| `add_dependency_to_fixture` | Add dependency to task |

### Test Naming Conventions

- Use descriptive names that explain what is being tested
- Start with the feature being tested
- Include expected outcome when relevant

```bash
# Good
@test "add task with --priority high sets priority correctly"
@test "complete without notes fails by default"
@test "blockers analyze identifies bottleneck tasks"

# Bad
@test "test1"
@test "priority works"
@test "it should work"
```

### Section Headers

Use comment headers to group related tests:

```bash
# =============================================================================
# Help and Basic Command Tests
# =============================================================================

@test "command --help shows usage" { ... }
@test "command -h shows usage" { ... }

# =============================================================================
# Error Handling Tests
# =============================================================================

@test "command fails with invalid input" { ... }
```

## Test Categories

### Unit Tests (`tests/unit/`)

Test individual scripts in isolation:
- Input validation
- Option parsing
- Output formatting
- Error handling
- Edge cases

### Integration Tests (`tests/integration/`)

Test interaction between multiple scripts:
- Workflow sequences
- Data consistency across operations
- Dependency chain handling
- Atomic operations

## Continuous Integration

The test suite is designed to run in CI environments:

```yaml
# Example GitHub Actions
- name: Run Tests
  run: |
    git submodule update --init --recursive
    ./tests/run-all-tests.sh
```

## Debugging Failed Tests

### Verbose Output
```bash
bats tests/unit/add-task.bats --trace
```

### Print Debug Info
```bash
@test "debugging example" {
    echo "# Debug: TODO_FILE=$TODO_FILE" >&3
    echo "# Debug: Contents:" >&3
    cat "$TODO_FILE" >&3

    run bash "$ADD_SCRIPT" "Test"
    echo "# Output: $output" >&3
    echo "# Status: $status" >&3

    assert_success
}
```

### Common Issues

1. **Missing submodules**: Run `git submodule update --init --recursive`
2. **Permission denied**: Ensure scripts are executable (`chmod +x`)
3. **jq not found**: Install jq
4. **Test isolation**: Each test should use `common_setup` which creates fresh temp directory

## Coverage Goals

- All CLI commands have corresponding test files
- Help flags tested for each command
- All option flags tested (both long and short forms)
- Error cases tested with appropriate exit codes
- Edge cases documented in fixtures/
- Integration tests for critical workflows

## Adding New Test Files

1. Create file in appropriate directory (`unit/` or `integration/`)
2. Follow naming convention: `feature-name.bats`
3. Use standard setup/teardown loading helpers
4. Add relevant fixtures to `fixtures.bash` if needed
5. Add custom assertions to `assertions.bash` if needed
6. Update this README if adding new patterns

## Fixture File Format

Static fixtures in `fixtures/` follow this structure:

```json
{
  "_meta": {
    "version": "2.1.0",
    "checksum": "..."
  },
  "tasks": [...],
  "focus": {}
}
```

See existing fixtures for examples.
