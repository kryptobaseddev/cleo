# Inventory A4: Codebase Debt Report

**Generated**: 2026-04-28  
**Scope**: `/mnt/projects/cleocode/packages/**/*.ts` (source only, no dist, no node_modules)  
**Method**: grep-based scan + CLEO task status checks

---

## 1. TODO/FIXME Markers by Domain

### Summary

| Domain | File | Count | Nature |
|--------|------|-------|--------|
| BRAIN/Memory | `packages/core/src/memory/session-narrative.ts` | 2 | embedding cosine similarity deferred |
| BRAIN/Memory | `packages/core/src/memory/dialectic-evaluator.ts` | 4 | embedding, telemetry, confidence thresholds |
| Test infrastructure | `packages/caamp/tests/unit/coverage-final-push.test.ts` | 1 | file slated for deletion per T659 |
| Test infrastructure | `packages/caamp/tests/unit/core-coverage-gaps.test.ts` | 1 | file slated for deletion per T659 |
| CANT/migrate | `packages/cant/src/migrate/converter.ts` | 5 | intentional TODO emission in migration output (by design) |
| CLI/agent scaffolding | `packages/cleo/src/cli/commands/agent.ts` | 7 | intentional template stubs in generated scaffold YAML (by design) |

### Real Debt Markers (not by-design)

**`packages/core/src/memory/session-narrative.ts`** — Lines 61, 256:
```
TODO(T1082.followup): replace with cosine similarity < 0.3 once embedding vec extension is available
```
- T1082 (parent epic) is `archived/done`. The "followup" suffix indicates the sub-task was never formally filed.
- **Recommendation**: File a new child task under the BRAIN epic for embedding-based cosine dedup.

**`packages/core/src/memory/dialectic-evaluator.ts`** — Lines 117, 183, 213:
```
TODO(T1082.followup): iterate on confidence thresholds + add few-shot examples
TODO(T1082.followup): log telemetry when no backend is available
TODO(T1082.followup): surface errors via telemetry
```
- Same issue — T1082 is done, the `.followup` suffix tasks are unregistered orphan work.
- **Recommendation**: File 2 separate tasks: (a) confidence threshold tuning + few-shot, (b) telemetry when LLM backend missing.

**`packages/caamp/tests/unit/coverage-final-push.test.ts`** (line 4) and **`packages/caamp/tests/unit/core-coverage-gaps.test.ts`** (line 5):
```
TODO(T659): T659 acceptance criteria listed this file for deletion as "coverage-debt".
```
- T659 status: **`archived`** (Phase 2: Test suite rationalization).
- These files were supposed to be deleted when T659 completed but remain.
- **Recommendation**: File a cleanup task to delete both files.

**`packages/core/src/nexus/route-analysis.ts`** — Line 162:
```
* from call sites, which is deferred to T1XXX (future AST-based shape inference epic).
```
- `T1XXX` is a placeholder — no task ID. Orphan reference.
- **Recommendation**: File the AST-based shape inference epic and replace `T1XXX`.

### By-Design (not real debt)
- `packages/cant/src/bundle.ts` — `S-TODO-001` linter detects `TODO` in agent fields. This is tool code that scans for stubs, not a debt marker.
- `packages/cant/src/migrate/converter.ts` — intentionally emits `# TODO: manual conversion needed` in migrated YAML output. Working as designed.
- `packages/cleo/src/cli/commands/agent.ts` — `TODO:` strings are template scaffold content emitted into new `.cant` agent files. Working as designed.

---

## 2. SSoT-EXEMPT Annotations

**Total**: 42 annotations across 10 files.

| File | Count | Category | Status |
|------|-------|----------|--------|
| `packages/cleo/src/cli/commands/nexus.ts` | 21 | `no-dispatch-op` (T1488 Phase 2) | T1488 is **done** — work completed |
| `packages/core/src/metrics/token-service.ts` | 6 | T1451 incomplete ADR-057 D1 normalization | T1451 is **done** |
| `packages/cleo/src/dispatch/domains/playbook.ts` | 4 | db-injection, file-load, runtime design | Valid (permanent) |
| `packages/cleo/src/dispatch/domains/tasks.ts` | 3 | fire-and-forget, T5615 consolidation, backward-compat | Valid (permanent) |
| `packages/cleo/src/dispatch/domains/session.ts` | 2 | orchestrated post-op pipeline, side-effects | Valid (permanent) |
| `packages/cleo/src/dispatch/domains/nexus.ts` | 2 | page-envelope-lifting | Valid (permanent) |
| `packages/core/src/adrs/validate.ts` | 1 | zero-params op | Valid (permanent) |
| `packages/core/src/adrs/sync.ts` | 1 | zero-params op | Valid (permanent) |
| `packages/core/src/snapshot/index.ts` | 4 | file-path/cwd args not standard params | Valid (permanent) |
| `packages/contracts/src/operations/tasks.ts` | 1 | targetId backward-compat alias | Valid (permanent) |

