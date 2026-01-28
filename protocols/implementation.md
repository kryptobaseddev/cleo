# Implementation Protocol

**Version**: 1.0.0
**Type**: Conditional Protocol
**Max Active**: 3 protocols (including base)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Building | "implement", "build", "create", "develop" | New functionality |
| Coding | "code", "write", "program" | Software creation |
| Fixing | "fix", "bug", "patch", "repair" | Issue resolution |
| Enhancement | "improve", "enhance", "optimize" | Existing code |

**Explicit Override**: `--protocol implementation` flag on task creation.

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| IMPL-001 | MUST include tests for new functionality |
| IMPL-002 | MUST follow project code style conventions |
| IMPL-003 | MUST include JSDoc/docstring provenance tags |
| IMPL-004 | MUST verify changes pass existing tests |
| IMPL-005 | MUST document breaking changes |
| IMPL-006 | MUST write implementation summary to manifest |
| IMPL-007 | MUST set `agent_type: "implementation"` in manifest |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| IMPL-010 | SHOULD add inline comments for complex logic |
| IMPL-011 | SHOULD refactor duplicated code |
| IMPL-012 | SHOULD update related documentation |
| IMPL-013 | SHOULD consider error handling edge cases |

### MAY

| Requirement | Description |
|-------------|-------------|
| IMPL-020 | MAY propose architectural improvements |
| IMPL-021 | MAY add performance benchmarks |
| IMPL-022 | MAY suggest follow-up enhancements |

---

## Output Format

### Provenance Tags

**JavaScript/TypeScript**:
```javascript
/**
 * @task T####
 * @session session_YYYYMMDD_HHMMSS_######
 * @agent opus-1
 * @date YYYY-MM-DD
 * @description Brief description of the function
 */
function implementedFunction() {
    // Implementation
}
```

**Bash**:
```bash
# =============================================================================
# Function: function_name
# Task: T####
# Session: session_YYYYMMDD_HHMMSS_######
# Agent: opus-1
# Date: YYYY-MM-DD
# Description: Brief description
# =============================================================================
function_name() {
    # Implementation
}
```

**Python**:
```python
def implemented_function():
    """
    Brief description.

    Task: T####
    Session: session_YYYYMMDD_HHMMSS_######
    Agent: opus-1
    Date: YYYY-MM-DD
    """
    # Implementation
```

### Test Requirements

| Test Type | When Required | Coverage |
|-----------|---------------|----------|
| Unit | New functions | MUST cover happy path |
| Integration | New workflows | SHOULD cover end-to-end |
| Edge Case | Complex logic | SHOULD cover boundaries |
| Regression | Bug fixes | MUST reproduce issue |

### Code Style Checklist

| Language | Style Guide | Enforcement |
|----------|-------------|-------------|
| Bash | CLEO style (4 spaces, snake_case) | `shellcheck` |
| JavaScript | ESLint config | `eslint` |
| TypeScript | TSConfig strict | `tsc --noEmit` |
| Python | PEP 8 | `flake8`, `black` |

### File Output

```markdown
# Implementation: {Feature/Fix Title}

**Task**: T####
**Date**: YYYY-MM-DD
**Status**: complete|partial|blocked
**Agent Type**: implementation

---

## Summary

{2-3 sentence summary of implementation}

## Changes

### Files Modified

| File | Action | Description |
|------|--------|-------------|
| `path/to/file.sh` | Modified | Added validation function |
| `path/to/new.sh` | Created | New utility module |

### Functions Added

| Function | File | Purpose |
|----------|------|---------|
| `validate_input()` | file.sh | Input validation |

### Functions Modified

| Function | File | Change |
|----------|------|--------|
| `process_data()` | file.sh | Added error handling |

## Tests

### New Tests

| Test | File | Coverage |
|------|------|----------|
| `test_validate_input` | tests/unit/file.bats | Input validation |

### Test Results

```
Running tests/unit/file.bats
 ✓ validate_input accepts valid input
 ✓ validate_input rejects empty input
 ✓ validate_input handles special characters

