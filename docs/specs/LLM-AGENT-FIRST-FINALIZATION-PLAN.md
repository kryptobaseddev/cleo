# LLM-Agent-First Spec and Compliance Finalization Plan

> **Epic**: Finalize immutable LLM-Agent-First standard for claude-todo
> **Version**: 1.0
> **Created**: 2025-12-18
> **Status**: PLANNING

---

## Executive Summary

This plan addresses 47 findings from 5 adversarial investigation agents analyzing:
- `docs/specs/LLM-AGENT-FIRST-SPEC.md` (the specification)
- `dev/check-compliance.sh` (the compliance validator)
- Related implementation files

### Overall Assessment

| Component | Current | Target |
|-----------|---------|--------|
| Spec Quality | 78% solid | 98% |
| Compliance Checker | 55% effective | 95% |
| Test Coverage | ~5% error codes | 80% |
| Performance | 689 jq calls/run | ~50 |

---

## Phase 1: CRITICAL FIXES (P0)

### Task 1.1: Fix `set -euo pipefail` Validation Gap

**Priority**: P0 - CRITICAL
**Effort**: Small (1-2 hours)
**Blocked By**: None

**Problem**: The spec requires `set -euo pipefail` but compliance checker does NOT validate this.

**Finding Sources**: Performance Agent, Root Cause Analysis

**Current State**: All 32 scripts have `set -euo pipefail` (verified), but compliance checker has no check.

**Action Items**:
1. Add `set -euo pipefail` check to `dev/compliance/checks/foundation.sh`
2. Add pattern to `dev/compliance/schema.json`
3. Update scoring in schema

**Implementation**:
```bash
# In foundation.sh after VERSION check (line ~105)
# Check 5: set -euo pipefail present
if pattern_exists "$script" "^set -euo pipefail"; then
    results+=('{"check": "bash_strict_mode", "passed": true, "details": "set -euo pipefail present"}')
    ((passed++)) || true
    [[ "$verbose" == "true" ]] && print_check pass "Bash strict mode (set -euo pipefail)"
else
    results+=('{"check": "bash_strict_mode", "passed": false, "details": "Missing set -euo pipefail"}')
    ((failed++)) || true
    [[ "$verbose" == "true" ]] && print_check fail "Bash strict mode" "Missing set -euo pipefail"
fi
```

---

### Task 1.2: Fix PATTERN_* Variable Non-Usage

**Priority**: P0 - CRITICAL
**Effort**: Medium (2-3 hours)
**Blocked By**: None

**Problem**: `check-compliance.sh` pre-extracts 15 patterns into `PATTERN_*` variables (lines 300-376) but check scripts ignore them, making ~608 jq calls per run instead of ~20.

**Finding Sources**: Compliance Checker Agent, Performance Agent

**Current jq Calls**:
| Check Script | jq calls/script | x 32 scripts |
|--------------|-----------------|--------------|
| foundation.sh | 4 | 128 |
| flags.sh | 5 | 160 |
| exit-codes.sh | 5 | 160 |
| errors.sh | 5 | 160 |
| **Total** | 19 | **608** |

**Action Items**:
1. Modify `foundation.sh` to use `$PATTERN_DUAL_PATH`, `$PATTERN_COMMAND_NAME`, `$PATTERN_VERSION_CENTRAL`
2. Modify `flags.sh` to use `$PATTERN_FORMAT_FLAG`, `$PATTERN_QUIET_FLAG`, etc.
3. Modify `exit-codes.sh` to use `$PATTERN_EXIT_CONSTANTS`, `$PATTERN_EXIT_LIB`
4. Modify `errors.sh` to use `$PATTERN_ERROR_FUNCTION`, `$PATTERN_DEFENSIVE_CHECK`, `$PATTERN_ERROR_LIB`

**Example Refactor**:
```bash
# BEFORE (foundation.sh:57)
dual_path_pattern=$(echo "$schema" | jq -r '.requirements.foundation.libraries.patterns.dual_path')

# AFTER
dual_path_pattern="${PATTERN_DUAL_PATH:-$(echo "$schema" | jq -r '.requirements.foundation.libraries.patterns.dual_path')}"
```

**Expected Improvement**: 97% reduction in jq calls (608 → ~20)