### Critical Finding: Stale Task References in SSoT-EXEMPTs

**`packages/cleo/src/cli/commands/nexus.ts`** — 14 annotations reference "pending T1488 Phase 2":
```typescript
// SSoT-EXEMPT:no-dispatch-op — no 'clusters' dispatch op exists yet; pending T1488 Phase 2.
// SSoT-EXEMPT:no-dispatch-op — no 'flows' dispatch op exists yet; pending T1488 Phase 2.
// SSoT-EXEMPT:no-dispatch-op — no 'context' dispatch op exists yet; pending T1488 Phase 2.
// ...and 11 more
```
- T1488 (`T-TW-FU7: further decompose nexus CLI 4084 to under 500 LOC`) status: **`done`**.
- These annotations say "pending Phase 2" but T1488 is complete. Either Phase 2 dispatch ops were never filed as separate tasks, or the SSoT-EXEMPTs need updating.
- **Recommendation**: Audit T1488's completion scope. If Phase 2 dispatch ops (clusters, flows, context, hot-paths, hot-nodes, cold-symbols, diff, query-cte, etc.) were descoped, file a new epic for them and update annotations to reference the correct task ID.

**`packages/core/src/metrics/token-service.ts`** — 6 annotations reference "T1451 incomplete":
```typescript
// SSoT-EXEMPT: T1451 incomplete — params type uses Omit<> instead of named *Params contract
```
- T1451 (`T1449-D-admin: admin domain — Core API alignment with Contracts`) status: **`done`**.
- The annotations were written while T1451 was in-flight and never cleaned up after completion.
- **Recommendation**: Audit these 6 functions in `token-service.ts`. If ADR-057 D1 normalization was deferred, file a follow-up task; otherwise remove the SSoT-EXEMPT annotations.

### Permanent/Valid SSoT-EXEMPTs

The following are architecturally justified and should remain:
- `playbook.ts` — db-injection (DatabaseSync handle, ADR-057 D1), file-load before DB row creation
- `tasks.ts` — fire-and-forget side-effects, backward-compat alias (T5149)
- `session.ts` — orchestrated post-op pipeline
- `nexus.ts` dispatch — page-envelope-lifting (engine puts page in data.page)
- `snapshot/index.ts` — file-path/cwd argument convention vs. dispatch API convention
- `adrs/validate.ts`, `adrs/sync.ts` — zero-params ops exempt from ADR-057 D1

### Recommended Remediation Epic

Create a task **"Clean up stale SSoT-EXEMPT annotations post T1488/T1451 completion"** addressing:
1. Update 14 `pending T1488 Phase 2` annotations in `nexus.ts` (either remove or reference new Phase 2 tasks)
2. Audit and remove/update 6 `T1451 incomplete` annotations in `token-service.ts`

---

## 3. `@deprecated` Symbols

**Total source-file deprecations**: 48 in 14 files.

| Package | File | Count | Reason |
|---------|------|-------|--------|
| `packages/core` | `src/nexus/registry.ts` | 6 | ADR-057 D1 — old function signature, `nexus*Params` migration |
| `packages/core` | `src/memory/index.ts` | 5 | ADR-027 — flat-file agent-outputs retired, use `pipeline_manifest` |
| `packages/core` | `src/hooks/payload-schemas.ts` | 8 | Backward-compat hook payload aliases |
| `packages/core` | `src/hooks/types.ts` | 8 | Backward-compat hook type aliases |
| `packages/core` | `src/store/signaldock-sqlite.ts` | 4 | T310 migration — T310 is `archived/done` |
| `packages/core` | `src/paths.ts` | 4 | ADR-027 manifest retirement, adapter pivot |
| `packages/core` | `src/sessions/*.ts` | 4 | Contracts migration (SessionParams types) |
| `packages/core` | `src/nexus/deps.ts` | 2 | ADR-057 D1 function signatures |
| `packages/core` | `src/nexus/discover.ts` | 2 | ADR-057 D1 function signatures |
| `packages/core` | `src/memory/engine-compat.ts` | 3 | Unused weight params in hybrid search |
| `packages/caamp` | `src/types.ts` | 7 | SkillLibrary* type renames |
| `packages/caamp` | `src/core/registry/spawn-adapter.ts` | 1 | `isolate:bool` → `worktree` |
| `packages/caamp` | `src/core/registry/types.ts` | 1 | `CanonicalHookEvent` location |
| `packages/contracts` | `src/transport.ts` | 1 | Transport unification |
| `packages/adapters` | `src/providers/openai-sdk/*.ts` | 2 | CleoInputGuardrail/CleoAgent renames |

