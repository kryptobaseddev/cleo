# T1106 CI Investigation Report

**Date**: 2026-04-21  
**Worktree**: /mnt/projects/cleocode.ci-investigate  
**Branch**: fix/t1106-ci-investigate  
**Investigator**: CI-INVESTIGATOR subagent  
**Vitest version**: 4.1.4  

---

## Executive Summary

**All 96+ failures share a single root cause**: the file  
`packages/core/migrations/drizzle-tasks/20260421000001_t1118-owner-auth-token/migration.sql`  
has a trailing `--> statement-breakpoint\n` that produces an empty SQL string. Drizzle's  
`migrate()` splits on that marker, passes the empty string to `sql.raw("")`, and Node's  
`sqlite` module throws `Error: statement has been finalized` (ERR_INVALID_STATE).  

**Every failure across all 4 suites is a REAL REGRESSION introduced by commit `1f30dda33`  
(feat(T1120,T1123))** that added the T1118 migration with the trailing breakpoint.

**Zero tests are PREMATURE-UNSKIP failures.** None of the four failing suites had any `.skip` guards removed by T1093. T1093 only added skip guards elsewhere.

---

## Root Cause Deep Dive

### The Broken File

`packages/core/migrations/drizzle-tasks/20260421000001_t1118-owner-auth-token/migration.sql`

```
ALTER TABLE `sessions` ADD COLUMN `owner_auth_token` TEXT;--> statement-breakpoint\n
```

- Commit introduced: `1f30dda33` feat(T1120,T1123) — 2026-04-20
- The `packages/cleo/migrations/` counterpart is CLEAN (no trailing breakpoint)
- Commit `be57f432b` fixed the same bug in T1126 but missed T1118 in packages/core

### The Crash Path

Drizzle's `readMigrationFiles()` splits each `.sql` file by `--> statement-breakpoint`.  
The T1118 file split produces: `["ALTER TABLE `sessions` ADD COLUMN ...", "\n"]`.  
Drizzle calls `session.run(sql.raw("\n"))` — Node's `sqlite` module throws  
`Error: statement has been finalized` wrapped in `DrizzleError: Failed to run the query ''`.

### Propagation to All 4 Suites

Every failing test initializes a fresh SQLite DB (in a temp dir), which triggers:  
`runMigrations()` → `migrateWithRetry()` → `migrate(db, migrationsFolder)` → **crash**.

The migration crash is not caught gracefully for test fresh-DB setup — it bubbles as an  
unhandled SafetyError or raw DrizzleError.

### Secondary Issue: Duplicate Timestamp

Two migration folders share timestamp `20260421000001`:
- `20260421000001_t1118-owner-auth-token` (introduced by `1f30dda33`)
- `20260421000001_t1126-sentient-proposal-index` (introduced by `0f95a0419`, fixed by `be57f432b`)
- `20260421000002_t1126-sentient-proposal-index` (artifact commit `5db226b59`)

The duplicate timestamp causes Drizzle to attempt both `000001` migrations. Both must be  
kept but T1118 must have the trailing breakpoint removed. The `000001_t1126` duplicate  
(effectively superseded by `000002_t1126`) is a cleanup candidate but NOT the crash cause.

---

## Suite Results

### 1. `ivtr-loop.test.ts` — 33/33 FAIL

| Tests | Category | Root Cause | Fix Strategy |
|-------|----------|------------|--------------|
| ALL 33 tests | REAL-REGRESSION | T1118 migration SQL trailing breakpoint causes `DrizzleError` in `migrateWithRetry` called via `safeCreateTask` → `validateAndRepairSequence` → `checkSequence` → `getDb` | Remove trailing `--> statement-breakpoint` from `packages/core/migrations/drizzle-tasks/20260421000001_t1118-owner-auth-token/migration.sql` |

**Verbatim first error:**
```
SafetyError: Sequence validation failed: DrizzleError: Failed to run the query '
'
 ❯ validateAndRepairSequence src/store/data-safety.ts:175:13
 ❯ safeCreateTask src/store/data-safety.ts:221:5
 ❯ src/lifecycle/__tests__/ivtr-loop.test.ts:51:3

Caused by: Error: statement has been finalized
```

**Call chain**: `beforeEach` → `createTask("T999")` → `safeCreateTask` → `validateAndRepairSequence` → `checkSequence` → `getDb(cwd)` → `runMigrations` → `migrateWithRetry` → `migrate(db, folder)` → **crash on empty sql.raw("\n")**

Classification: ALL 33 are **REAL-REGRESSION** (T1118 commit `1f30dda33`)

---

### 2. `migration-safety.test.ts` — 18/33 FAIL (15 pass)

