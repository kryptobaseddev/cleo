# T1158: Dedup T1126 Migration Folders

**Task**: T-MSR-W0-2: Dedup T1126 migration folders (20260421000001 + 20260421000002 timestamp collision)
**Status**: complete
**Commit**: 9c2acc4a5

## Decision: 000002 is the canonical folder

### Evidence

**Git timeline:**
1. `5db226b59` (chore: drizzle migration artifacts) - Created `20260421000002_t1126-sentient-proposal-index` in both `packages/core` and `packages/cleo`. This was the FIRST creation.
2. `0f95a0419` (feat T1126: add partial index) - Created `20260421000001_t1126-sentient-proposal-index` in `packages/core` only. Erroneous duplicate, had trailing semicolon (differing content at that point).
3. `9dc59a637` (docs T1093) - Added `20260421000001` to `packages/cleo`. Added erroneously in a docs commit.
4. `be57f432b` (fix T1126: remove trailing statement-breakpoint) - Fixed `000001` in both packages. After this commit, both folders had identical SQL and identical hash `b652cd8db9f1...`.

**SQL diff**: Empty. Both folders contain identical `CREATE INDEX IF NOT EXISTS idx_tasks_sentient_proposals_today`.

**DB journal state** (live `.cleo/tasks.db`):
- ID 9: `20260421000001_t1126-sentient-proposal-index`, hash `b652cd8d...`, `applied_at: null`
- ID 10: `20260421000002_t1126-sentient-proposal-index`, hash `b652cd8d...`, `applied_at: null` (same hash)

**cleo package sync**: Both `000001` and `000002` were present in `packages/cleo/migrations/drizzle-tasks/` before this fix (the task prompt's claim that cleo only had `000002` was based on stale info from before `9dc59a637` added `000001`).

### Action Taken

Deleted the orphan `000001` folder from both packages:
- `packages/core/migrations/drizzle-tasks/20260421000001_t1126-sentient-proposal-index/`
- `packages/cleo/migrations/drizzle-tasks/20260421000001_t1126-sentient-proposal-index/`

### Post-Dedup DB Journal Behavior

Drizzle v1 beta uses name-based filtering (`getMigrationsToRun` in `migrator.utils.js`):
```js
const dbNamesSet = new Set(dbMigrations.map((m) => m.name).filter((n) => n !== null));
return localMigrations.filter((lm) => !lm.name || !dbNamesSet.has(lm.name));
```

After dedup:
- `000001` remains in DB journal (harmless - Drizzle never queries it because the file no longer exists)
- `000002` is NOT in DB journal (by name) - Drizzle will apply it
- `000002` SQL is `CREATE INDEX IF NOT EXISTS` - idempotent, will succeed even if index already exists
- Scenario 2 reconciler does NOT flag `000001` as orphaned because its hash `b652cd8d...` matches `000002` in localHashes

## T1135 Reconciler Code: PRESERVED

The T1135 commit (`d4f65a130`) added two changes to `migration-manager.ts`:

1. **`probeAndMarkApplied` rename-map logic** - Redirects CREATE TABLE probes from intermediate table names (e.g., `tasks_new`) to final names (e.g., `tasks`). Required for T033.

2. **Scenario 3 rename+create branch** - Detects migrations with `RENAME TO + CREATE TABLE` pattern and delegates to `probeAndMarkApplied`. Previously such migrations were silently skipped with `continue`, leaving them unjournaled.

The task prompt characterized this as "added to tolerate [the T1126 duplicate]" but this is inaccurate. The T1135 code is for **T033** (`20260321000000_t033-connection-health`), which uses the SQLite table-rebuild idiom with multiple `CREATE TABLE x_new → RENAME TO x` operations. The T1126 migration (pure `CREATE INDEX`) does NOT trigger the T1135 Scenario 3 code path.

**Removing the T1135 code would re-trigger the original bug**: T033 would be omitted from the journal on every init, Drizzle would re-run T033, the `tasks` table would be dropped and recreated without T944's `role`/`scope`/`severity` columns, and downstream INSERTs would fail with "table tasks has no column named role".

Added a TSDoc NOTE comment in the Scenario 3 block (`packages/core/src/store/migration-manager.ts:381`) explaining this dependency.

## Test Results

Migration-specific tests (all 29 passed):
- `migration-reconcile.test.ts` - 17 tests including T1135 regression tests
- `idempotent-migration.test.ts` - 7 tests
- `migration-retry.test.ts` - 5 tests

Pre-existing failures (unrelated to this change):
- `performance-safety.test.ts` - Timing-based flaky tests (509ms vs 500ms threshold)
- `t311-integration.test.ts` Scenario 13 - Bundle lifecycle test, pre-dates this work

## Files Changed

- `/mnt/projects/cleocode/packages/core/migrations/drizzle-tasks/20260421000001_t1126-sentient-proposal-index/migration.sql` - DELETED
- `/mnt/projects/cleocode/packages/cleo/migrations/drizzle-tasks/20260421000001_t1126-sentient-proposal-index/migration.sql` - DELETED
- `/mnt/projects/cleocode/packages/core/src/store/migration-manager.ts` - Added T1158 TSDoc NOTE comment preserving T1135 code with justification