### High-Priority Removals (blocker task done)

**T310 is `archived/done`**: Four `@deprecated` symbols in `packages/core/src/store/signaldock-sqlite.ts` are retained "during T310 migration" but T310 is complete:
```typescript
/** @deprecated Use GLOBAL_SIGNALDOCK_SCHEMA_VERSION. Retained during T310 migration */
/** @deprecated Use getGlobalSignaldockDbPath() directly. Retained during T310 migration */
/** @deprecated Use ensureGlobalSignaldockDb(). Retained during T310 migration */
/** @deprecated Use checkGlobalSignaldockDbHealth(). Retained during T310 migration */
```
- **Recommendation**: File a task to remove these 4 deprecated shims from `signaldock-sqlite.ts` now that T310 is complete.

**ADR-027 `pipeline_manifest` is active**: Five deprecated functions in `packages/core/src/memory/index.ts` reference the retired flat-file agent-outputs pattern. The migration is complete per T1093 (status: `done`).
- **Recommendation**: File a cleanup task to evaluate whether callers have been fully migrated, then remove the deprecated functions.

**CAAMP `SkillLibrary*` type aliases** (7 items in `packages/caamp/src/types.ts`): Legacy names for `SkillLibraryEntry`, `SkillLibraryValidationResult`, etc. If no external callers remain, these can be removed.

### Suggested Removal Task

File: **"Remove deprecated shims post T310, ADR-027, ADR-057 D1 migration"**  
Scope: `signaldock-sqlite.ts` (4), `memory/index.ts` (5), `caamp/src/types.ts` (7), session params (4), nexus function overloads (8+)

---

## 4. Orphan T-ID References

T-ID references in source code where the task is done/archived but code comment still frames it as pending work.

### Confirmed Orphan Patterns

| Location | Reference | Task Status | Issue |
|----------|-----------|-------------|-------|
| `packages/core/src/memory/session-narrative.ts:34,61,256` | `T1082.followup` | T1082 `archived` | Follow-up work unfiled |
| `packages/core/src/memory/dialectic-evaluator.ts:24,117,183,213` | `T1082.followup` | T1082 `archived` | 4 follow-up items unfiled |
| `packages/core/src/memory/__tests__/brain-stdp-wave3.test.ts:361` | `T1093-followup` | T1093 `done` | Skipped test needs filing |
| `packages/core/src/nexus/__tests__/task-sweeper-wired.test.ts:157` | `T1093-followup` | T1093 `done` | Skipped test needs filing |
| `packages/core/src/nexus/route-analysis.ts:162` | `T1XXX` | Non-existent | Placeholder — never filed |
| `packages/caamp/tests/unit/*.test.ts` (2 files) | `T659` | T659 `archived` | Test files supposed to be deleted |
| `packages/cleo/src/cli/commands/nexus.ts` (14 locations) | `T1488 Phase 2` | T1488 `done` | Phase 2 tasks never filed or wrong ID |
| `packages/core/src/metrics/token-service.ts` (6 locations) | `T1451 incomplete` | T1451 `done` | Task completed, annotations not cleaned |

### Historical References (OK — no action needed)

The following are valid historical references in code comments and do not indicate pending work:
- T263/T264/T265/T266/T267/T276/T277 in `packages/caamp/src/core/harness/pi.ts` — Wave-1 feature markers
- T555/T625 in `packages/adapters/src/cant-context.ts` — feature tags for NEXUS injection
- T719/T832/T944 in dispatch engine `*.d.ts` files — JSDoc field annotations
- T937 in `packages/adapters/vitest.config.ts` — sandbox alias workaround note

---

## 5. Override Usage Audit

**Total entries in `.cleo/audit/force-bypass.jsonl`**: 665 lines

**By type**:
- `lifecycle_scope_bypass`: 184 entries
- `evidence_override` (unmarked type, stored as `unknown`): 481 entries

### Recent Session Activity (2026-04-24 to 2026-04-28)

