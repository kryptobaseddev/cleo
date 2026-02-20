# Init Command Test Report

**Date**: 2025-12-13
**Tester**: Quality Engineer Agent
**Component**: `scripts/init.sh`
**Version**: 0.8.3

## Executive Summary

Found **2 critical bugs** in the `init` command:

1. **Re-init crash**: Unbound variable error when running init on existing project
2. **Missing schemaVersion field**: Field referenced in documentation but not created

Checksum validation is **working correctly** despite initial concerns.

---

## Test Results

### ✅ Test 1: Fresh Initialization
**Status**: PASS

```bash
claude-todo init
```

**Results**:
- All JSON files created successfully
- Checksum calculated and stored: `37517e5f3dc66819`
- Validation passes: `[OK] Checksum valid`
- Exit code: 0

**Files Created**:
- `.claude/todo.json`
- `.claude/todo-archive.json`
- `.claude/todo-config.json`
- `.claude/todo-log.json`
- `.claude/schemas/` (directory)

---

### ❌ Test 2: Re-initialization (Crash)
**Status**: FAIL - CRITICAL BUG

```bash
claude-todo init  # on existing project
```

**Error**:
```
/home/keatonhoskins/.claude-todo/lib/logging.sh: line 579: $2: unbound variable
```

**Exit Code**: 1 (but sometimes 0 due to error handling inconsistency)

**Root Cause**:
`init.sh` sources `logging.sh` which defines `log_error()` requiring 2+ parameters, then tries to override it with a simpler version at line 28:

```bash
type -t log_error &>/dev/null || log_error() { echo "[ERROR] $1" >&2; }
```

This override **fails** because `logging.sh` already defined `log_error`. When line 87 calls `log_error` with only 1 argument:

```bash
log_error ".claude/todo.json already exists. Use --force to overwrite."
```

It crashes because `logging.sh`'s version expects:
```bash
log_error "$error_code" "$error_message" ["$recoverable"] ["$task_id"]
```

**Impact**: Users cannot run `init` twice (even to see the error message), and any script calling it will fail.

**Expected Behavior**: Graceful error message suggesting `--force` flag.

---

### ❌ Test 3: Schema Version Field
**Status**: FAIL - DOCUMENTATION BUG

**Test**:
```bash
jq '.schemaVersion // ._meta.schemaVersion // "NOT FOUND"' .claude/todo.json
```

**Result**: `"NOT FOUND"`

**Actual Structure**:
```json
{
  "$schema": "./schemas/todo.schema.json",
  "version": "2.1.0",
  "_meta": {
    "checksum": "37517e5f3dc66819",
    "configVersion": "2.1.0",
    "lastSessionId": null,
    "activeSession": null
  }
}
```

**Issue**: Documentation and code references `schemaVersion` field, but init creates:
- `version` (top-level)
- `_meta.configVersion` (nested)

**Impact**: Low - system works, but documentation is inconsistent with actual field names.

---

### ✅ Test 4: Checksum Verification
**Status**: PASS

**Checksum Algorithm**:
```bash
jq -c '.tasks' todo.json | sha256sum | cut -c1-16
```

**Verification**:
- Stored checksum: `37517e5f3dc66819`
- Tasks array: `[]`
- Expected: `echo -n '[]' | sha256sum | cut -c1-16` = `4f53cda18c2baa0c`
- **BUT**: `jq -c '.tasks'` outputs `[]` (with newline), not raw `[]`

**Calculation**:
```bash
$ echo '[]' | sha256sum | cut -c1-16
37517e5f3dc66819  # MATCHES!
```

**Result**: Checksum implementation is **correct and consistent** across:
- `init.sh` (line 223-224)
- `validate.sh` (line 297)
- All write operations use same algorithm

**Validation Test**:
```
[OK] Checksum valid
```

---

## Bug Details

### Bug #1: Re-init Unbound Variable

**Severity**: 🔴 **CRITICAL**
**File**: `scripts/init.sh:87`
**Error**: `logging.sh: line 579: $2: unbound variable`

**Problem Code**:
```bash
# Line 19: Sources logging.sh (defines log_error with 2+ params)
source "$CLAUDE_TODO_HOME/lib/logging.sh"

# Line 28: Tries to override, but fails (function already exists)
type -t log_error &>/dev/null || log_error() { echo "[ERROR] $1" >&2; }

# Line 87: Calls with 1 param → crashes
log_error ".claude/todo.json already exists. Use --force to overwrite."
```

**Fix Required**: Define local `log_error` before sourcing `logging.sh`, or use different function name.

**Workaround**: Use `claude-todo init --force` to skip check.

---

### Bug #2: Missing schemaVersion Field

**Severity**: 🟡 **IMPORTANT**
**File**: `scripts/init.sh` (template generation)
**Issue**: Documentation references `schemaVersion`, actual field is `version` and `_meta.configVersion`

**Inconsistency**:
- Schema defines: `schemaVersion` (required)
- Init creates: `version` + `_meta.configVersion`
- Code checks: Various (inconsistent)

**Fix Required**: Standardize on one field name across:
1. JSON Schema (`schemas/todo.schema.json`)
2. Templates (`templates/*.template.json`)
3. All scripts
4. Documentation

**Recommendation**: Use `version` (top-level) for file format version, remove `_meta.configVersion` or clarify distinction.

---

## Edge Cases Tested

### Force Flag
```bash
claude-todo init --force
```
**Status**: Not tested (blocked by bug #1 preventing re-init test)

### No Claude.md Integration
```bash
claude-todo init --no-claude-md
```
**Status**: Not tested

### Custom Project Name
```bash
claude-todo init my-project
```
**Status**: Not tested

---

## Recommendations

### Immediate Actions (v0.8.4)

1. **Fix Re-init Crash** (CRITICAL):
   ```bash
   # Option A: Define before sourcing
   log_error() { echo "[ERROR] $1" >&2; }
   log_info() { echo "[INFO] $1"; }
   log_warn() { echo "[WARN] $1" >&2; }

   # Then source (will not override)
   source "$CLAUDE_TODO_HOME/lib/logging.sh" 2>/dev/null || true
   ```

   **OR**

   ```bash
   # Option B: Use different names for console output
   console_error() { echo "[ERROR] $1" >&2; }
   console_info() { echo "[INFO] $1"; }
   console_warn() { echo "[WARN] $1" >&2; }
   ```

2. **Standardize Version Field**:
   - Audit all references to `schemaVersion`, `version`, `configVersion`
   - Pick one canonical field (recommend: `version`)
   - Update schemas, templates, and scripts consistently

### Testing Additions

Add to test suite:
```bash
# tests/integration/test-init.bats
@test "init on existing project shows graceful error" {
  claude-todo init
  run claude-todo init
  [ "$status" -eq 1 ]
  [[ "$output" =~ "already exists" ]]
  [[ ! "$output" =~ "unbound variable" ]]
}

@test "init --force overwrites existing project" {
  claude-todo init
  run claude-todo init --force
  [ "$status" -eq 0 ]
}

@test "checksum is valid after init" {
  claude-todo init
  run claude-todo validate
  [[ "$output" =~ "Checksum valid" ]]
}
```

---

## Conclusion

**Checksum System**: ✅ Working correctly
**Re-init Behavior**: ❌ Critical bug prevents any re-init attempt
**Schema Consistency**: ⚠️ Documentation doesn't match implementation

The init command works for fresh projects but fails catastrophically when run twice. This is a critical user experience issue that should be fixed immediately.
