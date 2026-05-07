# T9160 Test Fix Log — 47 Pre-existing Failures Resolved

**Date**: 2026-05-07
**Branch**: task/T9160
**Result**: 0 failures (668 test files, 10841 tests passed)

---

## Root Cause Summary

All failures stemmed from a single architectural change in `getProjectRoot()` / `validateProjectRoot()` (T1864/T9092): the function now requires a candidate directory to have either:
1. `.cleo/project-info.json` with a valid `projectId`, OR
2. `.git/` as a real directory sibling (legacy fallback)

Test fixtures were creating `.cleo/` directories without `.git/` siblings, causing `E_INVALID_PROJECT_ROOT` errors when any function internally called `getProjectRoot(cwd)`.

---

## Failure Categorization and Fixes

### Category (a) — Test expectation drifted from intended behavior (fix: update tests)

All test fixtures that created temp directories with `.cleo/` now also create `.git/` as a real directory (not a file) to satisfy the legacy-fallback path of `validateProjectRoot`.

---

### 1. `src/__tests__/paths.test.ts` — 15 failures

**Pattern**: `getProjectRoot`, `resolveProjectPath`, `getAgentOutputsDir`, `getAgentOutputsAbsolute`, `getManifestPath`, `getManifestArchivePath` test groups each created a tmpdir with `.cleo/` but no `.git/`.

**Fix**: Added `mkdirSync(join(tempDir, '.git'), { recursive: true })` to `beforeEach` in each affected `describe` block.

---

### 2. `src/__tests__/paths-walkup.test.ts` — 1 failure

**Pattern**: AC-1 test "returns the root itself when called directly with the project root" created `.cleo/` but no `.git/`. The test comment said "no sibling check" but the implementation now requires `.git/` even at the start dir.

**Fix**: Added `mkdirSync(join(projectRoot, '.git'), { recursive: true })` with explanatory comment about T9092/T1864 intent.

---

### 3. `src/__tests__/upgrade.test.ts` — 6 failures

**Pattern**: Both `runUpgrade locking (T4723)` and `runUpgrade structural parity` describe blocks created tmpdirs with `.cleo/` but no `.git/`. `runUpgrade` calls `getProjectRoot` internally.

**Fix**: Added `.git/` creation to `beforeEach` in both describe blocks.

---

### 4. `src/lifecycle/__tests__/lifecycle-engine.test.ts` — 5 failures

**Pattern**: `beforeEach` created `TEST_ROOT` with `.cleo/rcasd` but no `.git/`. `lifecycleProgress`, `lifecycleSkip`, `lifecycleHistory`, and gate enforcement functions call `getProjectRoot(projectRoot)` internally.

**Fix**: Added `mkdirSync(join(TEST_ROOT, '.git'), { recursive: true })` in `beforeEach`.

---

### 5. `src/memory/__tests__/engine-compat.test.ts` — 2 failures

**Pattern**: Both `Memory Engine Compat` and `Pipeline Manifest SQLite` describe blocks created testRoot without `.git/`. `pipelineManifestValidate` calls `getProjectRoot` via the `pipelineManifestShow` path.

**Fix**: Added `.git/` creation to `beforeEach` in both describe blocks.

---

### 6. `src/memory/__tests__/pipeline-manifest-sqlite.test.ts` — 11 failures

**Pattern**: `beforeEach` created testRoot with `.cleo/` only. Functions like `pipelineManifestShow`, `pipelineManifestValidate`, `pipelineManifestLink`, and `migrateManifestJsonlToSqlite` call `getProjectRoot` internally.

**Fix**: Added `.git/` creation to `beforeEach`.

---

### 7. `src/orchestrate/__tests__/orchestrate-engine.test.ts` — 1 failure

**Pattern**: `beforeEach` called `seedTasks` which created `.cleo/` but no `.git/`. `orchestrateContext` calls `getProjectRoot`.

**Fix**: Added `mkdirSync(join(TEST_ROOT, '.git'), { recursive: true })` before `seedTasks` in `beforeEach`.

---

### 8. `src/sentient/__tests__/baseline.test.ts` — 2 failures

**Pattern**: Different root cause. `REPO_ROOT` was resolved via `git rev-parse --show-toplevel` which in a git worktree returns the worktree path. The worktree path has `.git` as a FILE (gitlink), which `validateProjectRoot` / `assertProjectInitialized` intentionally rejects (T9092 guard). `captureBaseline(REPO_ROOT, ...)` called `assertProjectInitialized(REPO_ROOT)` and failed.

**Fix**: Changed `resolveRepoRoot()` to use `getProjectRoot(process.cwd())` which correctly follows the gitlink to the main repo path. Falls back to `git rev-parse` for non-CLEO environments.

---

### 9. `src/store/__tests__/migration-v3-columns.test.ts` — 1 failure

**Pattern**: The "upgrade path" test deleted `__drizzle_migrations` entries to simulate a partial upgrade, then re-ran `ensureGlobalSignaldockDb()`. The T9027 fast-path short-circuit reads `_signaldock_meta.schema_version`; since it was set by the first call and not cleared, the second call returned early without running `runSignaldockMigrations()`, leaving the journal empty.

**Fix**: Added `DELETE FROM _signaldock_meta WHERE key = 'schema_version'` after deleting the journal entries, so the next `ensureGlobalSignaldockDb()` call properly re-runs `reconcileJournal` and re-seeds the journal.

---

### 10. `src/store/__tests__/test-db-helper.ts` / `src/tasks/__tests__/loom-auto-init.test.ts` — 2 failures

**Pattern**: `createTestDb()` helper created tmpdir with `.cleo/` but no `.git/`. `initLoomForEpic` and `backfillEpicLoom` call functions that internally invoke `getProjectRoot(projectRoot)`.

**Fix**: Added `.git/` creation to `createTestDb()` helper with explanatory comment. This fix covers all test files that use `createTestDb()`.

---

### 11. `src/__tests__/injection-mvi-tiers.test.ts` — 1 failure

**Pattern**: Template at `packages/core/templates/CLEO-INJECTION.md` was 310 lines but the test asserts `<= 300`. A "Release / Shipping" section (17 lines) added in a recent release commit pushed it over the limit.

**Fix (Category a — trim)**: Removed the "Release / Shipping" section from the template. Release workflow guidance belongs in operator/release documentation, not in the agent injection template. Template now 293 lines (under 300 budget).

---

## Studio Tests (bonus fix)

Studio tests (46 files, 643 tests) were failing due to missing `.svelte-kit/tsconfig.json` in the worktree — SvelteKit generates this via `svelte-kit sync` during build. Fixed by running `packages/studio/node_modules/.bin/svelte-kit sync` in the worktree. Not committed (generated file).

---

## Quality Gates

- `pnpm biome ci .` — PASSED (2153 files, no issues)
- `pnpm run build` — PASSED (all packages)
- `pnpm run typecheck` — PASSED (tsc -b clean)
- `pnpm run test` — PASSED (668 test files, 10841 tests, 0 failures)
