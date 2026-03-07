# T5586 — Fix CI Test: workHistory sort non-determinism on macOS

## Root Cause

On macOS with fast CPUs, the three `startTask` calls in the test:

```
await startTask('sess-001', 'T001');
await startTask('sess-001', 'T002');
await startTask('sess-001', 'T003');
```

complete within the same millisecond. Each call inserts a row into `task_work_history` with `setAt = new Date().toISOString()`. When all three rows share the same `setAt` value, SQLite's `ORDER BY setAt DESC` produces undefined order, making `history[0].taskId` non-deterministic — sometimes `T002`, sometimes `T003`.

## Fix Applied

**File**: `/mnt/projects/claude-todo/src/store/session-store.ts`
**Line**: 212 (in `workHistory` function)

Added a secondary sort key `id DESC` (auto-increment integer PK) to the `ORDER BY` clause. Because `id` is always strictly increasing — it reflects insertion order — this makes the sort deterministic regardless of timestamp resolution.

**Before:**
```typescript
.orderBy(desc(schema.taskWorkHistory.setAt))
```

**After:**
```typescript
.orderBy(desc(schema.taskWorkHistory.setAt), desc(schema.taskWorkHistory.id))
```

This is the least invasive fix: one line changed in production code, no test structure changes, no setTimeout delays.

## Test Results

### Specific test (session-store.test.ts)
31 passed, 0 failed.

The previously failing test `workHistory > records task work changes in history` now passes consistently.

### Full suite
4327 passed, 0 failed (276 test files).