3 tests, 0 failures
```

## Validation

| Check | Status | Notes |
|-------|--------|-------|
| Tests pass | PASS | All 42 tests pass |
| Lint clean | PASS | No shellcheck warnings |
| No regressions | PASS | Existing tests unchanged |

## Breaking Changes

{If any, document migration path}

## Follow-up

- {Suggested improvements}
- {Technical debt items}
```

### Manifest Entry

```json
{"id":"T####-impl-slug","file":"YYYY-MM-DD_implementation.md","title":"Implementation: Feature Name","date":"YYYY-MM-DD","status":"complete","agent_type":"implementation","topics":["implementation","feature"],"key_findings":["3 functions added","Tests passing","No breaking changes"],"actionable":false,"needs_followup":[],"linked_tasks":["T####"]}
```

---

## Integration Points

### Base Protocol

- Inherits task lifecycle (focus, execute, complete)
- Inherits manifest append requirement
- Inherits error handling patterns

### Protocol Interactions

| Combined With | Behavior |
|---------------|----------|
| specification | Spec defines implementation requirements |
| contribution | Implementation triggers contribution record |
| release | Implementation changes tracked for release |

### Workflow Sequence

```
1. Read task requirements (cleo show T####)
2. Set focus (cleo focus set T####)
3. Implement changes with provenance tags
4. Write/update tests
5. Run validation (tests, lint)
6. Document changes in output file
7. Append manifest entry
8. Complete task (cleo complete T####)
9. Return completion message
```

---

## Example

**Task**: Implement session binding for multi-agent support

**Manifest Entry**:
```json
{"id":"T2400-session-binding","file":"2026-01-26_session-binding-impl.md","title":"Implementation: Session Binding","date":"2026-01-26","status":"complete","agent_type":"implementation","topics":["session","binding","multi-agent"],"key_findings":["TTY binding implemented","Env var fallback added","4 new tests passing"],"actionable":false,"needs_followup":[],"linked_tasks":["T2400","T2392"]}
```

**Return Message**:
```
Implementation complete. See MANIFEST.jsonl for summary.
```

---

## Provenance Validation

### Pre-Commit Hook

**Location**: `.git/hooks/commit-msg` (installed via `git config core.hooksPath .cleo/hooks`)

**Logic**:
1. Extract @task tags from commit diff
2. Count new functions/classes
3. Calculate provenance coverage
4. Apply thresholds:
   - **New code**: 100% coverage required
   - **Existing code**: 80% coverage required
   - **Legacy code**: 50% coverage required
5. Block commit if thresholds not met

**Exit Code**: `EXIT_PROTOCOL_IMPLEMENTATION` (64) on violation

### Runtime Validation

**Command** (planned): `cleo provenance validate [--task TASK_ID]`

**Current State**: Validation available via protocol library

```bash
# Programmatic validation
source lib/protocol-validation.sh
result=$(validate_implementation_protocol "T1234" "$manifest_entry" "false")
```

**Checks**:
- IMPL-003: `@task T####` tags in new functions
- Git diff analysis for provenance coverage
- Agent type = "implementation" (IMPL-007)

### Thresholds

| Code Category | Provenance Requirement | Rationale |
|---------------|------------------------|-----------|
| **New code** | 100% | Fresh code must be attributable |
| **Existing code** | 80% | Modifications should track origin |
| **Legacy code** | 50% | Gradual attribution improvement |

**Detection**:
- New code: Lines with `^+` in git diff, no prior history
- Existing code: Modified files with prior commits
- Legacy code: Files >6 months old or >100 commits

### Enforcement Points

1. **Pre-commit**: Blocks commits lacking provenance
2. **Pre-push**: Warns on aggregate provenance score <70%
3. **Runtime**: `cleo complete` validates IMPL-003 for implementation tasks
4. **Orchestrator**: Validates before spawning implementation agents

---

## Anti-Patterns

| Pattern | Why Avoid |
|---------|-----------|
| Code without tests | Regression risk |
| Missing provenance | Lost attribution |
| Skipping validation | Quality regression |
| Undocumented breaking changes | Surprise failures |
| No error handling | Silent failures |
| Hardcoded values | Maintenance burden |

---

*Protocol Version 1.0.0 - Implementation Protocol*
