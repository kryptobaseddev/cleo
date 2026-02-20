# P0-1: Race Condition - Task ID Collision Under Concurrent Load

**Status**: PARTIALLY FIXED - Requires Architectural Change
**Priority**: P0 (Critical)
**Discovered**: 2025-12-12
**Last Updated**: 2025-12-13

---

## Executive Summary

File locking infrastructure has been added to prevent data corruption, but **task ID generation is not atomic**. Under concurrent load, multiple processes can generate the same task ID, resulting in data loss.

---

## Problem Description

### Original Issue
The COMPREHENSIVE-FIX-GUIDE.md reported that concurrent task additions resulted in 90% data loss (5 concurrent adds → only 1 task survives).

### Current State After Partial Fix
- **File locking**: ✅ Implemented via `lib/file-ops.sh`
- **Data corruption**: ✅ Prevented (JSON files remain valid)
- **ID collision**: ❌ Still occurs under concurrent load

### Test Results

```bash
# Test: 5 concurrent task additions
for i in {1..5}; do claude-todo add "Concurrent $i" & done; wait

# Result:
# - All 5 processes generate the same ID (T006)
# - All 5 report success
# - Only 1 task actually saved (80% data loss)
```

**Evidence**:
```
[INFO] Generated task ID: T006
[INFO] Generated task ID: T006
[INFO] Generated task ID: T006
[INFO] Generated task ID: T006
[INFO] Generated task ID: T006
[INFO] Task added successfully (5 times)

Tasks created: 1 (expected: 5)
```

---

## Root Cause Analysis

### Current Flow (Problematic)

```
Process A                    Process B
---------                    ---------
1. Read todo.json            1. Read todo.json
   (sees 5 tasks)               (sees 5 tasks)

2. Generate ID: T006         2. Generate ID: T006
   (max existing + 1)           (max existing + 1)

3. Request lock              3. Request lock
   (acquired)                   (waiting...)

4. Write task T006
5. Release lock
                             3. Lock acquired
                             4. Write task T006 (OVERWRITES!)
                             5. Release lock
```

### Why This Happens

The `generate_task_id()` function in `scripts/add-task.sh`:

```bash
generate_task_id() {
  local max_id
  max_id=$(jq -r '.tasks | map(.id | ltrimstr("T") | tonumber) | max // 0' "$TODO_FILE" 2>/dev/null)
  printf "T%03d" $((max_id + 1))
}
```

This reads the file **before** acquiring the lock, so multiple processes see the same state and generate the same ID.

---

## Required Fix

### Solution: Atomic ID Generation

ID generation must occur **inside** the locked critical section:

```bash
add_task_atomic() {
    local title="$1"
    local lock_fd=""

    # 1. Acquire exclusive lock FIRST
    if ! lock_file "$TODO_FILE" lock_fd 30; then
        log_error "Could not acquire lock"
        return 1
    fi

    # 2. Read file (now guaranteed to be current)
    local current_data
    current_data=$(cat "$TODO_FILE")

    # 3. Generate ID (atomic - no one else can read/write)
    local max_id
    max_id=$(echo "$current_data" | jq -r '.tasks | map(.id | ltrimstr("T") | tonumber) | max // 0')
    local new_id
    new_id=$(printf "T%03d" $((max_id + 1)))

    # 4. Create and add task
    local new_task
    new_task=$(jq -n --arg id "$new_id" --arg title "$title" '{id: $id, title: $title, status: "pending"}')

    local updated_data
    updated_data=$(echo "$current_data" | jq --argjson task "$new_task" '.tasks += [$task]')

    # 5. Write atomically
    echo "$updated_data" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"

    # 6. Release lock
    unlock_file "$lock_fd"

    echo "$new_id"
}
```

### Files Requiring Modification

| File | Change Required |
|------|-----------------|
| `scripts/add-task.sh` | Move ID generation inside locked section |
| `lib/file-ops.sh` | Add `with_lock()` wrapper function for convenience |

### Alternative Solutions

1. **UUID-based IDs**: Use UUIDs instead of sequential IDs (no collision possible)
   - Pro: No locking needed for ID generation
   - Con: Less human-readable, breaks existing ID format

2. **Timestamp-based IDs**: Use `T_{timestamp}_{random}` format
   - Pro: Near-zero collision probability
   - Con: Non-sequential, harder to reference

3. **File-based counter**: Separate counter file with its own lock
   - Pro: Simpler than restructuring add-task.sh
   - Con: Additional file to manage

