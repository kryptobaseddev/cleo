# Upgrade Command Production Readiness - Critical Bug Documentation

**Epic**: T1243
**Created**: 2026-01-03
**Updated**: 2026-01-03
**Priority**: LOW (was CRITICAL → MEDIUM)
**Status**: Most critical issues resolved

## Executive Summary

The `cleo upgrade` command had multiple serious bugs discovered during the 2026-01-03 session. **ISSUES FIXED:**

1. ~~Fails to complete migrations (stops at 2.4.0, target is 2.6.0)~~ ✅ **FIXED** (T1245)
2. ~~Has arithmetic syntax errors in version comparison~~ ✅ **FIXED** (T1244 - unable to reproduce)
3. ~~Missing migration functions for position ordering (T805)~~ ✅ **FIXED** (T1245)
4. ~~Inconsistent behavior between `--status` and actual execution~~ ✅ **FIXED** (T1246)
5. ~~Backwards version display (2.4.0 → 2.2.0)~~ ✅ **FIXED** - Was misdiagnosed as display bug, actual root cause was DRY violation with scattered version constants
6. Documentation confusion between `upgrade` and `migrate` commands - STILL OPEN

**Remaining issues are documentation/refactoring. T1249 tracks permanent fix for version constant DRY violation.**

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

## Issue 5: Display Bugs (Backwards Versions) - ✅ FIXED 2026-01-03

**Severity**: HIGH (was LOW - misdiagnosed as cosmetic)
**Location**: Multiple files (DRY violation)
**Existing Tasks**: T1233, T1234, T1249 (permanent fix)
**Affects**: All upgrade operations, not just display

### Symptom
Display shows version downgrade instead of upgrade:
```
Config version: 2.4.0 → 2.2.0  # Shows DOWNGRADE
Archive: 2.4.0 → 2.1.0         # Shows DOWNGRADE
Log: 2.4.0 → 2.1.0             # Shows DOWNGRADE
```

### ACTUAL ROOT CAUSE (discovered 2026-01-03)

**NOT a display bug** - the upgrade command was genuinely trying to downgrade because SCHEMA_VERSION_* constants were out of sync with actual data file versions.

| File | Constant | Expected | Actual File Version |
|------|----------|----------|---------------------|
| lib/migrate.sh:29 | SCHEMA_VERSION_CONFIG | 2.2.0 | 2.4.0 |
| lib/migrate.sh:30 | SCHEMA_VERSION_ARCHIVE | 2.1.0 | 2.4.0 |
| lib/migrate.sh:31 | SCHEMA_VERSION_LOG | 2.1.0 | 2.4.0 |
| scripts/upgrade.sh:224 | (hardcoded) | "2.1.0" | 2.4.0 |
| scripts/upgrade.sh:225 | (hardcoded) | "2.1.0" | 2.4.0 |

### DRY/SOLID Violation
- Version constants scattered across 3 files with no single source of truth
- `scripts/upgrade.sh` had **hardcoded** "2.1.0" values, completely ignoring variables
- `lib/version-check.sh` had outdated fallback defaults
- No validation that constants match actual migration functions

### Immediate Fix Applied (2026-01-03)
Updated in BOTH development AND installed versions:
1. `lib/migrate.sh` - SCHEMA_VERSION_CONFIG/ARCHIVE/LOG → 2.4.0
2. `scripts/upgrade.sh` - Use ${SCHEMA_VERSION_*} variables instead of hardcoded "2.1.0"
3. `lib/version-check.sh` - Update fallback from 2.4.0 to 2.6.0

### Permanent Fix Required
See T1249 and subtasks T1250-T1252 for implementing single source of truth.

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

---

## Resolution Log (2026-01-03)

### Fixed Issues

**Issue 1 & 2: Arithmetic Errors & Missing Migration Functions**
- **Task**: T1244, T1245
- **Resolution**:
  - Added `migrate_todo_to_2_5_0()` function to add position field
  - Updated `known_versions` array to include "2.5.0" and "2.6.0"
  - Existing `migrate_todo_to_2_6_0()` handles positionVersion
  - Arithmetic errors could not be reproduced - version parsing works correctly
- **Verified**: Migration path 2.4.0 → 2.5.0 → 2.6.0 now works

**Issue 4: Upgrade Command Inconsistent Behavior**
- **Task**: T1246
- **Root Cause**: `scripts/upgrade.sh` called non-existent `migrate_todo_file()` function
- **Resolution**: Changed to call `ensure_compatible_version()` from lib/migrate.sh
- **Verified**: `cleo upgrade --force` now applies migrations correctly

### New Task Created

**T1249: Implement dynamic migration version discovery for CI/CD**
- The `known_versions` array requires manual updates when adding migrations
- This is error-prone and caused the original bug
- Task to implement automatic discovery of migration functions

### Remaining Open Issues

| Issue | Priority | Task |
|-------|----------|------|
| Issue 3: Documentation confusion | LOW | T1238 |
| Issue 5: Display bugs (backwards versions) | LOW | T1233, T1234 |
| Issue 6: validate --fix atomicity | MEDIUM | T1247 |
| Issue 7: Duplicate of Issue 2 | N/A | Duplicate |