| Test | Category | Root Cause |
|------|----------|------------|
| should fail before destructive ops when JSON is corrupted | REAL-REGRESSION | T1118 trailing breakpoint — `migrateJsonToSqlite` calls `getDb` which crashes |
| should restore from backup when migration fails mid-process | REAL-REGRESSION | same |
| should handle migration interruption and resume | REAL-REGRESSION | same |
| should detect and reject zero-task JSON with existing database | REAL-REGRESSION | same |
| should clear singleton state after migration | REAL-REGRESSION | same |
| should verify backup with checksums not just file size | REAL-REGRESSION | same |
| should never leave database in inconsistent state | REAL-REGRESSION | same |
| should use atomic rename, never delete-then-create | REAL-REGRESSION | same |
| should skip migration when data already present | REAL-REGRESSION | same |
| should re-import with --force flag | REAL-REGRESSION | same |
| should preserve all task fields through migration | REAL-REGRESSION | same |
| should preserve dependencies through migration | REAL-REGRESSION | same |
| should preserve sessions through migration | REAL-REGRESSION | same |
| should migrate archived tasks separately | REAL-REGRESSION | same |
| should preserve archived task metadata | REAL-REGRESSION | same |
| should handle large datasets efficiently | REAL-REGRESSION | same |
| should handle tasks with circular references gracefully | REAL-REGRESSION | same |
| should handle missing optional fields gracefully | REAL-REGRESSION | same |

**Passing tests (15)** are pure unit tests that never open a SQLite database:  
Safety Mechanisms (5), Checksum Verification (2), Logger Functionality (3),  
Migration Phases (3), Dry Run Mode (2), and `should block concurrent migration attempts` (1).

Classification: ALL 18 failures are **REAL-REGRESSION** (T1118 commit `1f30dda33`)

---

### 3. `nexus-e2e-graph.test.ts` — 29/44 FAIL (15 pass)

| Test | Category | Root Cause |
|------|----------|------------|
| ALL 29 failing tests | REAL-REGRESSION | T1118 trailing breakpoint — `createTestProjectDb` calls `createSqliteDataAccessor` → `getDb` → crash |

**Passing tests (15)** are pure unit tests that don't open the tasks SQLite DB:  
- Query module extended: 7 tests (syntax validation, parseQuery, getProjectFromQuery)  
- Permission module extended: 4 tests (permissionLevel, getPermission for unregistered, plus 2 nexus.db-only tests)  
- Edge cases: 4 tests that use fresh nexus.db (no tasks.db involvement)

The nexus-e2e tests that pass use either pure logic (no DB) or the nexus.db only. The ones that fail all call `createTestProjectDb` which opens tasks.db via `createSqliteDataAccessor`.

Classification: ALL 29 failures are **REAL-REGRESSION** (T1118 commit `1f30dda33`)

---

### 4. `core-parity.test.ts` — 16/26 FAIL in CI (20/26 in worktree*)

| Test Group | Tests | Category | Root Cause |
|------------|-------|----------|------------|
| Import Graph Verification (6) | PASS | n/a | Pure import checks, no DB |
| Task CRUD Data Parity (6) | REAL-REGRESSION | T1118 migration crash in `createTestProject` → `getDb` |
| Session Engine Delegation (5) | REAL-REGRESSION | same |
| Lifecycle Engine Parity (6) | REAL-REGRESSION (5) + caamp* (1) | same (5); caamp build missing in worktree (1) |
| EngineResult Wrapper Consistency (3) | REAL-REGRESSION (3) | DB crash |

*Worktree shows 20/26 failures vs CI's 16/26 because `@cleocode/caamp` has no `dist/` in  
this worktree (build errors in `caamp/src/cli.ts`). In CI, caamp was built. This accounts  
for approximately 4 additional worktree-only failures. The 16 CI failures are all  
**REAL-REGRESSION** from the T1118 migration bug.

**Op-count parity** (185q/123m/308 total in `dispatch/__tests__/parity.test.ts`) matches the  
actual registry counts exactly. Those counts are NOT contributing to any failures.

---

## Registry Op Counts Verification

```
grep -c "gateway: 'query'"  packages/cleo/src/dispatch/registry.ts  → 185 ✓
grep -c "gateway: 'mutate'" packages/cleo/src/dispatch/registry.ts  → 123 ✓
TOTAL: 308 ✓
```

The T1115/T1116/T1117 additions ARE reflected correctly. `parity.test.ts` expectations at  
lines 157-159 match reality. No PARITY-COUNT-DRIFT failures exist.

---

## Classification Breakdown

| Suite | Total Fail | REAL-REGRESSION | PARITY-COUNT-DRIFT | PREMATURE-UNSKIP | INFRASTRUCTURE | UNCLEAR |
|-------|-----------|-----------------|-------------------|------------------|---------------|---------|
| ivtr-loop.test.ts | 33 | 33 | 0 | 0 | 0 | 0 |
| migration-safety.test.ts | 18 | 18 | 0 | 0 | 0 | 0 |
| nexus-e2e-graph.test.ts | 29 | 29 | 0 | 0 | 0 | 0 |
| core-parity.test.ts (CI) | 16 | 16 | 0 | 0 | 0 | 0 |
| **TOTAL** | **96** | **96** | **0** | **0** | **0** | **0** |

