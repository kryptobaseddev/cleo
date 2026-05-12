# Working-Tree Validation — Post-v2026.5.36

**Date**: 2026-05-06
**Session**: ses_20260505154343_764261
**Validator**: Claude Sonnet 4.6 (ad-hoc investigation, no formal task)

---

## Safety Snapshot

Before analysis, a recoverable stash was created and immediately re-applied:

```
stash@{0}: On main: pre-validation-snapshot-2026-05-06
```

The working tree is fully preserved. The stash can be recovered via `git stash show stash@{0}`.

---

## Core Finding: Systematic Commit-Gap Failure

The T1936 worker claimed completion with commit SHA `97ef87dadb5274a741b10d695d2edc582ab937d9`. That commit exists and is reachable, but its contents are CAAMP/paths/bootstrap files — **not** the classify.ts changes. The commit message describes the classify changes in full, but the file list contains:

- `packages/caamp/tests/unit/injector-dedup.test.ts`
- `packages/core/src/__tests__/temp-path-no-pollution.test.ts`
- `packages/core/src/bootstrap.ts`
- `packages/core/src/index.ts` (not the orchestration index)
- `packages/core/src/injection.ts`
- `packages/core/src/paths.ts`
- `packages/paths/src/*`

This is a **worktree isolation breach**: the classify.ts edits were made in the primary/main worktree while the T1936 task branch only received an unrelated commit with the wrong commit message. CLEO's evidence system verified the SHA exists (it does) but could not verify file content integrity against the task branch because the commit-and-merge integration did not include the actual changed files.

Similarly, the T1934 commit `6304c86ab` only added `init-install-templates.test.ts` — the `init.ts` and `seed-install.ts` pragma changes in the working tree postdate T1934 and belong to a different initiative.

---

## File-by-File Analysis

### 1. `packages/core/src/orchestration/classify.ts` (+151 lines)

**Provenance**: T1936 — "Classifier: update getRegisteredAgentIds() to source-of-truth from templates/". Task status: `done`. Evidence SHA `97ef87dad` was captured but does NOT contain this file. The working-tree SHA (`4979c5cf...`) matches the SHA recorded in T1936's evidence atoms, confirming this is the intended T1936 output that was never committed to main.

**Correctness**:

- `getRegisteredAgentIds(db?: DatabaseSync)` — signature change is clean. Optional DB parameter with static fallback is sound architecture.
- `REGISTRY_QUERY_TIERS` const tuple: correct use of `as const`.
- `STATIC_FALLBACK_AGENT_IDS` static list: matches the 5 canonical template names plus `CLASSIFY_FALLBACK_AGENT_ID`. Correct.
- `validateClassifierRules(db?)`: iterates CLASSIFIER_RULES, checks each `agentId` against registered vocabulary. Throws `ClassifierUnregisteredAgentError` on first miss. Correct — preserves T1326 contract.
- DB query: `SELECT DISTINCT agent_id FROM agents WHERE tier IN (?, ?, ?) ORDER BY agent_id ASC` — correct.
- Empty-result fallback: correct — falls through to static list when DB query returns zero rows.
- Exception catch (bare `catch`): falls through to static fallback. Correct for bootstrap/CI resilience.

**Type Safety Issue (LAND-WITH-FIXUP required)**:

Line 312 contains:
```typescript
.all(...(REGISTRY_QUERY_TIERS as unknown as string[])) as Array<{ agent_id: string }>
```

