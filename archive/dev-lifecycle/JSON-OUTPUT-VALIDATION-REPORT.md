# JSON OUTPUT STRUCTURE VALIDATION REPORT

**Test Date**: 2025-12-13 06:50 UTC
**Project**: claude-todo
**Branch**: fix/archive-atomic-operations
**Version**: 0.8.2

## Objective

Verify that all commands supporting `--format json` have:
1. Valid JSON output
2. Consistent `_meta` envelope structure
3. `_meta.format` field indicating output format

## Test Methodology

Created test environment with sample tasks and executed all commands with `--format json` option. Validated JSON structure, checked for `_meta` envelope presence, and verified `_meta.format` field.

## Findings

### ✓ claude-todo list --format json

| Check | Status |
|-------|--------|
| Valid JSON | ✓ PASS |
| Has _meta envelope | ✓ PASS |
| _meta.format field | ✗ MISSING |

**_meta structure:**
```json
{
  "version": "0.8.2",
  "command": "list",
  "timestamp": "2025-12-13T06:50:34Z",
  "checksum": "9132a0d0e16beac8",
  "execution_ms": 31
}
```

**Issue**: `_meta.format` field missing (should be "json")

---

### ✓ claude-todo dash --format json

| Check | Status |
|-------|--------|
| Valid JSON | ✓ PASS |
| Has _meta envelope | ✓ PASS |
| _meta.format field | ✗ MISSING |

**_meta structure:**
```json
{
  "version": "0.8.0",
  "command": "dash",
  "timestamp": "2025-12-12T22:50:34-08:00",
  "periodDays": 7
}
```

**Issue**: `_meta.format` field missing (should be "json")

---

### ✓ claude-todo next --format json

| Check | Status |
|-------|--------|
| Valid JSON | ✓ PASS |
| Has _meta envelope | ✓ PASS |
| _meta.format field | ✗ MISSING |

**_meta structure:**
```json
{
  "version": "0.8.0",
  "command": "next",
  "timestamp": "2025-12-13T06:50:34Z"
}
```

**Issue**: `_meta.format` field missing (should be "json")

---

### ✓ claude-todo labels --format json

| Check | Status |
|-------|--------|
| Valid JSON | ✓ PASS |
| Has _meta envelope | ✓ PASS |
| _meta.format field | ✗ MISSING |

**_meta structure:**
```json
{
  "version": "0.8.0",
  "command": "labels",
  "timestamp": "2025-12-13T06:50:34Z"
}
```

**Issue**: `_meta.format` field missing (should be "json")

---

### ✓ claude-todo stats --format json

| Check | Status |
|-------|--------|
| Valid JSON | ✓ PASS |
| Has _meta envelope | ✓ PASS |
| _meta.format field | ✗ MISSING |

**_meta structure:**
```json
{
  "version": "0.8.2",
  "command": "stats",
  "timestamp": "2025-12-13T06:50:34Z",
  "period_days": 30
}
```

**Issue**: `_meta.format` field missing (should be "json")

---

### ✗ claude-todo export --format json

| Check | Status |
|-------|--------|
| Valid JSON | ✗ FAIL (log prefix) |
| Has _meta envelope | N/A |
| _meta.format field | N/A |

**Output sample:**
```
[EXPORT] Format: json, Status: pending,active, Found: 2 tasks
[
  {
    "id": "T001",
    "title": "Test task 1",
    ...
  }
]
```

**Issues**:
- Log message prefixed to JSON output breaks parsing
- Should suppress logging in JSON mode or use stderr
- Missing `_meta` envelope (uses raw array format)

---

### ✗ claude-todo validate --format json

| Check | Status |
|-------|--------|
| Supported | ✗ NO |

**Error**: `Unknown option: --format`

**Issue**: validate command does not support `--format json` option

---

## Summary

| Metric | Result |
|--------|--------|
| Commands Tested | 7 |
| Valid JSON | 5/7 (71%) |
| Has _meta envelope | 5/7 (71%) |
| Has _meta.format | 0/7 (0%) |

## Critical Issues

### 1. Missing _meta.format Field (5 commands)

**Affected**: list, dash, next, labels, stats

**Impact**:
- Programmatic format detection impossible
- Cannot determine output format from response alone
- Inconsistent metadata across commands

**Expected behavior**:
```json
{
  "_meta": {
    "version": "0.8.2",
    "command": "list",
    "format": "json",        // ← MISSING
    "timestamp": "2025-12-13T06:50:34Z"
  }
}
```

### 2. Export Command Log Pollution (1 command)

**Affected**: export

**Impact**:
- Breaks JSON parsers expecting pure JSON on stdout
- Cannot pipe output directly to `jq` or other tools
- Requires output filtering before parsing

**Current behavior**:
```bash
$ claude-todo export --format json
[EXPORT] Format: json, Status: pending,active, Found: 2 tasks
[{"id":"T001",...}]
```

**Expected behavior** (Option A - stderr):
```bash
$ claude-todo export --format json 2>/dev/null
[{"id":"T001",...}]
```

**Expected behavior** (Option B - suppress):
```bash
$ claude-todo export --format json
[{"id":"T001",...}]
```

### 3. Validate Command No JSON Support (1 command)

**Affected**: validate

**Impact**:
- Inconsistent with other commands
- Cannot automate validation checks with JSON parsing
- Manual output parsing required for CI/CD

**Expected behavior**:
```bash
$ claude-todo validate --format json
{
  "_meta": {
    "version": "0.8.2",
    "command": "validate",
    "format": "json",
    "timestamp": "2025-12-13T06:50:34Z"
  },
  "valid": true,
  "files": [
    {"file": "todo.json", "valid": true, "errors": []},
    {"file": "todo-archive.json", "valid": true, "errors": []}
  ]
}
```

## Recommendations

### Priority 1: Add _meta.format field

**Affected files**:
- `/mnt/projects/claude-todo/scripts/list-tasks.sh`
- `/mnt/projects/claude-todo/scripts/dash.sh`
- `/mnt/projects/claude-todo/scripts/next.sh`
- `/mnt/projects/claude-todo/scripts/labels.sh`
- `/mnt/projects/claude-todo/scripts/stats.sh`

**Implementation**:
```bash
# In each script's JSON output section, add:
"format": "$FORMAT"
```

### Priority 2: Fix export command logging

**Affected file**: `/mnt/projects/claude-todo/scripts/export.sh`

**Option A** (recommended): Send logs to stderr
```bash
echo "[EXPORT] Format: $format, Status: $status, Found: $count tasks" >&2
```

**Option B**: Suppress logs in JSON mode
```bash
if [[ "$FORMAT" != "json" ]]; then
    echo "[EXPORT] Format: $format, Status: $status, Found: $count tasks"
fi
```

### Priority 3: Add JSON support to validate

**Affected file**: `/mnt/projects/claude-todo/scripts/validate.sh`

**Implementation**: Follow pattern from `list-tasks.sh` for consistency

## Test Artifacts

Test environment:
- Temporary directory: `/tmp/json-test-*`
- Sample tasks: 3 tasks with various priorities and labels
- Test scripts: `/tmp/test-json-formats.sh`, `/tmp/analyze-json-structure.sh`

## Next Steps

1. Create tasks for each critical issue
2. Implement `_meta.format` field in all commands
3. Fix export command log pollution
4. Add JSON support to validate command
5. Update documentation with `_meta.format` field usage
6. Add integration tests for JSON format consistency