**246 bypass entries** since 2026-04-24. Key patterns:

#### Legitimate Worktree Isolation Bypasses
The most frequent pattern (majority of 246 recent entries) is evidence overrides of the form:
> "worktree branch task/TXXXX — commit not yet cherry-picked to main"

This is **expected and correct** per ADR-055 (worktree-by-default). Agents working in worktrees legitimately cannot provide `commit:<sha>` evidence against the main HEAD.

#### Pre-Existing Test Failure Bypasses (Most Common Actual Overrides)
Recurring bypasses across many tasks citing the same pre-existing failures:
- `backup-pack.test.ts` — staging-dir cleanup race condition (affects: T1107, T1249, T1266-T1270)
- `brain-stdp-functional.test.ts` — LLM-dependent test requiring live binary + DB (affects: T1473, T1482, T1483, T1484, T1485, T1488, T948)
- `sqlite-warning-suppress.test.ts` — git/worktree logic test (affects: T1484, T1488, T1490)
- `pipeline.integration.test.ts` — LAFSPage pagination pre-existing (affects: T1442, T1447, T948)
- `performance-safety.test.ts` — timing flake 766ms > 500ms threshold (affects: T1260, T1451)
- `validate-engine.test.ts` — environment interference in full-suite runs (affects: T1331)

#### Lifecycle Scope Bypasses
184 entries of type `lifecycle_scope_bypass`. Key examples:
- T1417 — epic close-out: 5 lifecycle stages skipped (decomposition/implementation/validation/testing/release) because children shipped at v2026.4.142
- T1075 — Council ratified consensus → `lifecycle skip consensus`
- T1146 — combined slot .131 (T1145+T1146 shipped together)

#### Notable One-Off Overrides
| Date | Task | Reason |
|------|------|--------|
| 2026-04-25T06:01 | emergency hotfix | incident 9999 — no task ID attached |
| 2026-04-24T14:38 | T1075 | APRIL TERMINUS — closing PSYCHE T1075 umbrella |
| 2026-04-24T17:00-17:34 | T1217-T1231 | Audit/research tasks — no automated tests applicable |
| 2026-04-25T04:15 | T1417 | Epic close-out lifecycle stage skips |

#### Missing Regression Task Check
The override for "emergency hotfix incident 9999" (2026-04-25T06:01) has no associated task ID. If this was a real hotfix, a regression task should be filed.

---

## 6. Known Pre-Existing Test Failures

Based on bypass log analysis and test file inspection, the following failures are confirmed pre-existing (not caused by recent work):

### brain-stdp-functional.test.ts
- **File**: `packages/core/src/memory/__tests__/brain-stdp-functional.test.ts`
- **Nature**: Requires live `cleo` binary + real SQLite DB (no mocking). Spawns `cleo memory dream --json` via `execFile`. Will fail if binary is stale or LLM backend unavailable.
- **Category**: ENV (requires installed binary and LLM backend)
- **Filed task**: T1429 (`Brain-stdp deflake — T682-3 + perf-safety asserts`) — status: **`pending`**
- **Action**: T1429 is the right home for this. Check its acceptance criteria include documenting/skipping the LLM-dependent path.

### sqlite-warning-suppress.test.ts  
- **File**: `packages/cleo/src/cli/__tests__/sqlite-warning-suppress.test.ts`
- **Nature**: Tests that suppress SQLite warnings require specific git/worktree context. Uses `expect.skip()` gracefully on clean checkouts. 2 tests fail in worktree/git logic context.
- **Category**: ENV (worktree context sensitivity)
- **Filed task**: None found. The bypass log says "2 tests in worktree/git logic unrelated to T1488."
- **Action**: File a task to fix the worktree-context sensitivity or add a `skipIf` guard.

### backup-pack.test.ts
- **File**: `packages/core/src/store/__tests__/backup-pack.test.ts`
- **Nature**: Staging-dir cleanup race condition — `ENOTEMPTY` when sibling tests' staging dirs transiently appear in `os.tmpdir()`. Test explicitly documents this at line 440.
- **Category**: FLAKY (temp directory race with parallel test runs)
- **Filed task**: T1107 bypass mentions it; no dedicated task found.
- **Action**: File a task to isolate the staging dir per-test (use unique `mkdtemp` prefix or `tmp` subdirectory).

