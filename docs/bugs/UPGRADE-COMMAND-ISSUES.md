# Upgrade Command Production Readiness - Critical Bug Documentation

**Epic**: T1243
**Created**: 2026-01-03
**Priority**: CRITICAL
**Status**: Blocking production release

## Executive Summary

The `cleo upgrade` command has multiple serious bugs discovered during the 2026-01-03 session that prevent production use. The command is intended to be the canonical unified maintenance command but currently:

1. Fails to complete migrations (stops at 2.4.0, target is 2.6.0)
2. Has arithmetic syntax errors in version comparison
3. Missing migration functions for position ordering (T805)
4. Inconsistent behavior between `--status` and actual execution
5. Documentation confusion between `upgrade` and `migrate` commands

---

## Issue 1: Arithmetic Syntax Errors in Version Comparison

**Severity**: ERROR (breaks migration execution)
**Location**: `lib/migrate.sh` lines 455-464
**Affects**: All version comparisons in migration chain

### Symptom
```
lib/migrate.sh: line 455: [[: 2 2 0: arithmetic syntax error in expression (error token is "2 0")
lib/migrate.sh: line 456: [[: 2 2 0: arithmetic syntax error in expression (error token is "2 0")
lib/migrate.sh: line 457: [[: 2 2 0: arithmetic syntax error in expression (error token is "2 0")
```

### Root Cause
Version comparison code splits version string incorrectly. Instead of parsing `2.2.0` into separate variables `major=2`, `minor=2`, `patch=0`, it produces a single string `"2 2 0"` which fails in arithmetic contexts.

### Evidence
Observed during: `cleo migrate run --force --auto`

### Fix Required
Review and fix version parsing logic at lines 455-464 to properly extract semantic version components.

---

## Issue 2: Missing Migration Functions (2.5.0, 2.6.0)

**Severity**: CRITICAL (blocks T805 position ordering feature)
**Location**: `lib/migrate.sh`
**Affects**: All users upgrading to use position ordering

### Symptom
```bash
$ cleo upgrade --status
{"updates":[{"component":"todo","update":"2.4.0 → 2.6.0"}]}

$ cleo migrate run --force --auto
# ... migrations run ...
WARNING: Final version (2.4.0) doesn't match target (2.6.0)
✓ Migration successful: ./.cleo/todo.json
```

### Root Cause
- No `migrate_todo_to_2_5_0()` function exists in lib/migrate.sh
- No `migrate_todo_to_2_6_0()` function exists in lib/migrate.sh
- T805 (Explicit Positional Ordering System) was completed
- T1226 (Implement Position Migration) was marked DONE
- But the actual migration function was never implemented

### Impact
- Existing tasks don't receive `position` field
- Existing tasks don't receive `positionVersion` field
- Users must manually run jq scripts to backfill positions
- Position ordering feature is broken for existing projects

### Fix Required
Add migration functions:
```bash
migrate_todo_to_2_5_0() {
    # Add position field to all tasks
    # Assign by createdAt order within parent scope
}

migrate_todo_to_2_6_0() {
    # Add positionVersion field (optimistic locking)
}
```

### Workaround Applied (2026-01-03)
Manual jq script to backfill positions:
```bash
jq '
  .tasks |= (
    group_by(.parentId // "ROOT") |
    map(
      sort_by(.createdAt) |
      to_entries |
      map(.value + {position: (.key + 1), positionVersion: 0})
    ) |
    flatten
  )
' .cleo/todo.json > .cleo/todo.json.tmp && mv .cleo/todo.json.tmp .cleo/todo.json
```

---

## Issue 3: upgrade vs migrate Command Confusion

**Severity**: MEDIUM (user/documentation confusion)
**Location**: Multiple documentation files
**Affects**: User understanding of canonical command

### Symptom
- `upgrade` is supposed to be the canonical unified command
- `upgrade.sh` sources `lib/migrate.sh` (correct architecture)
- Documentation still references `ct migrate run` everywhere
- No `docs/commands/upgrade.md` exists

### Files Needing Update
- `docs/commands/migrate.md` - add note about upgrade being canonical
- `docs/specs/VERSION-GUARD-SPEC.md` - references `ct migrate run`
- `docs/reference/VERSION-MANAGEMENT.md` - references migrate
- `docs/reference/configuration.md` - references migrate

### Fix Required
1. Create `docs/commands/upgrade.md`
2. Update all docs to recommend `ct upgrade` as canonical
3. Keep `ct migrate` documented as low-level utility

---

## Issue 4: Upgrade Command Inconsistent Behavior

**Severity**: HIGH (command appears to work but does nothing)
**Location**: `scripts/upgrade.sh`
**Affects**: All users running upgrade

### Symptom
```bash
# Step 1: Check status - shows updates needed
$ cleo upgrade --status
{"success":true,"upToDate":false,"updatesNeeded":2,"updates":[...]}

# Step 2: Run upgrade - applies zero updates!
$ cleo upgrade --force
{"success":true,"updatesApplied":0,"valid":true}
```