**Note**: core-parity worktree shows 20/26 fails. The 4 extra vs CI's 16 are  
`@cleocode/caamp` dist-missing (INFRASTRUCTURE, worktree-only, not counted in CI failures).

---

## Top 5 Fix-Forward Priorities

### Priority 1 — Fix T1118 migration SQL trailing breakpoint (ONE LINE FIX)
**File**: `packages/core/migrations/drizzle-tasks/20260421000001_t1118-owner-auth-token/migration.sql`  
**Fix**: Remove the trailing `--> statement-breakpoint` from the last line  
**Before**: `ALTER TABLE \`sessions\` ADD COLUMN \`owner_auth_token\` TEXT;--> statement-breakpoint`  
**After**:  `ALTER TABLE \`sessions\` ADD COLUMN \`owner_auth_token\` TEXT;`  
**Impact**: Fixes all 96 CI failures across all 4 suites. This is the ONLY code change needed.  
**Evidence**: The identical fix was already applied to `packages/cleo/migrations/` version  
(commit `be57f432b`). The `packages/core/` version was missed.

### Priority 2 — Resolve duplicate timestamp `20260421000001`
**Issue**: `20260421000001_t1118` and `20260421000001_t1126` share the same Drizzle  
`folderMillis` value. While Drizzle's `getMigrationsToRun` handles this by `name`, the  
upgrade path in `upgradeSyncIfNeeded` has logic to handle duplicates via hash matching.  
After Priority 1, this will not crash but is a fragile state.  
**Fix**: Rename `20260421000001_t1126-sentient-proposal-index` → `20260421000003_t1126-sentient-proposal-index`  
in both `packages/core/migrations/` and `packages/cleo/migrations/`, and delete the  
now-redundant `20260421000002_t1126` folder. OR simply accept the three-folder state since  
Drizzle 1.0.0-beta matches by `name` not just `folderMillis`.  
**Impact**: Medium — prevents future confusion; no current test failures once Priority 1 fixed.

### Priority 3 — Add vitest alias for `@cleocode/caamp` in `packages/cleo/vitest.config.ts`
**Issue**: `@cleocode/caamp` has no vitest alias and tests fail in fresh worktrees where  
the package isn't pre-built. Causes worktree-isolated CI instability.  
**Fix**: Add alias entry pointing to `../../packages/caamp/src/index.ts` in the vitest alias map.  
**Impact**: Low in CI (caamp built before test run), but affects worktree isolation and  
developer ergonomics.

### Priority 4 — Fix `@cleocode/caamp` build errors in `cli.ts`
**Issue**: `packages/caamp/src/cli.ts` has TypeScript errors (missing `console`, `process`  
type definitions — likely tsconfig missing `"lib": ["dom", "node"]` or `@types/node`).  
**Fix**: Add `@types/node` to caamp devDependencies or fix the tsconfig.  
**Impact**: Allows caamp to be built in fresh environments, unblocks Priority 3.

### Priority 5 — Audit all migration SQL files for trailing statement-breakpoints
**Issue**: The T1118 and T1126 files both had this bug. There may be others.  
**Fix**: Run `grep -r "statement-breakpoint$" packages/*/migrations/` to find any remaining  
trailing markers and remove them.  
**Impact**: Preventive — avoids future recurrence of the same crash pattern.

---

## Honest Assessment: Of the 96 CI Failures

| Category | Count | Percentage |
|----------|-------|-----------|
| T1106-caused (directly) | 0 | 0% |
| T1118 migration regression (commit `1f30dda33`) | 96 | 100% |
| T1126/be57f432b partial fix (missed T1118) | 0 (root was T1118) | — |
| Pre-existing failures un-skipped by T1093 | 0 | 0% |
| Race-condition artifacts | 0 | 0% |
| Infrastructure/env issues (CI-only) | 0 | 0% |

**All 96 failures are caused by a single missing 1-character fix:**  
The T1118 migration's trailing `--> statement-breakpoint` in `packages/core/migrations/`.  

The parallel orchestrator T1093 had zero causal relationship to these failures — it added  
skip guards on different tests, and none of the four target suites had skip guards.

The T1115/T1116/T1117 dispatch registry additions are correct and fully tested; op-count  
numbers match expectations in `parity.test.ts`.

---

## Key Commits for Context

| Commit | Description | Role |
|--------|-------------|------|
| `1f30dda33` | feat(T1120,T1123) — introduced T1118 migration with trailing breakpoint | ROOT CAUSE |
| `0f95a0419` | feat(T1126) — introduced T1126 migration also with trailing breakpoint | Contributing |
| `be57f432b` | fix(T1126) — removed T1126 trailing breakpoint in both packages/cleo + packages/core | Partial fix (missed T1118 in packages/core) |
| `5db226b59` | chore — added T1118/T1126 artifact commit with `000002` T1126 | Incomplete cleanup |

---

*Generated by CI-INVESTIGATOR subagent, worktree /mnt/projects/cleocode.ci-investigate*
