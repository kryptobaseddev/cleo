# File Locking Implementation Analysis

## Scripts That Modify JSON Files

| Script | Modifies Files | Has Locking | Status | Priority |
|--------|----------------|-------------|--------|----------|
| add-task.sh | ✅ todo.json, log.json | ❌ Local only | VULNERABLE | P0 |
| update-task.sh | ✅ todo.json, log.json | ❌ Local only | VULNERABLE | P0 |
| complete-task.sh | ✅ todo.json, archive.json, log.json | ❌ None | VULNERABLE | P0 |
| archive.sh | ✅ todo.json, archive.json, log.json | ❌ None | VULNERABLE | P1 |
| focus.sh | ✅ todo.json, config.json, log.json | ❌ None | VULNERABLE | P1 |
| session.sh | ✅ config.json, log.json | ❌ None | VULNERABLE | P1 |
| log.sh | ✅ log.json | ❌ None | VULNERABLE | P2 |
| migrate.sh | ✅ All JSON files | ❌ None | VULNERABLE | P1 |
| init.sh | ✅ All JSON files (create) | ❌ None | LOW (one-time) | P2 |

## Read-Only Scripts (No Locking Needed)

| Script | Operations |
|--------|------------|
| list-tasks.sh | Read only |
| stats.sh | Read only |
| validate.sh | Read only |
| dash.sh | Read only |
| labels.sh | Read only |
| next.sh | Read only |
| deps-command.sh | Read only |
| blockers-command.sh | Read only |
| export.sh | Read only |
| backup.sh | File copy operations |
| restore.sh | File copy operations |

## Key Findings

### 1. Local atomic_write() Functions
Both `add-task.sh` and `update-task.sh` have their own local `atomic_write()` functions that do NOT use file locking:

```bash
# add-task.sh line 259
atomic_write() {
  local file="$1"
  local content="$2"
  # ... no locking ...
  echo "$content" > "$temp_file"
  mv "$temp_file" "$file"
}
```

### 2. Library Functions Available But Not Used
The `lib/file-ops.sh` library provides:
- `lock_file()` - Acquire exclusive lock with flock
- `unlock_file()` - Release lock
- `atomic_write()` - Atomic write WITH locking (if implemented)

**Problem:** Scripts use local implementations instead of library functions.

### 3. Race Condition Scenarios

**High Risk (Concurrent writes):**
- Multiple `add` operations simultaneously
- Multiple `update` operations on different tasks
- `complete` + `update` on same task
- `archive` during active task operations

**Medium Risk (Sequential but rapid):**
- Scripted batch operations
- CI/CD pipeline operations
- Migration operations

### 4. File Lock Implementation in lib/file-ops.sh

The library has proper flock-based locking:
- Uses file descriptors (200-210 range)
- 30-second timeout (configurable)
- Proper cleanup on errors
- Multiple concurrent lock support

**But it's not being used by any write scripts.**

## Fix Strategy

### Phase 1: Critical Scripts (P0)
Fix scripts with highest concurrency risk:

1. **add-task.sh**
   - Remove local `atomic_write()`
   - Source `lib/file-ops.sh`
   - Use library lock functions
   - Wrap all JSON writes in lock/unlock

2. **update-task.sh**
   - Same pattern as add-task.sh

3. **complete-task.sh**
   - Add file-ops.sh sourcing
   - Implement locking for todo.json and archive.json writes

### Phase 2: Important Scripts (P1)
4. **archive.sh** - Batch operations need locking
5. **focus.sh** - Config changes need locking
6. **session.sh** - Config changes need locking
7. **migrate.sh** - Critical data transformation needs locking

### Phase 3: Lower Priority (P2)
8. **log.sh** - Append-only, lower risk but still needs locking
9. **init.sh** - One-time operation, low concurrency risk

## Implementation Pattern

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source file operations library
if [[ -f "$LIB_DIR/file-ops.sh" ]]; then
    source "$LIB_DIR/file-ops.sh"
else
    echo "ERROR: Cannot find file-ops.sh" >&2
    exit 1
fi

# Acquire lock
if ! lock_file "$TODO_FILE"; then
    echo "ERROR: Could not acquire lock on $TODO_FILE" >&2
    exit 8
fi

# Critical section - file operations
trap 'unlock_file' EXIT INT TERM

# ... perform operations ...

# Lock released by trap on exit
```

## Testing Requirements

After implementing locking, verify:

1. **Concurrent operations:**
   ```bash
   for i in {1..10}; do claude-todo add "Task-$i" & done; wait
   # Should create exactly 10 tasks
   ```

2. **Lock timeout:**
   ```bash
   # Hold lock artificially, verify timeout works
   ```

3. **Error handling:**
   ```bash
   # Kill process mid-write, verify lock cleanup
   ```

4. **Performance:**
   ```bash
   # Measure latency impact of locking
   ```

---

**Priority:** P0 - CRITICAL
**Impact:** Data corruption, task loss, production failures
**Effort:** Medium (pattern-based fix across multiple scripts)
**Risk:** Low (library functions already tested)