---

## Impact Assessment

### Who Is Affected

| Use Case | Affected | Severity |
|----------|----------|----------|
| Single user, sequential | No | N/A |
| Single user, tabs/windows | Rare | Low |
| CI/CD pipelines | Yes | High |
| Multiple Claude agents | Yes | Critical |
| Automated scripts | Yes | High |

### Data Loss Scenarios

1. **Parallel task creation**: Only last write survives
2. **Automated imports**: Bulk operations fail silently
3. **Multi-agent workflows**: Agents clobber each other's work

---

## Temporary Workarounds

Until the fix is implemented:

### 1. Sequential Operations
```bash
# Instead of parallel:
# for task in tasks; do claude-todo add "$task" & done

# Use sequential:
for task in tasks; do claude-todo add "$task"; done
```

### 2. External Locking
```bash
# Use flock externally
(
  flock -x 200
  claude-todo add "Task 1"
  claude-todo add "Task 2"
) 200>.claude/.external.lock
```

### 3. Retry with Verification
```bash
add_task_verified() {
    local title="$1"
    local id
    id=$(claude-todo add "$title" 2>&1 | grep "Task ID:" | awk '{print $3}')

    # Verify task exists
    if ! claude-todo list --format json | jq -e --arg id "$id" '.tasks[] | select(.id == $id)' >/dev/null; then
        echo "Task creation failed, retrying..."
        add_task_verified "$title"
    fi
}
```

---

## Testing Requirements

### Unit Tests
```bash
# Test atomic ID generation
test_atomic_id_generation() {
    init_test_env

    # Create 10 tasks concurrently
    for i in {1..10}; do
        claude-todo add "Concurrent $i" &
    done
    wait

    # Verify all 10 exist with unique IDs
    count=$(claude-todo list --format json | jq '.tasks | length')
    unique_ids=$(claude-todo list --format json | jq '.tasks | map(.id) | unique | length')

    assert_equals 10 "$count" "Should have 10 tasks"
    assert_equals 10 "$unique_ids" "Should have 10 unique IDs"
}
```

### Integration Tests
```bash
# Stress test with higher concurrency
test_high_concurrency() {
    for i in {1..50}; do
        claude-todo add "Stress $i" &
    done
    wait

    count=$(claude-todo list --format json | jq '.tasks | length')
    assert_equals 50 "$count"
}
```

---

## Implementation Plan

### Phase 1: Preparation
- [ ] Create feature branch `fix/atomic-id-generation`
- [ ] Add failing tests for concurrent operations
- [ ] Document current behavior

### Phase 2: Implementation
- [ ] Add `with_lock()` helper to `lib/file-ops.sh`
- [ ] Refactor `add-task.sh` to use atomic pattern
- [ ] Update `update-task.sh` for consistency
- [ ] Update `complete-task.sh` for consistency

### Phase 3: Verification
- [ ] Run concurrent operation tests
- [ ] Run full regression suite
- [ ] Performance benchmarking

### Phase 4: Release
- [ ] Update CHANGELOG.md
- [ ] Bump version to 0.8.4
- [ ] Create release notes

---

## References

- **Original Report**: `claudedocs/COMPREHENSIVE-FIX-GUIDE.md` (P0-1)
- **File Locking Implementation**: `lib/file-ops.sh` (lines 81-153)
- **Current ID Generation**: `scripts/add-task.sh` (generate_task_id function)
- **Test Fixtures**: `tests/fixtures/critical-path/`

---

## Appendix: Current File Locking Code

### lib/file-ops.sh - lock_file()
```bash
lock_file() {
    local file="$1"
    local fd_var="${2:-LOCK_FD}"
    local timeout="${3:-30}"

    local lock_file="${file}${LOCK_SUFFIX}"
    touch "$lock_file"

    for fd in {200..210}; do
        if ! { true >&"$fd"; } 2>/dev/null; then
            eval "exec $fd>'$lock_file'"
            if flock -w "$timeout" "$fd"; then
                eval "$fd_var=$fd"
                return 0
            fi
        fi
    done

    return 1
}
```

### lib/file-ops.sh - save_json()
```bash
save_json() {
    local file="$1"
    local json="${2:-$(cat)}"

    # Validates and pretty-prints, uses atomic_write (which has locking)
    echo "$json" | jq '.' | atomic_write "$file"
}
```

---

*Document created as part of the v0.8.3 comprehensive fix effort*
