# T5586 — Fix Draft Quality Output

## Step 1: Dangling Draft Release Removal

**Method**: Direct SQLite deletion (no CLI command exists for removing draft releases — the CLI only has `release list`, `release show`, `release plan`, `release ship`, and `release changelog`).

Both draft releases from the audit agent were found in `release_manifests`:
- `v2026.3.17` (status: `prepared`, 7 tasks)
- `v2026.3.18` (status: `prepared`, 11 tasks)

**Command used**:
```sql
DELETE FROM release_manifests WHERE version IN ('v2026.3.18', 'v2026.3.17');
```

**Verification**: `node dist/cli/index.js release list` now shows only the two legitimate pushed releases: `v2026.3.16` (pushed) and `v2026.3.15` (pushed).

## Step 2: Research/Internal Task Filter

**File**: `src/core/release/release-manifest.ts` — `generateReleaseChangelog()`

Added filtering block immediately after the existing epic filters, before `categorizeTask()` is called:

```typescript
// Filter out research/internal/spike/audit tasks — not user-facing deliverables
const labelsLower = (task.labels ?? []).map((l) => l.toLowerCase());
if (labelsLower.some((l) => ['research', 'internal', 'spike', 'audit'].includes(l))) continue;
if (['spike', 'research'].includes((task.type ?? '').toLowerCase())) continue;
if (/^(research|investigate|audit|spike)\s/i.test(task.title.trim())) continue;
```

This covers:
- Tasks with labels: `research`, `internal`, `spike`, `audit`
- Tasks with `type` field set to `spike` or `research`
- Tasks whose title begins with `Research `, `Investigate `, `Audit `, or `Spike ` (case-insensitive)

## Step 3: categorizeTask() Priority Fix

**Problem**: T5587 (a test task titled "Create test fixtures for...") was miscategorized as `Features` because the title keyword scan for `create ` ran before the `test` label check.

**Fix**: Rewrote `categorizeTask()` priority chain in `src/core/release/release-manifest.ts`:

1. **Priority 1** — `task.type` field (`test` → `tests`, `fix`/`bugfix` → `fixes`, `feat`/`feature` → `features`, `docs`/`doc` → `docs`, `chore`/`refactor` → `chores`)
2. **Priority 2** — Conventional commit prefix in raw title (e.g. `feat:`, `fix:`, `test:`)
3. **Priority 3** — Labels (`test`/`testing` checked first before feature labels)
4. **Priority 4** — Title keyword scan (with `test`-prefix check before `create`/`add` checks)
5. **Fallback** — `changes`

The key behavioral change: `task.type === 'test'` now wins immediately before any title keyword is examined, preventing false-positive categorization as `features` when a test task title contains `create`.

## Step 4: TypeScript Compiler

```
npx tsc --noEmit
```

**Result**: No errors. Exit code 0.

## Step 5: Test Suite

```
npx vitest run src/core/release src/core/tasks src/core/sessions
```

**Result**: 571 tests passed across 41 test files. No failures.

Release-specific tests (28 tests in 4 files) all pass:
- `src/core/release/__tests__/artifacts.test.ts` — 8 tests
- `src/core/release/__tests__/changelog-writer.test.ts` — 10 tests
- `src/core/release/__tests__/push-policy.test.ts` — 8 tests
- `src/core/release/__tests__/release.test.ts` — 2 tests