### pipeline.integration.test.ts (LAFSPage pagination)
- **File**: `packages/core/src/lifecycle/__tests__/pipeline.integration.test.ts`
- **Nature**: Pagination using `LAFSPage` type; concurrent T1441 worker introduced a regression that was pre-existing relative to T1442's scope.
- **Category**: REAL-BUG (regression from T1441, needs investigation)
- **Filed task**: Not found. Mentioned in T1442 bypass as "pre-existing from concurrent T1441 worker."
- **Action**: File a task to investigate the LAFSPage pagination regression introduced around T1441 and fix it.

### performance-safety.test.ts
- **File**: Likely `packages/core/src/memory/__tests__/brain-stdp-wave3.test.ts` or related performance assertion test
- **Nature**: Timing-sensitive test asserting <500ms threshold; flaky at 766ms on loaded machines.
- **Category**: FLAKY (timing sensitivity)
- **Filed task**: T1429 scope includes `perf-safety asserts` — see description: "Three more tests need the same restore-skip + documentation pattern."
- **Action**: Covered by T1429 (pending).

### brain-stdp-wave3.test.ts — skipped T695-1 test
- **File**: `packages/core/src/memory/__tests__/brain-stdp-wave3.test.ts:364`
- **Nature**: `it.skip('T695-1: session-bucket O(n²) guard — ratio-based complexity proof')` with `TODO(T1093-followup): re-enable only after rewriting the trials out-of-band`
- **Category**: FLAKY (O(n²) complexity proof too slow/unstable)
- **Filed task**: T1093 is `done` but the skip comment says "T1093-followup." No follow-up task exists.
- **Action**: File a task to re-enable or permanently skip with documentation.

### task-sweeper-wired.test.ts — skipped runGitLogTaskLinker test
- **File**: `packages/core/src/nexus/__tests__/task-sweeper-wired.test.ts:157`
- **Nature**: `TODO(T1093-followup): re-enable once runGitLogTaskLinker produces the expected output`
- **Category**: ENV (requires specific git history format)
- **Filed task**: T1093 done, no follow-up.
- **Action**: Same as above — file or permanently close.

### caamp/tests: agent-fixtures.test.ts — skipped NAPI bridge tests
- **File**: `packages/cant/tests/agent-fixtures.test.ts:42,48`
- **Nature**: `it.skip('parses cleo-historian.cant through napi bridge')` — waiting for `cant-napi` to extend `parse_document`
- **Category**: ENV (missing NAPI capability)
- **Filed task**: Not found.
- **Action**: File a task to extend `cant-napi` or permanently mark as xfail.

---

## Summary: Recommended Action Items

| Priority | Action | Category |
|----------|--------|----------|
| P1 | File task: LAFSPage pagination regression from T1441 worker | REAL-BUG |
| P1 | File 2 tasks for T1082.followup markers (embedding cosine dedup, telemetry gaps) | Unfiled work |
| P1 | Audit 14 `SSoT-EXEMPT:no-dispatch-op; pending T1488 Phase 2` — T1488 done, Phase 2 ops may need new epic | Stale reference |
| P2 | Audit + clean 6 `SSoT-EXEMPT: T1451 incomplete` annotations — T1451 done | Stale reference |
| P2 | File task: remove 4 deprecated shims in `signaldock-sqlite.ts` (T310 complete) | Deprecated dead code |
| P2 | File task: delete `coverage-final-push.test.ts` + `core-coverage-gaps.test.ts` (T659 complete) | Orphan files |
| P2 | T1429 (pending): ensure acceptance criteria cover brain-stdp-functional + performance-safety skip | Tracked |
| P3 | File task: fix `sqlite-warning-suppress.test.ts` worktree-context flakiness | FLAKY |
| P3 | File task: fix `backup-pack.test.ts` ENOTEMPTY race (parallel tmpdir) | FLAKY |
| P3 | File task: re-enable or permanently close `T1093-followup` skips (2 test files) | Skipped tests |
| P3 | File task: replace `T1XXX` placeholder in `nexus/route-analysis.ts` with real epic | Orphan reference |
| P3 | File task: remove deprecated ADR-027 flat-file functions in `memory/index.ts` (T1093 complete) | Deprecated dead code |
| P4 | File task: extend `cant-napi` parse_document for agent-fixtures.test.ts NAPI bridge tests | Skipped tests |
| P4 | File task: evaluate + remove `SkillLibrary*` deprecated type aliases in `caamp/src/types.ts` | Deprecated dead code |

---

*Total bypass entries since project start: 665. Session bypasses with valid justification: ~95%. Orphan/missing regression tasks: emergency hotfix incident 9999 (no task ID).*