The `as unknown as string[]` on the input arguments violates AGENTS.md: "NEVER use `as unknown as X` type casting chains". The correct fix is to use `typedAll<{ agent_id: string }>` from `packages/core/src/store/typed-query.ts` (the project's canonical pattern for node:sqlite typed queries — T1434). Alternatively, `[...REGISTRY_QUERY_TIERS]` produces a mutable `string[]` without the chain cast. The `as Array<{ agent_id: string }>` on the output is acceptable but also replaced by `typedAll`.

The cast does not affect runtime correctness (node:sqlite accepts string values) and typecheck passes clean, but it violates the project's explicit rule.

**TSDoc**: All new exports have TSDoc. Quality is high — includes `@param`, `@returns`, `@throws`, `@example`, and `@task`/`@epic` tags.

**Imports**: `import type { DatabaseSync } from 'node:sqlite'` — correct `import type` usage.

**Recommendation**: **LAND-WITH-FIXUP** — replace `as unknown as string[]` with `typedAll<{ agent_id: string }>` pattern before committing.

---

### 2. `packages/core/src/orchestration/__tests__/classify.test.ts` (+218 lines)

**Provenance**: T1936 — companion test file. Working-tree SHA `3f662c02...` matches T1936 evidence atoms exactly.

**Test coverage**:

- `getRegisteredAgentIds — live DB (T1936)`: 6 tests covering project-tier agents, custom extra agents, fallback-tier exclusion, empty-result fallback, no-DB fallback, missing-table graceful fallback. All meaningful edge cases.
- `validateClassifierRules (T1936)`: 5 tests covering passes-without-DB, passes-with-full-DB, throws-on-drift, error-fields-correct, end-to-end docs task classification.

**Test pattern**: Uses `:memory:` in-memory SQLite via `DatabaseSync` — correct isolation (no filesystem side effects, avoids the vitest guard).

**Test run results**: 35/35 pass (verified with standalone `vitest run`). 0 failures introduced by this change.

**Import**: `import { DatabaseSync } from 'node:sqlite'` — value import needed here (constructor). Correct.

**Type Safety**: Test helper `makeInMemoryAgentsDb` is properly typed. No `any`/`unknown` shortcuts. `crypto.randomUUID()` for primary keys — fine for tests.

**Recommendation**: **LAND-AS-IS** — tests are correct, well-structured, and fully green.

---

### 3. `packages/core/src/orchestration/index.ts` (+1 line)

**Provenance**: T1936 — exports `validateClassifierRules` from `classify.ts`.

**Change**: `+validateClassifierRules,` added to the re-export block. Single-line change, correct placement, biome-clean.

**Recommendation**: **LAND-AS-IS**

---

### 4. `packages/core/src/init.ts` (±4 lines)

**Provenance**: NOT T1934. The T1934 evidence SHA `7a4bfdf0...` matches the current HEAD version of this file. The working-tree diff shows `applyPerfPragmas` import replacing two inline PRAGMA exec calls. This is T9023 scope ("Wire applyPerfPragmas into one-shot writer DB opens" — currently `pending`).

The pragma replacement is correct: the original `PRAGMA foreign_keys = ON` + `PRAGMA journal_mode = WAL` are a subset of what `applyPerfPragmas` provides. The replacement is strictly more pragmas with no regression. The `busy_timeout` (previously absent from this site) is now set, which is a correctness improvement for concurrent CLI scenarios.

**Type safety**: `await import('./store/sqlite-pragmas.js')` — dynamic import with `.js` extension, correct ESM pattern.

**Recommendation**: **LAND-AS-IS** — correct change, aligns with T9023 intent. Noting that T9023 is `pending`; this change may need to be attributed to T9023 in the commit message.

---

### 5. `packages/core/src/agents/seed-install.ts` (±4 lines)

**Provenance**: Same as init.ts — T9023 scope, NOT T1934. T1934 HEAD SHA differs from working tree SHA.

The change replaces:
```typescript
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');
```
with `applyPerfPragmas(db)` — correct superset replacement. `forceInstallProjectTierAgents` now benefits from busy_timeout, cache_size, mmap, temp_store, and wal_autocheckpoint pragmas.

**Recommendation**: **LAND-AS-IS** — correct T9023 implementation.

---

### 6. `packages/core/src/conduit/local-transport.ts` (±5 lines)

**Provenance**: T9022 scope ("Wire applyPerfPragmas into read-only/inspection DB opens" — `pending`). The original had `WAL + busy_timeout=5000 + FK ON`; replacement via `applyPerfPragmas` is a correct superset. The `busy_timeout` ordering improvement (now first) is a latent correctness fix.

**Recommendation**: **LAND-AS-IS** — correct T9022 implementation.

---

### 7. `packages/core/src/store/conduit-sqlite.ts` (±17 lines)

**Provenance**: T9022/T9023 scope. Three distinct hunks:

1. `ensureConduitDb` (`applyPerfPragmas` replacing 5 inline PRAGMAs): correct superset.
2. `closeConduitDb` (`optimizeBeforeClose` before `close()`): correct pattern, recommended by SQLite docs.
3. `checkConduitDbHealth` (`applyPerfPragmas` on health-check connection): correct — the comment explains why.

**Recommendation**: **LAND-AS-IS** — all three hunks are correct.

---

### 8. `.cleo/.gitignore` (trivial)

**Provenance**: Unknown. The diff removes:
```
# Step 7: Allow specs directory (formal RFC 2119 specs for epics — T1929+)
!specs/
!specs/**
```

**Risk**: The `.cleo/.gitignore` uses a deny-all pattern (`*` at top). Removing the `!specs/` allow-rule means future files placed in `.cleo/specs/` will be silently ignored by git. The existing `T1929-canonical-agent-system-spec.md` is already tracked (already has a commit) so it is unaffected.

Whether this removal is intentional depends on whether specs are expected to go in `.cleo/specs/` going forward. Given the rcasd/ directory structure already has `specs/` subdirectories per epic, and the T1929 spec was the only file there, this may be a deliberate cleanup. However, the change could silently swallow future spec additions.

**Recommendation**: **INVESTIGATE-FURTHER** — owner should confirm whether `.cleo/specs/` is deprecated in favor of `.cleo/rcasd/{epic}/specification/`. If deprecated, the removal is correct; if not, restore the allow-rule.

---

### 9. `.cleo/project-context.json` (trivial)

**Provenance**: Auto-generated by `cleo init` — `detectedAt` timestamp updated, `outputDir: "dist"` added to `build` section.

The `outputDir` addition is a legitimate improvement (the build output dir is factual project information). The timestamp update is expected auto-detection drift.

**Recommendation**: **LAND-AS-IS** — both changes are correct and innocuous.

---

### 10. `AGENTS.md` (trivial)

**Provenance**: CAAMP injection. The diff removes the trailing newline from the file's last line. This is a known CAAMP injection trailing-newline issue.

**Recommendation**: **LAND-AS-IS** (or restore newline — either is fine, this is cosmetic).

---

### 11. `CLAUDE.md` (trivial)

**Provenance**: Same as AGENTS.md — CAAMP injection trailing-newline removal. The last line changes from `<!-- gitnexus:end -->\n` to `<!-- gitnexus:end -->` (no trailing newline).

**Recommendation**: **LAND-AS-IS** (cosmetic).

---

## Pre-Existing Test Failures (NOT introduced by these changes)

Two test failures exist across the full suite and are unrelated to the 11 uncommitted files:

| Test | Status | Root Cause |
|------|--------|-----------|
| `psyche-wave4.test.ts > hot pass differs across sessions` | pre-existing flaky | Session-scoped observation count assertion (race condition in session fixture setup) |
| `revert-integration.test.ts > reverts 3 sentient merge commits` | pre-existing failure | `E_NOT_INITIALIZED` in temp dir — test isolation issue |

Neither failure involves classify.ts, init.ts, conduit-sqlite.ts, or any of the modified files. Confirmed by running the classify test file in isolation (35/35 pass).

---

## Final Summary Table

| File | Net Lines | Task | Correctness | Issues | Recommendation |
|------|-----------|------|-------------|--------|----------------|
| `orchestration/classify.ts` | +151 | T1936 (done, uncommitted) | Correct | `as unknown as string[]` cast violates AGENTS.md | **LAND-WITH-FIXUP** |
| `orchestration/__tests__/classify.test.ts` | +218 | T1936 (done, uncommitted) | Correct, 35/35 pass | None | **LAND-AS-IS** |
| `orchestration/index.ts` | +1 | T1936 (done, uncommitted) | Correct | None | **LAND-AS-IS** |
| `init.ts` | ±4 | T9023 (pending) | Correct | Commit attribution to T9023 | **LAND-AS-IS** |
| `agents/seed-install.ts` | ±4 | T9023 (pending) | Correct | Commit attribution to T9023 | **LAND-AS-IS** |
| `conduit/local-transport.ts` | ±5 | T9022 (pending) | Correct | Commit attribution to T9022 | **LAND-AS-IS** |
| `store/conduit-sqlite.ts` | ±17 | T9022/T9023 (pending) | Correct | Commit attribution to T9022/T9023 | **LAND-AS-IS** |
| `.cleo/.gitignore` | -4 | Unknown | Risky | Removes specs/ allow-rule | **INVESTIGATE-FURTHER** |
| `.cleo/project-context.json` | ±3 | Auto-detected | Correct | None | **LAND-AS-IS** |
| `AGENTS.md` | ±1 | CAAMP injection | Cosmetic | Trailing newline | **LAND-AS-IS** |
| `CLAUDE.md` | ±1 | CAAMP injection | Cosmetic | Trailing newline | **LAND-AS-IS** |

---

## Proposed Hotfix Commit Scope

These files are ready for the v2026.5.37 hotfix commit (pending owner sign-off on the `.gitignore` question and the classify.ts fixup):

**Group A — T1936 classifier changes (requires fixup first)**:
- `packages/core/src/orchestration/classify.ts` — fix `as unknown as string[]` → `typedAll<>` first
- `packages/core/src/orchestration/__tests__/classify.test.ts` — clean
- `packages/core/src/orchestration/index.ts` — clean

**Group B — T9022/T9023 pragma centralization**:
- `packages/core/src/init.ts`
- `packages/core/src/agents/seed-install.ts`
- `packages/core/src/conduit/local-transport.ts`
- `packages/core/src/store/conduit-sqlite.ts`

**Group C — Infrastructure / housekeeping**:
- `.cleo/project-context.json`
- `AGENTS.md`
- `CLAUDE.md`

**Blocked** (requires HITL):
- `.cleo/.gitignore` — requires owner confirmation that `.cleo/specs/` allow-rule removal is intentional

---

## Blockers / HITL Escalations

1. **classify.ts `as unknown as string[]` fixup** — must replace with `typedAll<{ agent_id: string }>` from `store/typed-query.ts` before landing. This is a minor fixup, not a blocker for the intent of the change.

2. **`.cleo/.gitignore` specs allow-rule removal** — owner must confirm: is `.cleo/specs/` deprecated in favor of `.cleo/rcasd/{epic}/specification/`? If yes, include the change. If no, restore the allow-rule.

3. **Commit attribution for T9022/T9023** — the pragma changes belong to those pending tasks. If the hotfix commit is meant to close T9023 and T9022 (partial), the commit message should reference them. If T9022/T9023 are meant to be separate commits, split the hotfix accordingly.

---

## Worker-Discipline Pattern Observed

The T1936 evidence commit SHA (`97ef87dad`) is a real, reachable commit but contains entirely different files from what the evidence atoms list. The evidence system validated:
- Commit reachability: PASS (commit exists)
- File SHA256: captures the working-tree file hash, not the committed file hash

This means the staleness check in the evidence system was satisfied by the working-tree file at verify time, but the subsequent commit (by a different agent or in a different worktree branch) landed different files. The T1936 task was marked `done` based on evidence that was correct at snapshot time but whose corresponding code was never merged to main.

This is the v2026.5.36 release gap: the release commit (`89314d102`) does not contain the T1936 classify.ts changes because they were in the primary worktree, not in a task branch.
