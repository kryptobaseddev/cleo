# T136: Duplicate ID Validation Implementation

## Summary
Successfully implemented duplicate task ID detection in `validate.sh` script.

## Changes Made

### 1. Added Duplicate ID Detection (Check #2)
Location: `/mnt/projects/claude-todo/scripts/validate.sh` lines 132-194

Detects and optionally fixes three types of duplicate IDs:
- Duplicates within `todo.json`
- Duplicates within `todo-archive.json`
- Cross-file duplicates (IDs existing in both files)

### 2. Added --quiet Flag Support
- New flag: `--quiet` or `-q`
- Suppresses `[OK]` info messages
- Still shows errors and warnings
- Useful for CI/CD and automated checks

### 3. Updated Documentation
- Updated `usage()` function to list all validation checks
- Added `--quiet` flag documentation
- Updated check numbering (2-10 instead of 2-9)

### 4. Critical Bug Fix
**Issue**: Script was exiting early due to `set -e` from sourced `logging.sh`

**Root Cause**: The `((ERRORS++))` and `((WARNINGS++))` arithmetic operations return the pre-increment value. When incrementing from 0, this returns 0 (falsy), causing script to exit with `set -e` active.

**Fix**: Changed from `((ERRORS++))` to `ERRORS=$((ERRORS + 1))` pattern to avoid exit-on-zero issue.

## Implementation Details

### Duplicate Detection Logic

```bash
# Extract all task IDs
TASK_IDS=$(jq -r '.tasks[].id' "$TODO_FILE" 2>/dev/null || echo "")

# Find duplicates (IDs that appear more than once)
DUPLICATE_IDS=$(echo "$TASK_IDS" | sort | uniq -d)

# Check and optionally fix
if [[ -n "$DUPLICATE_IDS" ]]; then
  log_error "Duplicate task IDs found in todo.json: ..."
  if [[ "$FIX" == true ]]; then
    # Keep only first occurrence using jq reduce
    jq '.tasks |= (reduce .[] as $task ([];
      if (map(.id) | index($task.id) | not)
      then . + [$task] else . end))' ...
  fi
fi
```

### Archive Duplicate Detection

Same pattern applied to `todo-archive.json`:
- Checks `.archivedTasks[].id` for duplicates
- Applies same fix logic (keep first occurrence)

### Cross-File Duplicate Detection

```bash
# Find IDs in both active and archive
CROSS_DUPLICATES=$(comm -12 <(echo "$TASK_IDS" | sort) <(echo "$ARCHIVE_IDS" | sort))

if [[ -n "$CROSS_DUPLICATES" ]]; then
  log_error "IDs exist in both todo.json and archive: ..."
  if [[ "$FIX" == true ]]; then
    # Remove from archive (keep in active todo.json)
    for cross_id in $CROSS_DUPLICATES; do
      jq --arg id "$cross_id" '.archivedTasks |= map(select(.id != $id))' ...
    done
  fi
fi
```

## Testing

### Test Cases Verified

1. **Duplicate IDs in todo.json**
   - Detection: PASS
   - Fix with --fix: PASS
   - Keeps first occurrence

2. **Duplicate IDs in archive**
   - Detection: PASS
   - Fix with --fix: PASS
   - Keeps first occurrence in archive

3. **Cross-file duplicates**
   - Detection: PASS
   - Fix with --fix: PASS
   - Removes from archive, keeps in active

4. **--quiet flag**
   - Suppresses [OK] messages: PASS
   - Shows errors: PASS
   - Shows summary: PASS

5. **No duplicates**
   - Reports success: PASS
   - No false positives: PASS

### Test Files Created

Location: `/tmp/test-duplicate-validation/`

Files:
- `todo.json` - Active tasks with duplicates
- `todo-archive.json` - Archived tasks with duplicates and cross-file duplicates
- `todo-errors.json` - Multiple active tasks (for quiet mode testing)

## Files Modified

1. `/mnt/projects/claude-todo/scripts/validate.sh`
   - Added QUIET variable (line 39)
   - Updated usage() documentation (lines 44-69)
   - Modified log_error() to use safe increment (line 77)
   - Modified log_warn() to use safe increment (line 86)
   - Modified log_info() to respect QUIET flag (lines 89-94)
   - Added --quiet flag parsing (line 110)
   - Added duplicate ID detection (lines 132-194)
   - Renumbered subsequent checks (3-10)
   - Updated dependency check to re-fetch TASK_IDS (line 216)

## Validation Checks (Updated Sequence)

1. JSON syntax
2. **No duplicate task IDs (NEW)**
   - Within todo.json
   - Within archive
   - Cross-file duplicates
3. Only ONE active task
4. All depends[] references exist
5. No circular dependencies
6. blocked tasks have blockedBy
7. done tasks have completedAt
8. focus.currentTask matches active task
9. Verify checksum
10. WARNINGS: Stale tasks

## Usage Examples

```bash
# Detect duplicates
claude-todo validate

# Detect and auto-fix duplicates
claude-todo validate --fix

# Quiet mode (CI/CD friendly)
claude-todo validate --quiet

# Quiet mode with auto-fix
claude-todo validate --quiet --fix

# Strict mode (warnings as errors)
claude-todo validate --strict
```

## Impact

### Data Integrity
- Prevents duplicate IDs from corrupting task tracking
- Ensures unique task identification across active and archived tasks
- Maintains referential integrity for dependencies

### Anti-Hallucination
- Critical safeguard against ID reuse
- Prevents task confusion and data corruption
- Validates archive integrity

### Automation
- --quiet flag enables CI/CD integration
- Auto-fix capability for batch operations
- Non-interactive validation workflows

## Next Steps

1. Create BATS tests for duplicate ID detection
2. Update documentation to reflect new validation check
3. Consider adding duplicate ID check to `add-task.sh` for prevention
4. Update changelog for v0.8.3 or next version

## Notes

- Fix logic uses jq's reduce to maintain first occurrence
- Cross-file duplicates prioritize active tasks over archived
- All duplicate checks run even if one fails (no early exit)
- Error count incremented for each type of duplicate found
- Fix messages clearly indicate what was fixed
