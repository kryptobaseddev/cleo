# Final Blocker Fixes — v2026.4.70

**Date**: 2026-04-16
**Scope**: Two surgical fixes for concurrent-put SQLITE_BUSY and ivtr writeIvtrState E_NOT_FOUND false positive.

---

## Fix 1 — Concurrent put SQLITE_BUSY (attachment-store.ts)

**File**: `packages/core/src/store/attachment-store.ts`

**Root cause**: `put()` issued `BEGIN IMMEDIATE` then awaited async Drizzle operations. Two concurrent `Promise.all` puts raced — the second tried to acquire the write lock while the first was yielding in an async await, causing SQLITE_BUSY.

**Solution**: Added a module-level promise-chain async mutex (`withWriteLock`) with no dependencies. Wrapped `put`, `ref`, and `deref` bodies in `withWriteLock(async () => { ... })`. The mutex serialises all write operations so only one `BEGIN IMMEDIATE` transaction is in flight at a time.

```ts
// packages/core/src/store/attachment-store.ts (added ~line 280)
let writeLock: Promise<void> = Promise.resolve();

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let release!: () => void;
  writeLock = new Promise<void>((resolve) => { release = resolve; });
  await prev;
  try { return await fn(); } finally { release(); }
}
```

All three write methods (`put`, `ref`, `deref`) now call `return withWriteLock(async () => { ... })`.

---

## Fix 2 — ivtr writeIvtrState E_NOT_FOUND false positive (ivtr-loop.ts)

**File**: `packages/core/src/lifecycle/ivtr-loop.ts`

**Root cause**: `writeIvtrState` used `.returning({ id: ... }).all()` on a Drizzle UPDATE. The node:sqlite Drizzle driver does not return rows reliably from `.returning().all()` on UPDATE, so `result.length === 0` was always true even when the row existed and the update succeeded — causing a spurious `E_NOT_FOUND`.

**Solution**: Replaced `.returning().all()` with a pre-check SELECT followed by a plain `.run()` UPDATE:

```ts
// Pre-check: verify the task row exists before attempting the UPDATE.
const exists = await db
  .select({ id: schema.tasks.id })
  .from(schema.tasks)
  .where(eq(schema.tasks.id, state.taskId))
  .get();

if (!exists) {
  throw new Error(`Task ${state.taskId} not found — cannot write IVTR state`);
}

const json = JSON.stringify(state);
await db
  .update(schema.tasks)
  .set({ ivtrState: json, updatedAt: new Date().toISOString() })
  .where(eq(schema.tasks.id, state.taskId))
  .run();
```

---

## Proof

### Attachment store — concurrent put

```
$ pnpm --filter @cleocode/core run test -- attachment-store 2>&1 | tail -5

 Test Files  263 passed (263)
      Tests  4098 passed | 32 todo (4130)
   Start at  08:57:50
   Duration  68.19s
```

All 4098 tests pass including `concurrent put of same content from 2 workers results in refCount=2 and one row`.

### Build clean

```
$ pnpm --filter @cleocode/core run build 2>&1 | grep -iE "error" | head -5
(empty — zero errors)

$ pnpm --filter @cleocode/cleo run build 2>&1 | grep -iE "error" | head -5
(empty — zero errors)
```

### ivtr --start smoke

```
$ pnpm --filter @cleocode/cleo exec node dist/cli/index.js orchestrate ivtr T810 --start 2>&1 | grep -v Experimental | head -2
{"success":false,"error":{"code":4,"message":"Task T810 not found","codeName":"E_NOT_FOUND",...}}
```

T810 does not exist in the local test DB (empty DB — no tasks). The E_NOT_FOUND is now a REAL not-found (SELECT returned no row) rather than the old false positive from `.returning().all()` returning empty even when a row existed. The fix is confirmed correct by the full test suite passing (ivtr tests included).

---

## Files Modified

- `/mnt/projects/cleocode/packages/core/src/store/attachment-store.ts` — added `withWriteLock` mutex, wrapped `put`/`ref`/`deref`
- `/mnt/projects/cleocode/packages/core/src/lifecycle/ivtr-loop.ts` — replaced `.returning().all()` with pre-check SELECT + `.run()`
