# Phase Delete Command Implementation

**Status**: ✅ IMPLEMENTED
**Version**: 0.16.0+
**Date**: 2025-12-17

## Overview

Implemented `cleo phase delete` command with comprehensive protection against orphaning tasks and safety features.

## Implementation Details

### Files Modified

1. **scripts/phase.sh**
   - Added `cmd_delete()` function (lines 1124-1420)
   - Added delete command dispatcher (lines 1590-1658)
   - Updated usage documentation

2. **lib/logging.sh**
   - Added `log_phase_deleted()` function (lines 689-712)
   - Added `phase_deleted` to VALID_ACTIONS array (line 69)

### Command Signature

```bash
cleo phase delete <slug> [--reassign-to <phase>] [--force]
```

### Safety Features

1. **Current Phase Protection**
   - Cannot delete the current project phase
   - Error: "Cannot delete current project phase. Use 'phase set' to change first"

2. **Orphan Prevention**
   - Blocks deletion if tasks exist without --reassign-to
   - Shows task breakdown by status (pending/active/blocked/done)
   - Error: "Cannot delete 'X': N tasks would be orphaned. Use --reassign-to <phase>"

3. **Validation**
   - Verifies source phase exists
   - Verifies reassignment target phase exists
   - Requires --force flag for all deletions

4. **Atomic Operation**
   - Creates backup before changes
   - Reassigns all tasks atomically
   - Deletes phase definition
   - Recalculates checksum
   - All or nothing - no partial state

### Implementation Pattern

```bash
# Reassign tasks if needed, then delete phase
if [[ "$task_count" -gt 0 && -n "$reassign_to" ]]; then
    jq --arg slug "$slug" \
       --arg reassign "$reassign_to" \
       --arg ts "$timestamp" '
        # Reassign all tasks with this phase
        .tasks = [.tasks[] | if .phase == $slug then .phase = $reassign else . end] |
        # Delete the phase
        del(.project.phases[$slug]) |
        # Update timestamp
        .lastUpdated = $ts
    ' "$TODO_FILE" > "$temp_file"
fi

# Recalculate checksum
new_checksum=$(jq -c '.tasks' "$temp_file" | sha256sum | cut -c1-16)
jq --arg checksum "$new_checksum" '._meta.checksum = $checksum' "$temp_file"

# Atomic write with file locking
save_json "$TODO_FILE" "$(cat "$temp_file")"
```

### Output Formats

#### Text Output (with task reassignment)
```
Phase 'core' has 63 tasks:
  - 45 pending
  - 10 active
  - 8 blocked

Reassigning to 'development'...
Updated 63 tasks
Phase 'core' deleted
```

#### Text Output (empty phase)
```
Phase 'old-phase' deleted
```

#### JSON Output
```json
{
  "_meta": {
    "command": "phase delete",
    "timestamp": "2025-12-17T22:45:48Z"
  },
  "success": true,
  "deletedPhase": "core",
  "tasksReassigned": 63,
  "reassignedTo": "development"
}
```

### Error Codes

| Code | Meaning | Exit Code |
|------|---------|-----------|
| `E_PHASE_NOT_FOUND` | Phase doesn't exist | 4 |
| `E_PHASE_IS_CURRENT` | Cannot delete current phase | 6 |
| `E_PHASE_HAS_TASKS` | Tasks exist, no reassignment | 6 |
| `E_FORCE_REQUIRED` | Missing --force flag | 2 |
| `E_BACKUP_FAILED` | Backup creation failed | 3 |
| `E_FILE_WRITE_ERROR` | Atomic write failed | 3 |

### Logging

Log entry structure:
```json
{
  "id": "log_d87bdf3feecd",
  "timestamp": "2025-12-17T22:45:48Z",
  "sessionId": null,
  "action": "phase_deleted",
  "actor": "system",
  "taskId": null,
  "before": {
    "deletedPhase": "test"
  },
  "after": {
    "deletedPhase": null
  },
  "details": {
    "operation": "delete",
    "deletedPhase": "test",
    "tasksReassigned": 1,
    "reassignedTo": "keep"
  }
}
```

## Test Coverage

Comprehensive integration tests created (`/tmp/test_phase_delete.sh`):

1. ✅ Delete non-existent phase → Error
2. ✅ Delete phase with tasks, no reassignment → Error
3. ✅ Delete without --force flag → Error
4. ✅ Delete current project phase → Error
5. ✅ Delete with tasks and reassignment → Success
6. ✅ Delete empty phase with --force → Success
7. ✅ Invalid reassignment target → Error

**Result**: All 7 tests passing

## Usage Examples

### Delete empty phase
```bash
cleo phase delete old-phase --force
```

### Delete phase with task reassignment
```bash
cleo phase delete core --reassign-to development --force
```

### JSON output
```bash
cleo phase --json delete testing --force
```

## Design Decisions

1. **Require --force always**: Even for empty phases, to prevent accidental deletions
2. **Block current phase deletion**: Prevents leaving project in inconsistent state
3. **Atomic reassignment**: All tasks updated in single jq operation
4. **Detailed reporting**: Show task breakdown to inform user of impact
5. **Backup before modify**: Create backup before any destructive operation

## Integration Points

- Uses `backup_file()` from lib/file-ops.sh
- Uses `save_json()` for atomic writes with file locking
- Uses `log_phase_deleted()` for audit trail
- Follows same error handling pattern as other phase commands
- Consistent JSON/text output formatting

## Future Enhancements

Potential improvements (not currently required):

1. Interactive confirmation prompt (similar to phase advance)
2. Dry-run mode to preview changes
3. Cascade delete option (delete phase and all tasks)
4. Batch delete multiple phases
5. Archive deleted phases to separate file

## Related Specifications

- See docs/specs/PHASE-ENHANCEMENT-RISK-ANALYSIS.md for original design
- See docs/specs/TASK-HIERARCHY-SPEC.md for phase system overview
