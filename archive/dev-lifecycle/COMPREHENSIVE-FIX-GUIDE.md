# COMPREHENSIVE FIX GUIDE - Claude-TODO v0.8.3

**Generated**: 2025-12-12
**Source**: 24-Agent Validation Suite + 2 Consolidation Agents
**Purpose**: Complete remediation guide for all identified issues
**Handoff To**: Implementation Agent

---

## TABLE OF CONTENTS

1. [P0 Critical Bugs (4)](#p0-critical-bugs)
2. [P1 High Priority Bugs (4)](#p1-high-priority-bugs)
3. [P2 Medium Priority Issues (5)](#p2-medium-priority-issues)
4. [P3 Low Priority / Cosmetic (6)](#p3-low-priority-issues)
5. [Verification Checklist](#verification-checklist)

---

## P0 CRITICAL BUGS

These MUST be fixed before any production use. They block core functionality.

---

### P0-1: Race Condition - File Locking Never Called

**Severity**: CRITICAL
**Impact**: 90% data loss under concurrent operations, duplicate task IDs generated
**Test Evidence**: 5 concurrent adds → only 1 task survives

**Root Cause Analysis**:
The file locking functions exist in `lib/file-ops.sh` but are NEVER called by any script.

```bash
# Evidence - locking code exists:
grep -n "lock_file\|unlock_file\|flock" lib/file-ops.sh
# Returns: Functions defined around lines 75-131

# Evidence - never used:
grep -rn "lock_file\|with_lock" scripts/
# Returns: ZERO matches
```

**Files to Modify**:
- `lib/file-ops.sh` - Add locking to atomic write functions

**Fix Implementation**:

```bash
# FILE: lib/file-ops.sh
# LOCATION: Find the write_json_atomic() or safe_write_json() function

# ADD at the beginning of the atomic write function:
write_json_atomic() {
    local file="$1"
    local content="$2"
    local lock_fd=200
    local lock_file="${file}.lock"

    # Acquire exclusive lock with 10 second timeout
    exec 200>"$lock_file"
    if ! flock -w 10 200; then
        log_error "Failed to acquire lock on $file after 10 seconds"
        return 1
    fi

    # ... existing atomic write logic ...
    local temp_file="${file}.tmp.$$"
    echo "$content" > "$temp_file"

    # Validate JSON
    if ! jq empty "$temp_file" 2>/dev/null; then
        rm -f "$temp_file"
        flock -u 200  # Release lock
        log_error "Generated invalid JSON"
        return 1
    fi

    # Backup current file
    if [[ -f "$file" ]]; then
        cp "$file" "${file}.bak"
    fi

    # Atomic rename
    mv "$temp_file" "$file"

    # Release lock
    flock -u 200
    exec 200>&-

    return 0
}
```

**Alternative Fix** (if functions already exist but unused):

```bash
# In each script that writes JSON, wrap the write call:
# FILE: scripts/add-task.sh (and update-task.sh, complete-task.sh, focus.sh, session.sh)

# Find where write_json or similar is called and wrap it:

# BEFORE:
write_json "$TODO_FILE" "$new_content"

# AFTER:
(
    flock -x 200 || { log_error "Lock failed"; exit 1; }
    write_json "$TODO_FILE" "$new_content"
) 200>"${TODO_FILE}.lock"
```

**Verification**:
```bash
# Test concurrent operations
cd /tmp/test-lock && rm -rf .claude && claude-todo init
for i in {1..5}; do claude-todo add "Concurrent $i" & done; wait
claude-todo list --format json | jq '.tasks | length'
# Expected: 5
# Before fix: 1-2
```

---

### P0-2: Log Command Completely Broken

**Severity**: CRITICAL
**Impact**: 0/10 tests passed, entire log command non-functional
**Error**: `LOG_FILE: readonly variable`

**Root Cause Analysis**:
```bash
# scripts/log.sh line 17-18 sets LOG_FILE BEFORE sourcing logging.sh:
LOG_FILE="${LOG_FILE:-.claude/todo-log.json}"
TODO_FILE="${TODO_FILE:-.claude/todo.json}"

# Then sources logging.sh which tries to make it readonly:
source "$LIB_DIR/logging.sh"

# lib/logging.sh line 43 attempts:
readonly LOG_FILE="${CLAUDE_TODO_DIR:-.claude}/todo-log.json"
# FAILS because LOG_FILE is already set (can't make existing var readonly)
```

**Files to Modify**:
- `scripts/log.sh` - Remove lines 17-18 OR reorder sourcing

**Fix Implementation** (Option 1 - RECOMMENDED):

```bash
# FILE: scripts/log.sh
# DELETE or COMMENT OUT lines 17-18:

# REMOVE THESE LINES:
# LOG_FILE="${LOG_FILE:-.claude/todo-log.json}"
# TODO_FILE="${TODO_FILE:-.claude/todo.json}"

# Keep the source statement, let logging.sh handle LOG_FILE:
source "$LIB_DIR/logging.sh"
```

**Fix Implementation** (Option 2 - Alternative):

```bash
# FILE: lib/logging.sh
# CHANGE the readonly declaration to be conditional:

# BEFORE (around line 43):
readonly LOG_FILE="${CLAUDE_TODO_DIR:-.claude}/todo-log.json"

# AFTER:
if [[ -z "${LOG_FILE:-}" ]]; then
    LOG_FILE="${CLAUDE_TODO_DIR:-.claude}/todo-log.json"
fi
# Remove 'readonly' - allow scripts to override if needed
```

**Verification**:
```bash
claude-todo log 2>&1
# Before fix: "LOG_FILE: readonly variable"
# After fix: Shows log entries or "No log entries found"

claude-todo log --action add 2>&1
# Should not error
```

---

### P0-3: Migrate Command Function Name Mismatch

**Severity**: CRITICAL
**Impact**: All schema migrations blocked, cannot upgrade versions
**Error**: `create_backup: command not found`

**Root Cause Analysis**:
```bash
# scripts/migrate.sh calls:
backup_path=$(create_backup "$TODO_FILE" "pre-migration")

# But lib/migrate.sh defines:
backup_file() {
    # ... backup logic
}

# Function names don't match!
```

**Files to Modify**:
- `scripts/migrate.sh` - Fix function call OR
- `lib/migrate.sh` - Rename function

**Fix Implementation** (Option 1 - Fix the call):

```bash
# FILE: scripts/migrate.sh
# Find the line calling create_backup (around line 179)

# BEFORE:
backup_path=$(create_backup "$TODO_FILE" "pre-migration-v$to_version")

# AFTER:
backup_path=$(backup_file "$TODO_FILE")
```

**Fix Implementation** (Option 2 - Add alias function):

```bash
# FILE: lib/migrate.sh
# ADD at the end of the file:

# Alias for backward compatibility
create_backup() {
    backup_file "$@"
}
```

**Verification**:
```bash
# Create old version data
cd /tmp/test-migrate && rm -rf .claude
mkdir -p .claude
echo '{"version": "0.5.0", "tasks": []}' > .claude/todo.json

claude-todo migrate status
# Should show: "Migration available" or similar

claude-todo migrate upgrade
# Before fix: "create_backup: command not found"
# After fix: "Migration complete" or success message
```

---

### P0-4: Init Re-initialization Crashes

**Severity**: CRITICAL
**Impact**: Cannot reinitialize existing projects
**Error**: Unbound variable error

**Root Cause Analysis**:
```bash
# When init.sh runs on existing project:
# 1. It defines simple log functions
# 2. Then sources logging.sh which has complex log functions
# 3. Variable/function conflicts cause unbound variable errors

# The issue is in scripts/init.sh around the logging setup
```

**Files to Modify**:
- `scripts/init.sh` - Add idempotency checks

**Fix Implementation**:

```bash
# FILE: scripts/init.sh
# Find where logging.sh is sourced (early in script)

# ADD BEFORE sourcing logging.sh:

# Unset any existing log functions to prevent conflicts
unset -f log_info log_error log_warn log_debug 2>/dev/null || true

# Check if already initialized
if [[ -f "${CLAUDE_TODO_DIR:-.claude}/todo.json" ]]; then
    REINIT_MODE=true
else
    REINIT_MODE=false
fi

# Source logging library
source "$LIB_DIR/logging.sh"

# If reinitializing, warn user
if [[ "$REINIT_MODE" == "true" ]]; then
    if [[ "${FORCE:-false}" != "true" ]]; then
        echo "[WARN] Project already initialized. Use --force to reinitialize."
        echo "       This will reset configuration but preserve tasks."
        exit 1
    fi
fi
```

**Alternative Fix** (if the issue is in logging.sh):

```bash
# FILE: lib/logging.sh
# ADD at the very beginning:

# Guard against re-sourcing
if [[ "${_LOGGING_SOURCED:-}" == "true" ]]; then
    return 0
fi
_LOGGING_SOURCED=true

# Also ensure variables have defaults:
: "${CLAUDE_TODO_DIR:=.claude}"
: "${LOG_FILE:=${CLAUDE_TODO_DIR}/todo-log.json}"
```

**Verification**:
```bash
cd /tmp/test-reinit && rm -rf .claude
claude-todo init
# Should succeed

claude-todo init
# Before fix: Unbound variable error
# After fix: Warning about existing project OR graceful handling

claude-todo init --force
# Should reinitialize without error
```

---

## P1 HIGH PRIORITY BUGS

These significantly impact usability and should be fixed before release.

---

### P1-1: Newlines in Task Titles Accepted

**Severity**: HIGH
**Impact**: JSON corruption, broken display formatting
**Test Evidence**: `claude-todo add "Line1\nLine2"` succeeds when it should fail

**Files to Modify**:
- `lib/validation.sh` - Add newline check
- `scripts/add-task.sh` - Call validation
- `scripts/update-task.sh` - Call validation for title updates

**Fix Implementation**:

```bash
# FILE: lib/validation.sh
# ADD this function:

# Validate task title - no newlines, not empty, reasonable length
validate_title() {
    local title="$1"

    # Check for empty
    if [[ -z "$title" ]]; then
        log_error "Title cannot be empty"
        return 1
    fi

    # Check for newlines (literal or escaped)
    if [[ "$title" == *$'\n'* ]] || [[ "$title" == *'\n'* ]]; then
        log_error "Title cannot contain newlines"
        return 1
    fi

    # Check for carriage returns
    if [[ "$title" == *$'\r'* ]]; then
        log_error "Title cannot contain carriage returns"
        return 1
    fi

    # Check length (max 500 chars)
    if [[ ${#title} -gt 500 ]]; then
        log_error "Title too long (max 500 characters)"
        return 1
    fi

    return 0
}
```

```bash
# FILE: scripts/add-task.sh
# Find where title is first used, ADD validation call:

# After parsing arguments, before creating task:
if ! validate_title "$TITLE"; then
    exit 1
fi
```

```bash
# FILE: scripts/update-task.sh
# Find where title update is processed, ADD:

if [[ -n "$NEW_TITLE" ]]; then
    if ! validate_title "$NEW_TITLE"; then
        exit 1
    fi
fi
```

**Verification**:
```bash
claude-todo add "Normal title"
# Should succeed

claude-todo add "Title with
newline"
# Before fix: Succeeds (BAD)
# After fix: "[ERROR] Title cannot contain newlines"
```

---

### P1-2: Focus Clear Doesn't Reset Task Status

**Severity**: HIGH
**Impact**: Tasks remain "active" after focus cleared, violates single-active rule
**Test Evidence**: After `focus clear`, task still shows `status: active`

**Files to Modify**:
- `scripts/focus.sh` - Update clear subcommand

**Fix Implementation**:

```bash
# FILE: scripts/focus.sh
# Find the clear_focus() function or case statement for "clear"

# CURRENT (approximate):
clear)
    # Just clears the focus object
    jq '.focus = {}' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"
    ;;

# REPLACE WITH:
clear)
    # Get current focused task
    local current_task
    current_task=$(jq -r '.focus.currentTask // .focus.currentTaskId // empty' "$TODO_FILE")

    if [[ -n "$current_task" ]]; then
        # Reset the task status to pending
        jq --arg id "$current_task" '
            .tasks = [.tasks[] | if .id == $id and .status == "active" then .status = "pending" else . end]
        ' "$TODO_FILE" > "${TODO_FILE}.tmp"
        mv "${TODO_FILE}.tmp" "$TODO_FILE"
        log_info "Task $current_task status reset to pending"
    fi

    # Clear the focus object
    jq '.focus = {}' "$TODO_FILE" > "${TODO_FILE}.tmp"
    mv "${TODO_FILE}.tmp" "$TODO_FILE"
    log_info "Focus cleared"
    ;;
```

**Verification**:
```bash
claude-todo add "Test task"
claude-todo focus set T001
claude-todo list --format json | jq '.tasks[0].status'
# Should show: "active"

claude-todo focus clear
claude-todo list --format json | jq '.tasks[0].status'
# Before fix: "active" (BAD - orphaned active task)
# After fix: "pending"
```

---

### P1-3: Multi-level Circular Dependencies Not Detected

**Severity**: HIGH
**Impact**: Complex circular deps (A→B→C→A) slip through validation
**Test Evidence**: Can create T001→T002→T003→T001 chain

**Files to Modify**:
- `lib/validation.sh` - Enhance circular dependency detection

**Fix Implementation**:

```bash
# FILE: lib/validation.sh
# Find the existing circular dependency check function and REPLACE/ENHANCE:

# Detect circular dependencies using depth-first search
detect_circular_dependency() {
    local task_id="$1"
    local new_dep="$2"
    local todo_file="${3:-$TODO_FILE}"
    local -a visited=()
    local -a rec_stack=()

    # Helper function for DFS
    _dfs_check() {
        local current="$1"
        local -a current_deps

        # Mark as visited and add to recursion stack
        visited+=("$current")
        rec_stack+=("$current")

        # Get dependencies of current task
        readarray -t current_deps < <(jq -r --arg id "$current" '
            .tasks[] | select(.id == $id) | .depends // [] | .[]
        ' "$todo_file" 2>/dev/null)

        for dep in "${current_deps[@]}"; do
            [[ -z "$dep" ]] && continue

            # Check if this dep is in recursion stack (cycle found)
            for stack_item in "${rec_stack[@]}"; do
                if [[ "$dep" == "$stack_item" ]]; then
                    return 1  # Cycle detected
                fi
            done

            # Check if not visited yet
            local is_visited=false
            for v in "${visited[@]}"; do
                [[ "$dep" == "$v" ]] && is_visited=true && break
            done

            if [[ "$is_visited" == "false" ]]; then
                if ! _dfs_check "$dep"; then
                    return 1  # Propagate cycle detection
                fi
            fi
        done

        # Remove from recursion stack (backtrack)
        unset 'rec_stack[-1]'
        return 0
    }

    # Temporarily add the new dependency and check
    local temp_file=$(mktemp)
    jq --arg id "$task_id" --arg dep "$new_dep" '
        .tasks = [.tasks[] | if .id == $id then
            .depends = ((.depends // []) + [$dep] | unique)
        else . end]
    ' "$todo_file" > "$temp_file"

    # Run DFS from the new dependency
    if ! _dfs_check "$new_dep"; then
        rm -f "$temp_file"
        log_error "Circular dependency detected: adding $new_dep to $task_id would create a cycle"
        return 1
    fi

    rm -f "$temp_file"
    return 0
}
```

**Verification**:
```bash
claude-todo init
claude-todo add "Task A"  # T001
claude-todo add "Task B" --depends T001  # T002 depends on T001
claude-todo add "Task C" --depends T002  # T003 depends on T002

# Try to create cycle
claude-todo update T001 --depends T003
# Before fix: Succeeds (BAD - creates T001→T003→T002→T001)
# After fix: "[ERROR] Circular dependency detected"
```

---

### P1-4: Script Names Exposed in Help Text

**Severity**: HIGH
**Impact**: Confusing UX, shows internal implementation
**Test Evidence**: `claude-todo add --help` shows "Usage: add-task.sh"

**Files to Modify** (8 scripts):
- `scripts/add-task.sh`
- `scripts/update-task.sh`
- `scripts/complete-task.sh`
- `scripts/list-tasks.sh`
- `scripts/focus.sh`
- `scripts/session.sh`
- `scripts/archive.sh`
- `scripts/validate.sh`

**Fix Implementation**:

For EACH of the 8 scripts listed above, find the `usage()` function and update it:

```bash
# EXAMPLE: scripts/add-task.sh
# Find the usage() function

# BEFORE:
usage() {
    cat << 'EOF'
Usage: add-task.sh "Task Title" [OPTIONS]

Examples:
    add-task.sh "Implement feature" --priority high
    add-task.sh "Fix bug" --labels bug,urgent
EOF
}

# AFTER:
usage() {
    cat << 'EOF'
Usage: claude-todo add "Task Title" [OPTIONS]

Examples:
    claude-todo add "Implement feature" --priority high
    claude-todo add "Fix bug" --labels bug,urgent
EOF
}
```

**Apply same pattern to all 8 scripts**:

| Script | Command Name |
|--------|--------------|
| `add-task.sh` | `claude-todo add` |
| `update-task.sh` | `claude-todo update` |
| `complete-task.sh` | `claude-todo complete` |
| `list-tasks.sh` | `claude-todo list` |
| `focus.sh` | `claude-todo focus` |
| `session.sh` | `claude-todo session` |
| `archive.sh` | `claude-todo archive` |
| `validate.sh` | `claude-todo validate` |

**Quick Fix Script**:
```bash
# Run this to fix all at once:
for script in add-task update-task complete-task list-tasks; do
    cmd=$(echo "$script" | sed 's/-task//')
    sed -i "s/${script}\.sh/claude-todo ${cmd}/g" "scripts/${script}.sh"
done

for script in focus session archive validate; do
    sed -i "s/${script}\.sh/claude-todo ${script}/g" "scripts/${script}.sh"
done
```

**Verification**:
```bash
claude-todo add --help 2>&1 | head -3
# Before: "Usage: add-task.sh ..."
# After: "Usage: claude-todo add ..."
```

---

## P2 MEDIUM PRIORITY ISSUES

These affect non-critical features and should be fixed in next release.

---

### P2-1: Missing `_meta.format` Field in JSON Outputs

**Severity**: MEDIUM
**Impact**: JSON outputs missing format identifier for programmatic detection
**Affected Commands**: list, dash, next, labels, stats

**Files to Modify**:
- `lib/output-format.sh` - Add format field to _meta generation

**Fix Implementation**:

```bash
# FILE: lib/output-format.sh
# Find the function that generates _meta envelope

# BEFORE (approximate):
generate_meta() {
    local command="$1"
    jq -n --arg cmd "$command" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{
        "$schema": "https://claude-todo.dev/schemas/output-v2.json",
        "_meta": {
            "version": "0.8.3",
            "command": $cmd,
            "timestamp": $ts
        }
    }'
}

# AFTER:
generate_meta() {
    local command="$1"
    local format="${2:-json}"
    jq -n --arg cmd "$command" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg fmt "$format" '{
        "$schema": "https://claude-todo.dev/schemas/output-v2.json",
        "_meta": {
            "format": $fmt,
            "version": "0.8.3",
            "command": $cmd,
            "timestamp": $ts
        }
    }'
}
```

Then update each command script to pass the format:
```bash
# In each script's JSON output section:
generate_meta "list" "json"
```

---

### P2-2: Duplicate Labels Accepted

**Severity**: MEDIUM
**Impact**: `--labels bug,bug,bug` stores duplicates, inflates statistics

**Files to Modify**:
- `lib/validation.sh` - Add label deduplication

**Fix Implementation**:

```bash
# FILE: lib/validation.sh
# ADD function:

# Deduplicate and validate labels
normalize_labels() {
    local labels_input="$1"

    # Split by comma, deduplicate, rejoin
    echo "$labels_input" | tr ',' '\n' | sort -u | tr '\n' ',' | sed 's/,$//'
}

# Usage in add-task.sh and update-task.sh:
if [[ -n "$LABELS" ]]; then
    LABELS=$(normalize_labels "$LABELS")
fi
```

---

### P2-3: Export Command JSON Pollution

**Severity**: MEDIUM
**Impact**: Log messages in stdout corrupt JSON output for piping

**Files to Modify**:
- `scripts/export.sh` - Redirect logs to stderr

**Fix Implementation**:

```bash
# FILE: scripts/export.sh
# Find log/info output lines and redirect to stderr

# BEFORE:
echo "[EXPORT] Format: $FORMAT, Status: $STATUS"

# AFTER:
echo "[EXPORT] Format: $FORMAT, Status: $STATUS" >&2
```

---

### P2-4: Archive Statistics Not Calculated

**Severity**: MEDIUM
**Impact**: No summary after archive operations

**Files to Modify**:
- `scripts/archive.sh` - Add statistics calculation

**Fix Implementation**:

```bash
# FILE: scripts/archive.sh
# After archiving tasks, add statistics output:

# Count archived by priority
high_count=$(echo "$archived_tasks" | jq '[.[] | select(.priority == "high")] | length')
medium_count=$(echo "$archived_tasks" | jq '[.[] | select(.priority == "medium")] | length')
# etc.

echo "[ARCHIVE] Archived $total_count tasks"
echo "  High: $high_count | Medium: $medium_count | Low: $low_count"
```

---

### P2-5: Validate Command Lacks JSON Output

**Severity**: MEDIUM
**Impact**: Cannot parse validation results programmatically

**Files to Modify**:
- `scripts/validate.sh` - Add --format json support

**Fix Implementation**:

```bash
# FILE: scripts/validate.sh
# Add FORMAT variable and JSON output mode

if [[ "$FORMAT" == "json" ]]; then
    jq -n --argjson errors "$error_count" --argjson warnings "$warning_count" '{
        "_meta": {"format": "json", "command": "validate"},
        "valid": ($errors == 0),
        "errors": $errors,
        "warnings": $warnings,
        "details": []
    }'
else
    # existing text output
fi
```

---

## P3 LOW PRIORITY ISSUES

Cosmetic and enhancement issues for future consideration.

---

### P3-1: Stats Command Pluralization

**Severity**: LOW
**Impact**: Shows "1 Tasks" instead of "1 Task"

**Fix**: Add conditional pluralization in stats output.

---

### P3-2: Named Period Filters Not Supported

**Severity**: LOW
**Impact**: Must use `--period 7` instead of `--period week`

**Fix**: Add aliases: today=1, week=7, month=30

---

### P3-3: Backup --name and --list Not Implemented

**Severity**: LOW
**Impact**: Cannot name backups or list available backups via CLI

**Fix**: Implement the documented flags.

---

### P3-4: Export --priority and --label Filters Missing

**Severity**: LOW
**Impact**: Cannot filter exports by priority or label

**Fix**: Add filter options to export command.

---

### P3-5: Configuration Field Naming Inconsistency

**Severity**: LOW
**Impact**: `progressBars` vs `showProgress` naming confusion

**Fix**: Standardize to `show*` prefix pattern.

---

### P3-6: Zero-Width Characters Accepted in Titles

**Severity**: LOW
**Impact**: Invisible characters can cause search/display issues

**Fix**: Add Unicode sanitization to title validation.

---

## VERIFICATION CHECKLIST

After implementing all fixes, run these verification tests:

### P0 Verification

```bash
# P0-1: Race Condition
cd /tmp/verify-p0 && rm -rf .claude && claude-todo init
for i in {1..5}; do claude-todo add "Task $i" & done; wait
count=$(claude-todo list --format json | jq '.tasks | length')
[[ "$count" == "5" ]] && echo "P0-1: PASS" || echo "P0-1: FAIL (got $count)"

# P0-2: Log Command
claude-todo log 2>&1 | grep -q "readonly" && echo "P0-2: FAIL" || echo "P0-2: PASS"

# P0-3: Migrate Command
cd /tmp/verify-migrate && rm -rf .claude && mkdir -p .claude
echo '{"version":"0.5.0","tasks":[]}' > .claude/todo.json
claude-todo migrate status 2>&1 | grep -q "command not found" && echo "P0-3: FAIL" || echo "P0-3: PASS"

# P0-4: Init Re-init
cd /tmp/verify-init && rm -rf .claude
claude-todo init
claude-todo init 2>&1 | grep -qi "unbound\|error" && echo "P0-4: FAIL" || echo "P0-4: PASS"
```

### P1 Verification

```bash
# P1-1: Newlines in Titles
claude-todo add "Line1
Line2" 2>&1 | grep -q "newline\|invalid" && echo "P1-1: PASS" || echo "P1-1: FAIL"

# P1-2: Focus Clear Status
claude-todo add "Focus test"
claude-todo focus set T001
claude-todo focus clear
status=$(claude-todo list --format json | jq -r '.tasks[0].status')
[[ "$status" == "pending" ]] && echo "P1-2: PASS" || echo "P1-2: FAIL (status=$status)"

# P1-3: Circular Deps
claude-todo add "A"
claude-todo add "B" --depends T001
claude-todo add "C" --depends T002
claude-todo update T001 --depends T003 2>&1 | grep -qi "circular" && echo "P1-3: PASS" || echo "P1-3: FAIL"

# P1-4: Script Names
claude-todo add --help 2>&1 | grep -q "add-task.sh" && echo "P1-4: FAIL" || echo "P1-4: PASS"
```

### Full Regression Test

```bash
# Run the complete test suite
cd /mnt/projects/claude-todo
./tests/run-all-tests.sh
```

---

## IMPLEMENTATION ORDER

Recommended order for fixing (dependencies considered):

1. **P0-2: Log Command** (5 min) - Simple variable removal
2. **P0-3: Migrate Command** (5 min) - Function name fix
3. **P0-4: Init Re-init** (15 min) - Add guards
4. **P0-1: Race Condition** (30-60 min) - Add locking to atomic writes
5. **P1-1: Newline Validation** (15 min) - Add validation function
6. **P1-2: Focus Clear** (15 min) - Update clear logic
7. **P1-3: Circular Deps** (30 min) - Implement DFS
8. **P1-4: Script Names** (30 min) - Update 8 help functions

**Estimated Total Time**: 2-3 hours for P0+P1

---

## FILES REFERENCE

| File | Issues |
|------|--------|
| `lib/file-ops.sh` | P0-1 (locking) |
| `lib/logging.sh` | P0-2 (readonly), P0-4 (reinit) |
| `lib/validation.sh` | P1-1 (newlines), P1-3 (circular), P2-2 (labels) |
| `lib/output-format.sh` | P2-1 (_meta.format) |
| `scripts/log.sh` | P0-2 (variable conflict) |
| `scripts/migrate.sh` | P0-3 (function name) |
| `scripts/init.sh` | P0-4 (reinit crash) |
| `scripts/focus.sh` | P1-2 (clear status) |
| `scripts/add-task.sh` | P1-1, P1-4 |
| `scripts/update-task.sh` | P1-1, P1-4 |
| `scripts/complete-task.sh` | P1-4 |
| `scripts/list-tasks.sh` | P1-4 |
| `scripts/session.sh` | P1-4 |
| `scripts/archive.sh` | P1-4, P2-4 |
| `scripts/validate.sh` | P1-4, P2-5 |
| `scripts/export.sh` | P2-3 |

---

## NOTES FOR IMPLEMENTATION AGENT

1. **Test after each fix** - Don't batch all fixes then test
2. **Commit incrementally** - One commit per P0 fix
3. **Update version** - Bump to 0.8.4 after P0 fixes
4. **Run full suite** - `./tests/run-all-tests.sh` after all fixes
5. **Check for regressions** - Core commands must still pass 100%

**Questions? Check these reports**:
- `claudedocs/ATOMIC-OPERATIONS-TEST-REPORT.md`
- `claudedocs/MIGRATE-COMMAND-TEST-REPORT.md`
- `claudedocs/INIT-COMMAND-TEST-REPORT.md`
- `claudedocs/DEPENDENCY-MANAGEMENT-TEST-REPORT.md`

---

*Generated by 24-Agent Validation Suite*
*Consolidated by root-cause-analyst and technical-writer agents*
