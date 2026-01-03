# URGENT: Migration System Fix Required - HIGHEST PRIORITY

**Priority**: CRITICAL - BLOCKING PRODUCTION
**Created**: 2026-01-03
**Epic**: T1243
**Primary Task**: T1245

---

## IMMEDIATE ACTION REQUIRED

The migration system is broken. Users cannot upgrade from schema 2.4.0 to 2.6.0. The position ordering feature (T805) was shipped but the migration functions were never implemented.

**YOU MUST FIX THIS BEFORE ANY OTHER WORK.**

---

## The Problem

```
$ cleo upgrade --status
→ Shows: todo needs 2.4.0 → 2.6.0

$ cleo upgrade --force
→ Does nothing. Stays at 2.4.0.
→ WARNING: Final version (2.4.0) doesn't match target (2.6.0)
```

### Root Cause
Two migration functions are **completely missing** from `lib/migrate.sh`:
1. `migrate_todo_to_2_5_0()` - Add `position` field
2. `migrate_todo_to_2_6_0()` - Add `positionVersion` field

T1226 was marked DONE but the migration was never actually implemented.

---

## What You Need To Do

### Step 1: Read the bug documentation
```bash
cat docs/bugs/UPGRADE-COMMAND-ISSUES.md
```

### Step 2: Implement the missing migrations in `lib/migrate.sh`

Add these functions (after existing migrate_todo_to_2_4_0):

```bash
migrate_todo_to_2_5_0() {
    local file="$1"
    # Add position field to all tasks
    # Assign positions by createdAt order within each parent scope
    # Position 1, 2, 3... per sibling group

    jq '
      .schemaVersion = "2.5.0" |
      .tasks |= (
        group_by(.parentId // "ROOT") |
        map(
          sort_by(.createdAt) |
          to_entries |
          map(.value + {position: (.key + 1)})
        ) |
        flatten
      )
    ' "$file"
}

migrate_todo_to_2_6_0() {
    local file="$1"
    # Add positionVersion field for optimistic locking

    jq '
      .schemaVersion = "2.6.0" |
      .tasks |= map(. + {positionVersion: (.positionVersion // 0)})
    ' "$file"
}
```

### Step 3: Fix version comparison arithmetic errors
Location: `lib/migrate.sh` lines 455-464
The version parsing creates `"2 2 0"` instead of separate `major=2 minor=2 patch=0`

### Step 4: Update the migration chain
Ensure `run_migration_chain()` calls the new functions in order.

### Step 5: Test the fix
```bash
# Create test project
mkdir /tmp/test-migration && cd /tmp/test-migration
cleo init test

# Downgrade schema version manually for testing
jq '.schemaVersion = "2.4.0"' .cleo/todo.json > tmp && mv tmp .cleo/todo.json

# Run upgrade
cleo upgrade --dry-run
cleo upgrade --force

# Verify
cleo migrate status
# Should show: todo 2.6.0 ✓
```

### Step 6: Commit and deploy
```bash
git add lib/migrate.sh
git commit -m "fix(migrate): Add missing 2.5.0 and 2.6.0 migration functions

Implements position field backfill (2.5.0) and positionVersion (2.6.0).
Fixes arithmetic syntax errors in version comparison.

Closes T1245, T1239
Related: T1243 (epic), T805 (position ordering)

🤖 Generated with [Claude Code](https://claude.com/claude-code)"

git push origin main
```

---

## Reference Tasks

| Task | Title | Action |
|------|-------|--------|
| **T1245** | Implement missing migration functions | PRIMARY - Fix this |
| **T1243** | EPIC: Upgrade Command Production Readiness | Parent epic |
| **T1239** | BUG: Migration missing 2.5.0 and 2.6.0 | Duplicate of T1245 |
| **T1246** | Fix upgrade command inconsistent behavior | Secondary |
| **T805** | Position Ordering System | Feature this enables |

---

## Files To Modify

1. `lib/migrate.sh` - Add migration functions, fix version parsing
2. `schemas/todo.schema.json` - Verify schemaVersion is 2.6.0 (already done)

---

## Success Criteria

- [ ] `cleo upgrade --status` shows no updates needed
- [ ] `cleo migrate status` shows todo at 2.6.0
- [ ] New projects initialize with position fields
- [ ] Existing projects migrate cleanly from 2.4.0 → 2.6.0
- [ ] T1245 marked complete
- [ ] Deployed to main branch

---

## DO NOT

- Do NOT work on other tasks until this is fixed
- Do NOT mark T1245 done until tests pass
- Do NOT skip the version comparison fix (lines 455-464)

---

**This is blocking all users from using position ordering. Fix it now.**
