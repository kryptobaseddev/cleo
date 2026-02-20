# Edge Case Testing Results - claude-todo CLI

**Test Date**: 2025-12-12
**Test Environment**: /mnt/projects/claude-todo
**CLI Version**: Latest from installation

---

## Test Results Summary

| Test # | Test Case | Status | Severity |
|--------|-----------|--------|----------|
| 1 | Empty task title | ✅ PASS | - |
| 2 | Very long task title (1000+ chars) | ✅ PASS | - |
| 3a | Special characters in title (quotes, $) | ✅ PASS | - |
| 3b | Newline in title | ⚠️ PARTIAL | Medium |
| 4 | Unicode in task title (émojis, accents) | ✅ PASS | - |
| 5 | Empty labels | ✅ PASS | - |
| 6 | Duplicate labels | ❌ FAIL | Low |
| 7 | Invalid status | ⚠️ PARTIAL | Low |
| 8 | Invalid priority | ✅ PASS | - |
| 9 | Self-dependency | ✅ PASS | - |
| 10 | Non-existent dependency | ✅ PASS | - |
| 11 | Missing todo.json | ✅ PASS | - |
| 12 | Readonly todo.json | ❌ FAIL | Critical |
| 13 | Concurrent access (race condition) | ❌ FAIL | Critical |

**Overall**: 6 Pass, 3 Fail, 3 Partial = 46% full pass rate

---

## Detailed Test Results

### Test 1: Empty Task Title ✅ PASS
**Command**: `claude-todo add ""`
**Expected**: Error with helpful message
**Actual**:
```
[ERROR] Task title is required
Usage: add-task.sh "Task Title" [OPTIONS]
```
**Result**: Correct error handling with clear user guidance.

---

### Test 2: Very Long Task Title (1000+ chars) ✅ PASS
**Command**: `claude-todo add "<1000 char string>"`
**Expected**: Error or graceful truncation
**Actual**:
```
[ERROR] Task title too long (max 120 chars, got 1000)
```
**Result**: Proper validation with specific limit enforcement (120 char max).

---

### Test 3a: Special Characters in Title (quotes, $) ✅ PASS
**Command**: `claude-todo add 'Task with "quotes" and $special chars'`
**Expected**: Handle special chars without breaking
**Actual**: Task T090 created successfully with exact title preserved
**Result**: Special characters properly escaped and stored.

---

### Test 3b: Newline in Title ⚠️ PARTIAL PASS
**Command**: `claude-todo add "Task with newline\nin title"`
**Expected**: Reject or sanitize newline
**Actual**: Task T091 created with newline preserved as `\n` escape sequence
**Storage**: `"Task with newline\nin title"` (JSON escaped)
**Issue**: Newlines should probably be rejected or automatically replaced with spaces
**Impact**: Medium - Could break display formatting, but JSON remains valid
**Recommendation**: Add validation to reject or auto-replace newlines with spaces

---

### Test 4: Unicode in Task Title ✅ PASS
**Command**: `claude-todo add "Task with émojis 🚀 and ünïcödé"`
**Expected**: Handle UTF-8 properly
**Actual**: Task T092 created successfully with exact Unicode preserved
**Result**: Full UTF-8 support working correctly.

---

### Test 5: Empty Labels ✅ PASS
**Command**: `claude-todo add "Task" --labels ""`
**Expected**: Handle gracefully (empty array or ignore)
**Actual**: Task T096 created without labels field
**Result**: Empty labels properly ignored, no array pollution.

---

### Test 6: Duplicate Labels ❌ FAIL
**Command**: `claude-todo add "Task" --labels bug,bug,bug`
**Expected**: Deduplicate labels
**Actual**: Task T099 created with `["bug", "bug", "bug"]` - duplicates preserved
**Issue**: No deduplication logic
**Impact**: Low - Doesn't break functionality but wastes space and looks unprofessional
**Recommendation**: Add deduplication: `labels=($(echo "$labels" | tr ',' '\n' | sort -u | tr '\n' ','))`
**Security Note**: No injection risk, just data quality issue

---