---

### Task 1.3: Fix Security: eval with User-Controlled Path

**Priority**: P0 - CRITICAL
**Effort**: Medium (2-3 hours)
**Blocked By**: None

**Problem**: `lib/file-ops.sh:130,138,143,175` uses `eval` with user-controlled file paths.

**Finding Source**: Security Agent

**Risk**: Command injection via malicious file names containing shell metacharacters.

**Vulnerable Code** (file-ops.sh:130):
```bash
if ! eval "exec $fd>'$lock_file'" 2>/dev/null; then
```

**Action Items**:
1. Add path sanitization function to `lib/validation.sh`
2. Call sanitization before `lock_file()` in `file-ops.sh`
3. Reject paths containing: `$`, backtick, `;`, `|`, `&`, `<`, `>`, `'`, `"`

**Implementation**:
```bash
# In lib/validation.sh
sanitize_file_path() {
    local path="$1"
    # Check for shell metacharacters
    if [[ "$path" =~ [\$\`\;\|\&\<\>\'\"] ]]; then
        echo "ERROR: Invalid characters in path: $path" >&2
        return 1
    fi
    # Return clean path
    echo "$path"
}

# In lib/file-ops.sh before lock_file usage
lock_file=$(sanitize_file_path "$file.lock") || return $FO_INVALID_ARG
```

---

### Task 1.4: Add Schema Versioning to URLs

**Priority**: P0 - CRITICAL
**Effort**: Medium (3-4 hours)
**Blocked By**: None

**Problem**: Schema URLs don't include version, making breaking changes undetectable.

**Finding Sources**: Spec Analysis Agent, Architecture review

**Current**:
```json
"$schema": "https://claude-todo.dev/schemas/output.schema.json"
```

**Target**:
```json
"$schema": "https://claude-todo.dev/schemas/v1/output.schema.json"
```

**Action Items**:
1. Update all schema `$id` URLs to include `/v1/`
2. Update spec examples (lines 132, 401, 473)
3. Update lib/error-json.sh schema references
4. Add `_meta.schemaVersion` field to spec (optional)
5. Update compliance checker to validate versioned URLs

**Files to Update**:
- `schemas/output.schema.json`
- `schemas/error.schema.json`
- `schemas/todo.schema.json`
- `docs/specs/LLM-AGENT-FIRST-SPEC.md`
- `lib/error-json.sh`

---

### Task 1.5: Fix Template Bugs in Part 10

**Priority**: P0 - CRITICAL
**Effort**: Small (1 hour)
**Blocked By**: None

**Problem**: Spec template (lines 852-942) has bugs that cause copy-paste failures.

**Finding Sources**: Quality Agent, Documentation review

**Bugs**:
1. `show_help` function called but never defined (line 894)
2. `$VERSION` variable used but never loaded (line 913)

**Action Items**:
1. Add `show_help()` function definition before argument parsing
2. Add VERSION loading from central file

**Implementation to Add** (after line 871):
```bash
# Show help message
show_help() {
    cat << 'EOF'
Usage: <command>.sh [OPTIONS] [ARGS]

Options:
  -f, --format FORMAT   Output format (text|json|jsonl|markdown|table)
  --json                Shortcut for --format json
  --human               Shortcut for --format text
  -q, --quiet           Suppress non-essential output
  -v, --verbose         Enable verbose output
  --dry-run             Preview changes without applying
  -h, --help            Show this help message
EOF
}

# Load VERSION from central location
if [[ -n "${CLAUDE_TODO_HOME:-}" ]] && [[ -f "$CLAUDE_TODO_HOME/VERSION" ]]; then
    VERSION=$(cat "$CLAUDE_TODO_HOME/VERSION" | tr -d '[:space:]')
elif [[ -f "${SCRIPT_DIR}/../VERSION" ]]; then
    VERSION=$(cat "${SCRIPT_DIR}/../VERSION" | tr -d '[:space:]')
else
    VERSION="0.0.0"
fi
```

---

## Phase 2: HIGH PRIORITY FIXES (P1)

### Task 2.1: Add Idempotency Requirements to Spec

**Priority**: P1 - HIGH
**Effort**: Medium (2-3 hours)
**Blocked By**: None

