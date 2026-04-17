# T718 — Studio Tasks Page: Epic Visibility + Active Count Fix

**Date**: 2026-04-15
**Status**: complete
**Agent**: cleo-subagent Worker

---

## Root Cause

Two bugs in `packages/studio/src/routes/tasks/+page.server.ts`:

### Bug 1: Epic LIMIT 20 (line 94 original)

```sql
SELECT id, title FROM tasks WHERE type = 'epic' AND status != 'archived' LIMIT 20
```

Hard-coded `LIMIT 20` meant only 20 of 26 epics were loaded. The Studio "Epic Progress" panel was silently omitting 6 epics.

### Bug 2: Total count included archived tasks

```js
total: Object.values(statusMap).reduce((a, b) => a + b, 0)
```

This summed ALL statuses including `archived` (506 tasks), producing a "Total" of 720 — far above the meaningful active total of 214.

---

## Fixes Applied

**File**: `packages/studio/src/routes/tasks/+page.server.ts`

### Fix 1 — Remove LIMIT 20, add ORDER BY

```sql
SELECT id, title FROM tasks WHERE type = 'epic' AND status != 'archived' ORDER BY id
```

Removed arbitrary cap. Added `ORDER BY id` for deterministic ordering. All 26 epics now load.

### Fix 2 — Total excludes archived tasks

```js
total:
  (statusMap['pending'] ?? 0) +
  (statusMap['active'] ?? 0) +
  (statusMap['done'] ?? 0) +
  (statusMap['cancelled'] ?? 0),
```

Now `stats.total = 214`, matching `cleo stats totalActive: 214`.

**Note**: `stats.active` was already correct — it reads `statusMap['active']` which is 1 from the DB, matching `cleo stats summary.active: 1`. The Active counter display was always pulling the right value.

---

## Verification

### DB truth (sqlite3 direct query)

```
active|1
archived|506
cancelled|3
done|92
pending|118
```

```
Epic count (non-archived): 26
```

See full list at `.cleo/agent-outputs/T718-evidence/epic-count-verification.txt`

### cleo stats truth source

```json
{
  "pending": 118,
  "active": 1,
  "done": 92,
  "cancelled": 3,
  "totalActive": 214,
  "byType": { "epic": 26, "task": 119, "subtask": 69 }
}
```

### Studio values after fix

| Field | Before | After | cleo stats |
|-------|--------|-------|------------|
| Total | 720 (incl. archived) | 214 | totalActive: 214 |
| Active | 1 | 1 | active: 1 |
| Epics shown | 20 | 26 | byType.epic: 26 |

---

## Quality Gates

- `pnpm biome check --write packages/studio/src/routes/tasks/+page.server.ts` — PASSED (1 formatting fix applied)
- `pnpm --filter @cleocode/studio build` — PASSED (3.16s, no errors)
- `pnpm --filter @cleocode/studio test` — PASSED (198/198 tests)

---

## Files Changed

- `packages/studio/src/routes/tasks/+page.server.ts` — 2 logic changes + biome formatting
