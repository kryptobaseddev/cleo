<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->
# Agent Documentation

For comprehensive repository guidelines, see @CLAUDE.md for project overview, architecture principles, critical rules, and detailed workflow expectations.

## Build, Test, and Development Commands

### Running Tests

```bash
# Run full test suite
./tests/run-all-tests.sh

# Run only unit tests
./tests/run-all-tests.sh --unit

# Run only integration tests  
./tests/run-all-tests.sh --integration

# Run a specific test file (REQUIRED for single test)
bats tests/unit/add-task.bats

# Run tests matching a pattern
./tests/run-all-tests.sh --filter "add.*task"

# Run with verbose output
./tests/run-all-tests.sh --verbose

# Run smoke tests (quick sanity check)
./tests/run-all-tests.sh --smoke

# Run with parallel execution
./tests/run-all-tests.sh --parallel --jobs 8
./tests/run-all-tests.sh --fast  # Use all CPU cores

# Check test prerequisites
./install.sh --check-deps
git submodule update --init --recursive
```

### Validation & Linting

```bash
# Quick syntax check on shell changes
bash -n scripts/*.sh lib/*/*.sh

# ShellCheck (if available)
shellcheck scripts/*.sh lib/*/*.sh

# Validate CLEO installation and data integrity
cleo --validate

# Validate with auto-fix
cleo validate --fix

# Verify version consistency
./dev/validate-version.sh
```

### Development Tools

```bash
# Bump version via config-driven system
cleo release ship <version> --bump-version

# Performance testing
./dev/benchmark-performance.sh

# Backup operations
cleo backup
cleo backup --list
cleo restore <backup-id>
```

## Code Style Guidelines

### Shell Script Standards

**Shebang and Settings:**
```bash
#!/usr/bin/env bash
set -euo pipefail
```

**Indentation:** 4 spaces (no tabs)

**Variable Naming:**
- Functions/variables: `snake_case`
- Constants: `UPPER_SNAKE_CASE`
- Script-specific vars: lowercase with underscore

**Best Practices:**
- Always quote variable expansions: `"$VAR"` not `$VAR`
- Prefer `[[ ... ]]` over `[ ... ]` for conditionals
- Use `$()` for command substitution (not backticks)
- Use `readonly` for constants
- Add `declare -r` for sourced file guards

**Script Header Template:**
```bash
#!/usr/bin/env bash
###CLEO
# command: <name>
# category: <read|write|maintenance>
# synopsis: <brief description>
# relevance: <critical|high|medium|low>
# flags: --format,--quiet,--json,--human,--dry-run
# exits: 0,2,3,4,5
# json-output: true
###END
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
```

**Library Sourcing Convention:**
```bash
# Libraries use _LIB_DIR pointing to lib/
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$_LIB_DIR/core/exit-codes.sh"

# Scripts use LIB_DIR
LIB_DIR="${SCRIPT_DIR}/../lib"
source "$LIB_DIR/core/logging.sh"
```

### JSON Standards

- **Indentation:** 2 spaces
- **Keys:** camelCase
- **Formatting:** No trailing commas
- **Validation:** Must pass JSON Schema validation

### Test File Standards

**Naming:**
- Files: `feature-name.bats` (kebab-case)
- Tests: `@test "feature should expected_outcome"`

**Test Structure:**
```bats
#!/usr/bin/env bats

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test
}

teardown() {
    common_teardown_per_test
}

@test "feature should expected_outcome" {
    create_empty_todo
    run bash "$SCRIPT" --option
    assert_success
    assert_output "expected"
}
```

## Critical Rules & Constraints

### **CRITICAL: Atomic Operations**
All write operations MUST follow this pattern:
1. Write to temporary file
2. Validate against JSON Schema
3. Create backup of original
4. Atomic rename to replace original

### **CRITICAL: No Time Estimates**
**NEVER** estimate hours, days, or duration. Describe scope, complexity, and dependencies using relative sizing (small/medium/large) instead.

### **CRITICAL: CLI-Only Data Operations**
Never edit `.cleo/*.json` files directly. Always use CLI commands:
- `cleo add` not editing todo.json
- `cleo update` not manual JSON edits
- `cleo complete` not marking done in file

### **CRITICAL: Task Reference Format**
All commits must reference a task ID: `(T####)`
Example: `feat: add new validation (T1234)`

## Error Handling

**Exit Code Ranges:**
- `0` - Success
- `1-59` - General errors
- `60-67` - Protocol violations (research, consensus, spec, etc.)
- `68-79` - Reserved
- `80-84` - Verification gate codes
- `85-99` - Nexus codes
- `100+` - Special conditions (not errors)

**Error Response Pattern:**
```bash
if ! some_operation; then
    log_error "Failed to perform operation" "$EXIT_CODE"
    return $EXIT_CODE
fi
```

## Agent-Specific Notes

### When Using AI Agents
1. **Follow AGENTS.md** - It defines repository-specific workflow expectations
2. **Respect atomic operations** - Never bypass the temp→validate→backup→rename pattern
3. **Maintain data integrity** - Always validate before and after operations
4. **Use proper testing** - Add tests for new features and bug fixes
5. **Follow commit conventions** - Use proper types and scopes
6. **No time estimates** - Focus on scope and complexity instead

### Common Pitfalls to Avoid
- Don't edit JSON files directly - use CLI commands only
- Don't skip validation steps - they're critical for data integrity
- Don't add time estimates - they're explicitly prohibited
- Don't forget atomic operations - all writes must be atomic
- Don't skip testing - new features need tests
- Don't hardcode paths - use config discovery functions