**Problem**: No idempotency guarantees for write commands. Agent retries can create duplicates.

**Finding Sources**: Spec Analysis Agent, Requirements review

**Action Items**:
1. Add Section 5.6: "Idempotency Requirements" to spec
2. Define idempotency semantics per command
3. Document non-idempotent operations

**Spec Addition**:
```markdown
### Part 5.6: Idempotency Requirements

Write commands MUST be idempotent where feasible:

| Command | Idempotency | Mechanism |
|---------|-------------|-----------|
| add | SHOULD | Detect duplicate title+phase within 60s |
| update | MUST | Updating with same values returns EXIT_NO_CHANGE |
| complete | MUST | Completing done task returns EXIT_NO_CHANGE |
| archive | MUST | Re-archiving is no-op |

Non-idempotent operations MUST be documented in help text.
```

---

### Task 2.2: Add Retry/Backoff Protocol to Spec

**Priority**: P1 - HIGH
**Effort**: Medium (2-3 hours)
**Blocked By**: None

**Problem**: Recoverable errors (exit codes 7, 20-22) have no retry specification.

**Finding Sources**: Spec Analysis Agent, Agent UX review

**Action Items**:
1. Add Section 5.7: "Retry Protocol for Recoverable Errors"
2. Define retry counts, delays, backoff factors
3. Add code example

**Spec Addition**:
```markdown
### Part 5.7: Retry Protocol for Recoverable Errors

Agents SHOULD implement exponential backoff for recoverable errors:

| Exit Code | Max Retries | Initial Delay | Backoff |
|-----------|-------------|---------------|---------|
| 7 (LOCK_TIMEOUT) | 3 | 100ms | 2x |
| 20 (CHECKSUM_MISMATCH) | 5 | 50ms | 1.5x |
| 21 (CONCURRENT_MOD) | 5 | 100ms | 2x |
| 22 (ID_COLLISION) | 3 | 0ms | immediate |
```

---

### Task 2.3: Disable --incremental in CI Mode

**Priority**: P1 - HIGH
**Effort**: Small (30 min)
**Blocked By**: None

**Problem**: `--ci` and `--incremental` can both be active, causing non-deterministic CI results.

**Finding Sources**: Compliance Checker Agent, CI/CD review

**Action Items**:
1. Add conflict check after argument parsing in `check-compliance.sh`
2. Force `INCREMENTAL=false` when `CI_MODE=true`
3. Log warning about ignored flag

**Implementation** (after line 269):
```bash
# CI mode forces full check
if [[ "$CI_MODE" == "true" ]] && [[ "$INCREMENTAL" == "true" ]]; then
    [[ "$QUIET" != "true" ]] && log_warn "CI mode forces full check, ignoring --incremental"
    INCREMENTAL=false
fi
```

---

### Task 2.4: Add Runtime Length Validation

**Priority**: P1 - HIGH
**Effort**: Medium (3-4 hours)
**Blocked By**: None

**Problem**: Only task title has runtime length validation. Other fields lack enforcement.

**Finding Sources**: Security Agent

**Fields Needing Validation**:
| Field | Max Length | Current | Status |
|-------|------------|---------|--------|
| title | 120 | Validated | OK |
| description | 2000 | None | MISSING |
| notes (each) | 500 | None | MISSING |
| blockedBy | 300 | None | MISSING |
| sessionNote | 1000 | None | MISSING |

**Action Items**:
1. Add `validate_description()`, `validate_note()`, `validate_blocked_by()` to `lib/validation.sh`
2. Call new validators in add-task.sh, update-task.sh
3. Add tests for length validation

---

### Task 2.5: Fix Non-Atomic Writes in validate.sh

**Priority**: P1 - HIGH
**Effort**: Medium (2-3 hours)
**Blocked By**: None

**Problem**: `validate.sh` writes to files without acquiring locks (lines 197, 255, 340, 389, 601).

**Finding Source**: Security Agent

**Action Items**:
1. Wrap file modifications with `lock_file`/`unlock_file` calls
2. Or use `save_json()` from file-ops.sh which includes locking
3. Add error handling for lock failures

---

### Task 2.6: Update Backwards Compatibility Policy

