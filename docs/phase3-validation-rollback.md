# Phase 3 Validation and Rollback Plan

**Task**: T4762
**Status**: Active
**Scope**: Verify Phase 3 terminology migration correctness; define revert procedure

---

## What Phase 3 Changed

### T4747 — Type Renames (Complete)
- `TodoFile` -> `TaskFile` (deprecated alias retained)
- `TodoFileExt` -> `TaskFileExt`
- `getTodoPath()` -> `getTaskPath()` (deprecated alias retained)
- `loadTodoFile()` -> `loadTaskFile()` (deprecated alias retained)

### T4733 — Focus -> Start/Stop/Current (Complete)
- **Core module**: `src/core/focus/` re-exports from `src/core/task-work/`
- **Functions**: `setFocus`->`startTask`, `clearFocus`->`stopTask`, `showFocus`->`currentTask`, `getFocusHistory`->`getWorkHistory`
- **Types**: `FocusState`->`TaskWorkState` (deprecated alias retained)
- **Store**: `session-store.ts` canonical names with deprecated aliases
- **Schema**: Already uses `taskWorkHistory`, `currentTask`, `taskStartedAt`
- **MCP operations**: `tasks.start`, `tasks.stop`, `tasks.current` are canonical
- **CLI**: `cleo start`, `cleo stop`, `cleo current` commands exist
- **Session params**: `autoStart` replaces `autoFocus`, `startTask` replaces `focus`

### T4734 — Naming Convention Standardization (Complete)
- All MCP operations use dot.notation (e.g., `decision.log`, `critical.path`)
- Underscore operations converted (e.g., `create_bug` -> `add.bug`)
- camelCase internal function names retained (TypeScript convention)

---

## Validation Checklist

### 1. TypeScript Compilation

```bash
# Filter known pre-existing errors from store layer migration
npx tsc --noEmit 2>&1 | \
  grep -v "task-store\|session-store\|lifecycle-store\|migration-sqlite\|skills.ts\|checksum\|atomic\|validation-schemas\|sql.js" | \
  head -30
```

**Expected**: Zero new errors from Phase 3 changes.

### 2. Test Suite

```bash
npx vitest run 2>&1 | tail -20
```

**Expected**: All tests pass (or only pre-existing failures).

### 3. Grep for Old Names (Source Code)

```bash
# Should return ONLY: deprecated aliases, backward-compat re-exports, migration scripts, test files
grep -r "setFocus\|clearFocus\|showFocus\|getFocusHistory" src/ --include="*.ts" -l | \
  grep -v "__tests__\|test\|spec\|focus/index\.ts\|task-work/index\.ts\|session-store\.ts\|provider\.ts"
```

**Expected**: Zero results outside of deprecated alias locations.

```bash
# Check no focus operations remain as primary MCP operations
grep -r "'focus'" src/dispatch/domains/ --include="*.ts" | \
  grep -v "auto-focus\|deprecated\|alias\|test\|startTask.*focus"
```

**Expected**: Zero results.

### 4. Verify CLI Commands Work

```bash
# Start working on a task
cleo start T001

# Check current task
cleo current

# Stop working
cleo stop

# Session with new flag names
cleo session start --scope epic:T001 --auto-start --name "Test"
cleo session stop
```

### 5. Verify MCP Operations

```bash
# These should all succeed
cleo_query({ domain: "tasks", operation: "current" })
cleo_mutate({ domain: "tasks", operation: "start", params: { taskId: "T001" } })
cleo_mutate({ domain: "tasks", operation: "stop" })
```

### 6. Backward Compatibility

```bash
# Deprecated aliases should still work
cleo start T001   # Maps to cleo start T001
cleo current       # Maps to cleo current
cleo stop      # Maps to cleo stop

# Session --auto-focus still accepted
cleo session start --scope epic:T001 --auto-focus --name "Test"
```

---

## Rollback Procedure

### Pre-requisites
- All Phase 3 commits are on the `main` branch
- No data migration was performed (schema was already correct)

### Step 1: Identify Phase 3 Commits

```bash
# List Phase 3 commits (T4733, T4734, T4747, T4762)
git log --oneline --grep="T4733\|T4734\|T4747\|T4762\|T4727\|T4754\|T4755\|T4750\|T4752\|T4753\|T4756" | head -20
```

### Step 2: Revert Commits

```bash
# Revert in reverse chronological order
git revert --no-commit <commit-hash-newest>
git revert --no-commit <commit-hash-next>
# ... repeat for all Phase 3 commits
git commit -m "revert: Phase 3 terminology migration (T4762 rollback)"
```

### Step 3: Verify After Rollback

```bash
npx tsc --noEmit
npx vitest run
```

### Step 4: Data Migration Rollback

**Not needed** — Phase 3 did not change the SQLite schema. The schema already used `taskWorkHistory`, `currentTask`, and `taskStartedAt` before Phase 3. Phase 3 only changed TypeScript source code (types, function names, MCP operation names).

---

## Smoke Tests Post-Deployment

1. `cleo start T001` -- should set current task
2. `cleo current` -- should show T001
3. `cleo stop` -- should clear current task
4. `cleo session start --scope epic:T001 --auto-start --name "Smoke"` -- should create session
5. `cleo session status` -- should show active session
6. `cleo session stop` -- should end session
7. `cleo find "test"` -- basic task search should work
8. `cleo show T001` -- task details should display
9. `cleo list` -- task listing should work

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Backward-compat aliases break | Low | Medium | Aliases tested via existing test suite |
| External consumers use old names | Medium | Low | All old names are deprecated aliases |
| MCP clients use `session.focus-*` | Low | Medium | Operations removed; error message guides to new ops |
| Data format incompatibility | None | N/A | No data format changes in Phase 3 |

---

**Document Created**: 2026-02-25
**Last Updated**: 2026-02-25
**Task Reference**: T4762