### Root Cause
Unclear. Possibilities:
1. Validation passes so migration is skipped
2. Migration functions don't exist for target versions (confirmed for 2.5.0, 2.6.0)
3. Logic error in upgrade.sh main flow

### Fix Required
Debug upgrade.sh to understand why:
- `--status` reports updates needed
- Actual execution applies 0 updates
- No error is thrown

---

## Issue 5: Display Bugs (Backwards Versions)

**Severity**: LOW (cosmetic but confusing)
**Location**: `scripts/upgrade.sh`
**Existing Tasks**: T1233, T1234
**Affects**: User understanding of upgrade direction

### Symptom
Display shows version downgrade instead of upgrade:
```
Config version: 2.3.0 → 2.2.0  # WRONG - appears to downgrade
```

Should show:
```
Config version: 2.2.0 → 2.3.0  # CORRECT - shows upgrade direction
```

### Fix Required
Fix version display logic in upgrade.sh to show `current → target` not `target → current`

---

## Issue 6: validate --fix Cross-Duplicate Bug

**Severity**: MEDIUM (fix claims success but doesn't work)
**Location**: `scripts/validate.sh` or `lib/validation.sh`
**Affects**: Data integrity operations

### Symptom
```bash
$ cleo validate --fix
  Fixed: Removed cross-duplicates from archive (kept in todo.json)

$ cleo validate
{"valid":false,"errors":1,"details":[
  {"check":"unknown","status":"error",
   "message":"IDs exist in both todo.json and archive: T1205,T1206,..."}
]}
```

The fix claims success but the error persists. Running validate a second time finally clears it.

### Root Cause
Likely one of:
1. Fix applied but validation cache not cleared
2. Fix not atomic (file not properly saved before re-validation)
3. Validation runs against old data

### Fix Required
Ensure validate --fix:
1. Applies changes atomically
2. Re-reads files after fix before final validation
3. Reports accurate success/failure

---

## Issue 7: Position Migration Not Actually Implemented

**Severity**: CRITICAL (feature marked done but not working)
**Location**: `lib/migrate.sh` (missing functions)
**Related Tasks**: T805 (epic), T1226 (migration subtask)
**Affects**: All users of position ordering

### Symptom
- T805 (Explicit Positional Ordering System) marked COMPLETE
- T1226 (Implement Position Migration) marked DONE
- T805-EXECUTION-CHECKLIST.md shows all items checked
- But actual migration function does not exist in codebase

### Evidence
```bash
$ grep -n "migrate.*2_5_0\|migrate.*2_6_0\|position" lib/migrate.sh
# No results
```

### Root Cause
T1226 was marked complete during a session but the actual code was never committed/implemented. This is an anti-hallucination validation failure.

### Fix Required
1. Implement `migrate_todo_to_2_5_0()` - adds position field
2. Implement `migrate_todo_to_2_6_0()` - adds positionVersion field
3. Add tests for position migration
4. Verify T1226 completion criteria were actually met

---

## Files to Review and Fix

| File | Issues | Priority |
|------|--------|----------|
| `lib/migrate.sh` | #1 arithmetic, #2 missing functions, #7 | CRITICAL |
| `scripts/upgrade.sh` | #4 inconsistent behavior, #5 display | HIGH |
| `scripts/validate.sh` | #6 fix not atomic | MEDIUM |
| `docs/commands/upgrade.md` | #3 missing file | MEDIUM |
| `docs/specs/VERSION-GUARD-SPEC.md` | #3 references migrate | LOW |
| `docs/reference/VERSION-MANAGEMENT.md` | #3 references migrate | LOW |

---

## Recommended Fix Order

1. **lib/migrate.sh arithmetic errors** (lines 455-464) - unblocks all migrations
2. **Add migrate_todo_to_2_5_0()** - adds position field
3. **Add migrate_todo_to_2_6_0()** - adds positionVersion field
4. **Fix upgrade.sh inconsistent behavior** - ensures migrations actually run
5. **Fix validate --fix atomicity** - ensures fixes persist
6. **Create upgrade.md documentation** - user clarity
7. **Fix display bugs (T1233/T1234)** - cosmetic

---

## Test Cases Required

1. Fresh project upgrade from 2.0.0 → 2.6.0
2. Existing project upgrade from 2.4.0 → 2.6.0
3. Verify position field added to all tasks
4. Verify positionVersion field added to all tasks
5. Verify positions assigned by createdAt within parent scope
6. Verify upgrade --status matches upgrade execution
7. Verify validate --fix persists changes

---

## Session Evidence

All issues observed during session on 2026-01-03:
- User requested full pipeline workflow review
- 6 agents deployed for research
- Attempted to enable position ordering via upgrade
- Multiple failures documented above
- Manual workaround applied (jq script)
- Epic T1243 created to track fixes