**Priority**: P1 - HIGH
**Effort**: Small (1 hour)
**Blocked By**: None

**Problem**: "NEVER change" promises for exit codes and error codes are unsustainable.

**Finding Sources**: Spec Analysis Agent, Backwards Compat review

**Current** (spec lines 958-960):
```
| Exit code value changes | **NEVER** change without major version |
| Error code string changes | **NEVER** change (add new, deprecate old) |
```

**Action Items**:
1. Change to "MUST NOT change within major version"
2. Add deprecation sunset policy (2 major versions)
3. Add deprecation registry requirement

---

### Task 2.7: Fix Command Count Inconsistency

**Priority**: P1 - HIGH
**Effort**: Small (30 min)
**Blocked By**: None

**Problem**: Spec says "30 commands" (line 6) but table has 31 rows, and filesystem has 32 scripts.

**Finding Source**: Spec Analysis Agent

**Action Items**:
1. Update line 6 to "32 commands"
2. Update line 65 table header to "All Commands (32 total)"
3. Add `config` command to table

---

## Phase 3: MEDIUM PRIORITY IMPROVEMENTS (P2)

### Task 3.1: Increase Error Code Test Coverage

**Priority**: P2 - MEDIUM
**Effort**: Large (6-8 hours)
**Blocked By**: None

**Problem**: 0% of 29 error codes (E_*) have test coverage.

**Finding Source**: Quality Agent

**Action Items**:
1. Create `tests/unit/error-codes.bats`
2. Add test for each error code triggering scenario
3. Verify JSON structure when `--format json`

**Example Test**:
```bash
@test "add task without title returns E_INPUT_MISSING" {
    run bash "$ADD_SCRIPT" --format json
    assert_failure
    assert_equal "$status" 2
    run jq -r '.error.code' <<< "$output"
    assert_output "E_INPUT_MISSING"
}
```

---

### Task 3.2: Add --dry-run Tests for Write Commands

**Priority**: P2 - MEDIUM
**Effort**: Medium (4-5 hours)
**Blocked By**: None

**Problem**: add, update, complete have --dry-run but no test coverage.

**Finding Source**: Quality Agent

**Action Items**:
1. Add tests to `tests/unit/add-task.bats`
2. Add tests to `tests/unit/update-task.bats`
3. Add tests to `tests/unit/complete-task.bats`
4. Verify no file modifications occur

---

### Task 3.3: Enable Runtime JSON Tests for Write Commands

**Priority**: P2 - MEDIUM
**Effort**: Medium (3-4 hours)
**Blocked By**: Task 3.2

**Problem**: 45% of commands skip runtime JSON envelope tests (write commands).

**Finding Sources**: Compliance Checker Agent, Quality Agent

**Action Items**:
1. Modify `json-envelope.sh` to test write commands with `--dry-run`
2. Use fixture cleanup between tests
3. Update skip categories in schema

---

### Task 3.4: Refactor main() Function

**Priority**: P2 - MEDIUM
**Effort**: Large (6-8 hours)
**Blocked By**: None

**Problem**: main() in check-compliance.sh is 209 lines with multiple responsibilities.

**Finding Sources**: Compliance Checker Agent, Code Quality review

**Target Functions**:
1. `setup_environment()` - paths, libraries, dev mode
2. `load_and_validate_schema()` - schema loading, pattern extraction
3. `prepare_check_environment()` - cache, scripts list, fixture
4. `run_all_checks()` - main check loop
5. `calculate_summary()` - result aggregation
6. `output_and_exit()` - formatting, CI exit

---

### Task 3.5: Add Input Validation Requirements to Spec

**Priority**: P2 - MEDIUM
**Effort**: Medium (2-3 hours)
**Blocked By**: None

**Problem**: Spec doesn't specify WHAT to validate in write commands.

**Finding Source**: Spec Analysis Agent

**Action Items**:
1. Add Section 5.3: "Input Validation Requirements"
2. Define validation per field type
3. Map validations to error codes

---

### Task 3.6: Add Cache Schema Version Tracking

**Priority**: P2 - MEDIUM
**Effort**: Small (1-2 hours)
**Blocked By**: None

**Problem**: Schema changes don't invalidate compliance cache.