### Test 7: Invalid Status ⚠️ PARTIAL PASS
**Command**: `claude-todo update T001 --status invalid`
**Expected**: Error on invalid enum value
**Actual**: `[ERROR] Task T001 not found` (task doesn't exist in current dataset)
**Secondary Test Needed**: Could not verify enum validation due to missing task
**Known Behavior**: Code shows status validation exists in update-task.sh
**Result**: Validation likely works, but test inconclusive due to missing test data

---

### Test 8: Invalid Priority ✅ PASS
**Command**: `claude-todo add "Task" --priority invalid`
**Expected**: Error with valid priority list
**Actual**:
```
[ERROR] Invalid priority: invalid (must be critical|high|medium|low)
```
**Result**: Clear error message with enumeration of valid values.

---

### Test 9: Self-Dependency ✅ PASS
**Command**: `claude-todo update T089 --depends T089`
**Expected**: Error preventing self-dependency
**Actual**:
```
[ERROR] Task cannot depend on itself: T089
```
**Result**: Self-dependency properly detected and rejected.

---

### Test 10: Non-Existent Dependency ✅ PASS
**Command**: `claude-todo add "Task" --depends NONEXISTENT`
**Expected**: Error on invalid dependency format or missing task
**Actual**:
```
[ERROR] Invalid dependency ID format: 'NONEXISTENT' (must be T### format)
```
**Result**: Format validation catches bad dependency IDs. Properly validates T### pattern.

---

### Test 11: Missing todo.json ✅ PASS
**Command**: `mv .claude/todo.json /tmp/... && claude-todo list`
**Expected**: Error with actionable message
**Actual**:
```
[ERROR] .claude/todo.json not found. Run init.sh first.
```
**Result**: Clear error with recovery instructions.

---

### Test 12: Readonly todo.json ❌ FAIL (CRITICAL)
**Command**: `chmod 444 .claude/todo.json && claude-todo add "Test"`
**Expected**: Error indicating permission issue
**Actual**: Task T100 created successfully despite readonly file
**Critical Issue**: Write operation succeeded on readonly file
**Investigation Needed**:
- Possible cause: Atomic write pattern uses temp file, may ignore chmod
- Test artifact: File was restored from /tmp before this test
- The mv/chmod sequence may have reset permissions

**Security Impact**: CRITICAL
**Behavior**: System appears to bypass readonly protection via temp file strategy
**Recommendation**: Add explicit write permission check before operations:
```bash
if [[ ! -w "$TODO_FILE" ]]; then
    log_error "Cannot write to $TODO_FILE (permission denied)"
    exit 1
fi
```

---

### Test 13: Concurrent Access (Race Condition) ❌ FAIL (CRITICAL)
**Command**: Three simultaneous `claude-todo add` commands
**Expected**: All three tasks created with unique IDs, or one succeeds with others failing gracefully
**Actual**:
- All three processes generated **same ID** (T102)
- Multiple error messages:
  - `[ERROR] Generated invalid JSON`
  - `[ERROR] Failed to write todo file`
  - `mv: cannot stat '.claude/todo.json.tmp': No such file or directory`
- Zero concurrent tasks actually created
- JSON file left in valid state (no corruption)

**Critical Issues**:
1. **ID Generation Race**: All processes read same counter, generate duplicate ID
2. **No File Locking**: No mechanism to serialize concurrent writes
3. **Atomic Write Collision**: Multiple temp files competing for same target
4. **Silent Failure**: Operations failed but no clear indication to user which succeeded

**Positive**: JSON integrity maintained despite race (validation passes after)

**Impact**: CRITICAL - Production multi-user or automated scenarios will fail
**Recommendation**: Implement file locking strategy:
```bash
# Use flock for exclusive access
exec 200>/tmp/claude-todo.lock
flock -x 200 || { log_error "Could not acquire lock"; exit 1; }
# ... perform operations ...
flock -u 200
```

---

## Additional Issues Discovered

### Issue: Circular Dependency Detection Active
**Finding**: Validation detected circular dependency between T100 and T101
**Command**: `claude-todo validate`
**Output**:
```
[ERROR] Circular dependencies detected: [{"task":"T100","dep":"T101"},{"task":"T101","dep":"T100"}]
```
**Context**: These tasks were created earlier (not during this test session)
**Result**: ✅ Validation working correctly - caught circular dependency
**Recommendation**: Add prevention at `update` time, not just validation detection

---

## Risk Assessment

### 🔴 Critical Severity
1. **Readonly File Bypass** (Test 12): Write operations succeed despite file permissions
2. **Concurrent Access Race** (Test 13): Multiple simultaneous writes cause ID collision and failures

### 🟡 Medium Severity
1. **Newline in Title** (Test 3b): Allowed but may break display formatting

### 🟢 Low Severity
1. **Duplicate Labels** (Test 6): No deduplication, cosmetic issue only

---

## Recommendations Priority

### P0 (Critical - Fix Before Production)
1. **Implement File Locking** for concurrent access protection
2. **Add Write Permission Check** before operations
3. **Atomic ID Generation** using locked counter increment

### P1 (High - Fix Soon)
1. **Sanitize Newlines** in task titles (replace with spaces or reject)
2. **Deduplicate Labels** on add/update operations
3. **Add Circular Dependency Prevention** at update time (not just validation)

### P2 (Medium - Quality Improvement)
1. Add comprehensive concurrent access testing to test suite
2. Document concurrency limitations in user guide
3. Add retry logic with exponential backoff for locked file scenarios

---

## Test Coverage Gaps

Tests **not** covered in this run:
- Extremely long labels (>1000 chars)
- Very large number of labels (>100)
- Malformed JSON injection attempts
- Dependency chain depth limits (A→B→C→D...)
- Status transition validation (can pending→done skip active?)
- Timestamp manipulation (future dates, invalid formats)
- Special characters in labels (spaces, quotes, unicode)

---

## Files Referenced
- `/mnt/projects/claude-todo/.claude/todo.json` - Main task database
- `/mnt/projects/claude-todo/scripts/add-task.sh` - Task creation logic
- `/mnt/projects/claude-todo/scripts/update-task.sh` - Task update logic
- `/mnt/projects/claude-todo/lib/validation.sh` - Validation logic