**Finding Source**: Performance Agent

**Action Items**:
1. Add `schemaHash` field to cache structure
2. Invalidate cache when schema hash changes
3. Invalidate cache when check scripts change

---

### Task 3.7: Add Dry-Run Semantics to Spec

**Priority**: P2 - MEDIUM
**Effort**: Small (1 hour)
**Blocked By**: None

**Problem**: `--dry-run` behavior not specified (lock acquisition, validation, output format).

**Finding Source**: Spec Analysis Agent

**Action Items**:
1. Add Section 5.4: "Dry-Run Semantics"
2. Define behavior: no locks, full validation, JSON output format
3. Define exit code semantics for dry-run

---

## Phase 4: LOW PRIORITY ENHANCEMENTS (P3)

### Task 4.1: Add Batch Operation Semantics to Spec

**Priority**: P3 - LOW
**Effort**: Medium (2-3 hours)

Add Section 5.8 defining partial failure handling for archive, migrate, validate.

### Task 4.2: Add Unicode Bidirectional Override Detection

**Priority**: P3 - LOW
**Effort**: Small (1-2 hours)

Add RTL override character detection (U+202D, U+202E) to validation.

### Task 4.3: Add Lock Retry with Backoff

**Priority**: P3 - LOW
**Effort**: Medium (2-3 hours)

Implement exponential backoff retry for lock acquisition failures.

### Task 4.4: Replace Globals with Associative Arrays

**Priority**: P3 - LOW
**Effort**: Large (4-6 hours)

Group 31+ globals into `CONFIG` and `PATTERNS` associative arrays.

### Task 4.5: Add Performance Requirements to Spec

**Priority**: P3 - LOW
**Effort**: Small (1 hour)

Add Section 8.2 with latency targets per operation type.

### Task 4.6: Add Language-Agnostic Pseudocode

**Priority**: P3 - LOW
**Effort**: Medium (2-3 hours)

Add Python/Node.js examples to Part 10.

---

## Implementation Order

```
Phase 1 (P0) - Week 1
├── Task 1.1: set -euo pipefail check
├── Task 1.2: PATTERN_* variable usage
├── Task 1.3: eval security fix
├── Task 1.4: Schema versioning
└── Task 1.5: Template bug fixes

Phase 2 (P1) - Week 2
├── Task 2.1: Idempotency spec
├── Task 2.2: Retry protocol spec
├── Task 2.3: CI incremental fix
├── Task 2.4: Length validation
├── Task 2.5: validate.sh locks
├── Task 2.6: Backwards compat policy
└── Task 2.7: Command count fix

Phase 3 (P2) - Weeks 3-4
├── Task 3.1: Error code tests
├── Task 3.2: --dry-run tests
├── Task 3.3: Runtime write tests
├── Task 3.4: main() refactor
├── Task 3.5: Input validation spec
├── Task 3.6: Cache schema tracking
└── Task 3.7: Dry-run semantics spec

Phase 4 (P3) - As needed
├── Task 4.1-4.6: Enhancements
```

---

## Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| Compliance checker jq calls | 689 | <100 |
| Error code test coverage | 0% | 80% |
| Exit code test coverage | 5% | 80% |
| Runtime JSON test coverage | 55% | 90% |
| Spec completeness (gaps) | 23 | 0 |
| Security vulnerabilities | 3 | 0 |

---

## Files Reference

### Spec Files
- `docs/specs/LLM-AGENT-FIRST-SPEC.md` - Main specification
- `docs/development/COMPLIANCE-CHECKING.md` - Checker documentation

### Implementation Files
- `dev/check-compliance.sh` - Main compliance validator
- `dev/compliance/checks/*.sh` - Individual check modules
- `dev/compliance/schema.json` - Validation schema
- `lib/exit-codes.sh` - Exit code constants
- `lib/error-json.sh` - Error JSON output
- `lib/output-format.sh` - Format resolution
- `lib/validation.sh` - Input validation
- `lib/file-ops.sh` - File operations (locking)

### Schema Files
- `schemas/output.schema.json` - Response envelope
- `schemas/error.schema.json` - Error envelope
- `schemas/todo.schema.json` - Data schema

---

*Plan generated from 5-agent adversarial review synthesis*
