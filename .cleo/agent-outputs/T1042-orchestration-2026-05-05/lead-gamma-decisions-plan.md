# Lead Gamma — T1824 Decision Storage Wave Plan

**Date**: 2026-05-05
**Lead**: Gamma (Research/Planning — no code written)
**Epic**: T1824 Decision Storage Consolidation + Programmatic ADR Management

---

## Current State

### T1826 Schema — DISCREPANCY RESOLVED

T1826 status in the task DB is **pending** (not done), but its three child subtasks are all **done**:
- T1853 (schema + contracts): DONE — commit `c3c130066`, migration `20260504000001_t1826-decisions-v2/migration.sql` merged
- T1854 (CLI + operations contract): DONE — commit `d8b6fbe4` merged via worktree integration
- T1860 (test fixture hotfix for T1853 regression): DONE — commit `5e480532d`

**Root cause of discrepancy**: T1826 parent task has `gates: {implemented: true, testsPassed: false, qaPassed: false}`. The `testsPassed` and `qaPassed` gates were not verified at the T1826 parent level — only at the subtask level. T1826 needs final parent-level gate verification before it can be completed. The schema work IS fully landed in `main`.

**Bottom line**: The schema is in production. All downstream tasks (T1825/T1827/T1828/T1829/T1830) that depend on T1826 can proceed. T1826 itself needs one final `cleo verify T1826` pass to close it out.

### Existing decision-store path

- Schema: `packages/core/src/store/memory-schema.ts` — `brainDecisions` table, all T1826 columns present (`adrNumber`, `adrPath`, `supersedes`, `supersededBy`, `confirmationState`, `decidedBy`, `validatorRunAt`)
- Write function: `packages/core/src/memory/decisions.ts` — `storeDecision()` already accepts `adrPath`, `supersedes`, `confirmationState`, `decidedBy` params and writes them. **`adrNumber` is NOT yet auto-assigned in `storeDecision()` — the schema has the column but the app-level `SELECT MAX(adr_number)+1` sequence helper is absent from `storeDecision()`.**
- CLI: `packages/cleo/src/cli/commands/memory.ts` — `--adr-path`, `--supersedes`, `--confirmation-state`, `--decided-by` flags added by T1854
- Drizzle migration: `packages/core/migrations/drizzle-brain/20260504000001_t1826-decisions-v2/migration.sql` — applied and merged

### ADR Migration Scope

- `docs/adr/` — **13 files**, ADR-051 through ADR-063, plus `adr-cleoos-sentient-harness.md` (unnumbered). Max numbered ADR: **063**.
- `.cleo/adrs/` — **54 files** (53 numbered + `adr-index.jsonl` + `MANIFEST.jsonl`). Max numbered ADR in .cleo/adrs/: **ADR-067** (project-root-resolution, from T1864). ADR-055 through ADR-067 range spans both locations with gaps (ADR-060 missing, ADR-064/065/066 missing from .cleo/adrs/).
- **No file-level conflict**: The 13 `docs/adr/` files (ADR-051 to ADR-063) overlap numerically with existing `.cleo/adrs/` files (which also have ADR-051 through ADR-054 plus ADR-067). Worker must audit exact overlaps before moving — some ADR numbers may have two different files in the two directories with different content (see ADR-051: `docs/adr/` has `ADR-051-override-patterns.md` vs `.cleo/adrs/` has `ADR-051-programmatic-gate-integrity.md` — **DIFFERENT files for same number**).

### Contracts reference mismatch

`packages/contracts/src/operations/memory.ts` lines 281 and 792 still document `adrPath` as `"docs/adr/ADR-027.md"` in example comments. After T1825 migration this example should read `.cleo/adrs/ADR-027.md`. Minor but must be updated in T1825.

### cleo docs publish — no ADR integration yet

`packages/core/src/docs/docs-ops.ts` `publishDocs()` is a generic file-copy function. It has no knowledge of ADR numbering, `brain_decisions` table writes, or `.cleo/adrs/` path targeting. T1827 must extend this function (or create a new `publishAdr()` wrapper) to:
1. Auto-assign `adrNumber` via `SELECT MAX(adr_number)+1` within a transaction
2. Write the file to `.cleo/adrs/ADR-NNN.md`
3. Create/update the `brain_decisions` row with `adrPath` and `adrNumber`

### LLM-validator — dialectic subsystem available

`packages/core/src/memory/dialectic-evaluator.ts` has `evaluateDialectic()` using `claude-sonnet-4-6` backend. A separate `packages/core/src/validation/protocols/architecture-decision.ts` exists with `validateArchitectureDecisionTask()` and `checkArchitectureDecisionManifest()`. **No pre-write hook is wired into `storeDecision()` or `publishDocs()` today.** T1828 must add the hook at the `storeDecision()` call site in `decisions.ts`.

### AGT-* dispatch outcomes — currently in brain_decisions

`packages/core/src/agents/execution-learning.ts` generates `AGT-{hex}` IDs and writes them as `type: 'tactical'` rows into `brain_decisions`. The `brain_patterns` table also receives `P-agt-{hex}` IDs. No separate `agent_dispatch_outcomes` table exists. T1830 must decide: separate table vs type-discriminated column.

### adrNumber sequence gap — T1826 subtask gap

The schema has `adr_number INTEGER UNIQUE` and the migration SQL uses `MAX(adr_number)+1` in comments, but `storeDecision()` in `decisions.ts` does NOT yet call the sequence helper. The `adrNumber` field is in `StoreDecisionParams` but `decisions.ts` never populates it — the row is built with `adrPath: params.adrPath` but no `adrNumber: ...` line. **This is the load-bearing gap T1827 must fix as part of the publish wire-in.**

---

## Wave Plan

### Wave 0 — Complete T1826 parent gates (prerequisite, fast)

**T1826** — Status: pending / gates: implemented=true, testsPassed=false, qaPassed=false
- Work: Run `pnpm run test` and `pnpm biome check`, verify gates, call `cleo verify T1826 --gate testsPassed --evidence "tool:test"` + `--gate qaPassed --evidence "tool:lint;tool:typecheck"`, then `cleo complete T1826`.
- This is a verification-only task (no code). Takes ~5 minutes.
- **Unblocks**: T1825, T1827, T1828, T1830 (all depend on T1826 in the task graph).

### Wave 1 — Parallel-safe after T1826 complete

Three tasks can run in parallel once T1826 is marked done:

#### T1825 — Migrate docs/adr/ → .cleo/adrs/
- **Dependency**: T1826 done
- **Pre-work audit required**: The worker MUST first compare the numeric overlap between `docs/adr/` and `.cleo/adrs/`. ADR-051 is confirmed to be two DIFFERENT files:
  - `docs/adr/ADR-051-override-patterns.md` (Override Patterns — When and How to Use CLEO_OWNER_OVERRIDE)
  - `.cleo/adrs/ADR-051-programmatic-gate-integrity.md` (Programmatic Gate Integrity)
  - **This is the owner's HITL decision point** (see Open Questions below).
- **Safe work**: Move the 13 docs/adr/ files with no conflicts (ADRs 055-063 likely don't overlap with .cleo/adrs/ content — confirm with filename scan).
- **Ref updates**: `packages/agents/README.md`, `packages/contracts/README.md`, `packages/core/README.md`, `packages/core/migrations/README.md`, `packages/contracts/src/operations/memory.ts` (example comments) all reference `docs/adr/`.
- **Test impact**: `packages/core/src/sessions/__tests__/briefing-docs.test.ts` line 62 has `path: 'docs/adr/ADR-001.md'` — update or note as test-fixture string.
- **File paths to touch**: Every file found by `grep -r "docs/adr" packages/ --include="*.ts" --include="*.md"`.

#### T1828 — LLM-validator hook
- **Dependency**: T1826 done
- **Model**: `claude-sonnet-4-6` — already wired in `dialectic-evaluator.ts`. Task description says "project default model" which resolves to sonnet-4-6 per session context. No new model provisioning needed.
- **Trigger surface**: Pre-write hook in `storeDecision()` in `packages/core/src/memory/decisions.ts`. Secondary hook in `publishDocs()` / the new `publishAdr()` wrapper that T1827 creates (coordinate with T1827 on hook insertion point).
- **Hook architecture**: The existing `verifyCandidate` gate at lines 131-146 of `decisions.ts` is the injection point pattern. Add a `validateDecisionConflicts()` call before the existing gate — outputs `{collisions, contradictions, supersession_graph_violations, confidence}`. On `confidence < threshold` → throw `E_DECISION_VALIDATOR_FAILED`. Bypass: `CLEO_OWNER_OVERRIDE=1`.
- **Error code**: `E_DECISION_VALIDATOR_FAILED` does not exist in contracts yet — worker must add to `packages/contracts/src/errors.ts` (or equivalent error registry).
- **Configurable threshold**: Default 0.7 — store in project config `.cleo/config.json` key `decisions.validatorConfidenceThreshold` or fall back to hardcoded 0.7.
- **Test**: Unit test in `packages/core/src/memory/__tests__/decisions.test.ts` — mock the LLM call, assert rejection on low confidence, assert bypass works with override flag.

#### T1830 — AGT-* dispatch outcome separation
- **Dependency**: T1826 done
- **Recommendation**: Option (b) — add `decision_category` TEXT column with check constraint `('architectural', 'agent_dispatch', 'other')`. Rationale: option (a) requires a new table + migration + new CLI surface; option (b) is one additive migration, one CLI filter update. Both paths are valid but (b) is lower blast radius given the existing `brain_decisions` accessor and query machinery.
- **Migration**: New Drizzle migration file `packages/core/migrations/drizzle-brain/20260505000001_t1830-decision-category/migration.sql` — `ALTER TABLE brain_decisions ADD COLUMN decision_category TEXT NOT NULL DEFAULT 'architectural'`. Backfill `UPDATE brain_decisions SET decision_category='agent_dispatch' WHERE id LIKE 'AGT-%'`.
- **Call site update**: `packages/core/src/agents/execution-learning.ts` `recordAgentExecution()` must pass `decision_category: 'agent_dispatch'` on write.
- **Query filter**: `cleo memory decision-find` default filter adds `WHERE decision_category='architectural'`.
- **Size**: small — one migration, two TS file edits, one CLI filter.

### Wave 2 — Sequential after Wave 1

#### T1827 — Wire cleo docs publish → ADR-creation flow
- **Dependencies**: T1826 done (current dep) + T1825 done (logical — must know canonical .cleo/adrs/ path is live)
- **Core change**: Create `publishAdr()` in `packages/core/src/docs/docs-ops.ts` (or extend `publishDocs()` with `--as-adr` flag). Must:
  1. Acquire `SELECT MAX(adr_number)+1` within a SQLite transaction using `getBrainDb()`
  2. Write file to `.cleo/adrs/ADR-{NNN:03d}.md` (three-digit zero-padded)
  3. Insert/update `brain_decisions` row with `adrNumber`, `adrPath`, `confirmationState='accepted'`, `decidedBy` from params
  4. Return `{adrNumber, adrPath, decisionId}`
- **Concurrency safety**: Wrap steps 1-3 in a single SQLite transaction. SQLite serializes transactions; no additional lock needed for single-process use. For multi-process safety (parallel worktree spawns), the `UNIQUE` constraint on `adr_number` plus SQLite's WAL mode provides last-writer-loses semantics — the second writer must retry. Add retry loop (max 3 attempts, 50ms backoff).
- **cleo docs publish CLI**: Update the `publish` command in `packages/cleo/src/cli/commands/docs.ts` to add `--as-adr` flag that calls `publishAdr()` instead of `publishDocs()`.
- **Remove human ADR numbering**: Search worker prompts and decomposition templates for any pattern that proposes `ADR-NNN` numbers manually. These must be removed or updated to say "number assigned by schema at publish time." (Search: `grep -r "ADR-0[6-9][0-9]\|ADR-[1-9][0-9][0-9]" packages/ .claude/` for hardcoded numbers in future-facing content.)
- **CI test**: `packages/core/src/docs/__tests__/docs-ops.test.ts` — add parallel publish test that creates two transactions and asserts unique, non-colliding `adr_number` values.

#### T1829 — Backfill walker
- **Dependencies**: T1826 done + T1827 done (need sequence-safe `publishAdr()` available, and canonical .cleo/adrs/ path from T1825)
- **Location**: New script `packages/core/src/tools/adr-backfill-walker.ts` (or `packages/cleo/src/cli/commands/adr-backfill.ts` if CLI-surface needed). Prefer `packages/core/` as a one-time utility per package boundary rules.
- **Scope**: 54 `.cleo/adrs/` files + 13 `docs/adr/` files (post-T1825 migration: all in `.cleo/adrs/`) + O-* observations with `^ADR-\d+` in title.
- **ADR frontmatter parsing**: Use gray-matter or manual YAML header parsing for `Supersedes:` / `Superseded-by:` fields. Files that lack standard frontmatter get `confirmationState='accepted'` and `decidedBy='owner'`.
- **Idempotency**: Check existing `adr_number` before insert. On conflict (row already exists with same `adr_number`), skip.
- **Dry-run first**: `--dry-run` flag required per acceptance criteria. Worker MUST test dry-run before `--apply`.
- **Output**: `.cleo/agent-outputs/T1824-5-backfill-report.md` per acceptance criteria.
- **Size**: large — involves parsing 67+ files and complex supersession graph resolution.

---

## IVTR Strategy per Task

### T1826 — Parent gate closure (no worktree needed)
- **Spawn flags**: `--no-worktree` (verification only, no code)
- **Evidence atoms required**:
  - `cleo verify T1826 --gate testsPassed --evidence "tool:test"`
  - `cleo verify T1826 --gate qaPassed --evidence "tool:lint;tool:typecheck"`
  - `cleo verify T1826 --gate documented --evidence "files:packages/core/src/store/memory-schema.ts"`
- **File paths**: Read-only. Must NOT touch code.
- **Test invocation**: `pnpm run test` (root) — expect 758 passed, 18 skipped, 35 todo per T1853 evidence.

### T1825 — ADR migration
- **Spawn flags**: default (worktree)
- **Key acceptance gate**: `docs/adr/` directory removed or emptied + all refs updated
- **Evidence atoms required**:
  - `cleo verify T1825 --gate implemented --evidence "commit:<sha>;files:packages/agents/README.md,..."`
  - `cleo verify T1825 --gate testsPassed --evidence "tool:test"`
  - `cleo verify T1825 --gate qaPassed --evidence "tool:lint;tool:typecheck"`
  - `cleo verify T1825 --gate documented --evidence "files:.cleo/adrs/..."`
- **HITL gate**: If ADR number collision found (same number, different content in both dirs), worker MUST call `cleo orchestrate pending` equivalent and block — do NOT auto-resolve.

### T1828 — LLM-validator hook
- **Spawn flags**: default (worktree)
- **Key files**:
  - `packages/core/src/memory/decisions.ts` (hook injection)
  - `packages/contracts/src/errors.ts` (new error code)
  - `packages/core/src/memory/__tests__/decisions.test.ts` (unit tests)
- **Evidence atoms required**:
  - `cleo verify T1828 --gate implemented --evidence "commit:<sha>;files:packages/core/src/memory/decisions.ts,packages/contracts/src/errors.ts"`
  - `cleo verify T1828 --gate testsPassed --evidence "tool:test"` — must show validator rejection test passing
  - `cleo verify T1828 --gate qaPassed --evidence "tool:lint;tool:typecheck"`
  - `cleo verify T1828 --gate securityPassed --evidence "note:hook is pre-write only, no new network surface beyond existing dialectic LLM calls"`

### T1830 — AGT-* separation
- **Spawn flags**: default (worktree)
- **Key files**:
  - New migration: `packages/core/migrations/drizzle-brain/20260505000001_t1830-decision-category/migration.sql`
  - `packages/core/src/agents/execution-learning.ts`
  - `packages/cleo/src/cli/commands/memory.ts` (decision-find filter)
  - `packages/core/src/store/memory-schema.ts` (schema column)
- **Evidence atoms required**:
  - `cleo verify T1830 --gate implemented --evidence "commit:<sha>;files:packages/core/migrations/...,packages/core/src/agents/execution-learning.ts"`
  - `cleo verify T1830 --gate testsPassed --evidence "tool:test"`
  - `cleo verify T1830 --gate qaPassed --evidence "tool:lint;tool:typecheck"`

### T1827 — Publish wire-in
- **Spawn flags**: default (worktree)
- **Key files**:
  - `packages/core/src/docs/docs-ops.ts` (new `publishAdr()`)
  - `packages/cleo/src/cli/commands/docs.ts` (`--as-adr` flag)
  - `packages/core/src/docs/__tests__/docs-ops.test.ts` (parallel concurrency test)
- **Evidence atoms required**:
  - `cleo verify T1827 --gate implemented --evidence "commit:<sha>;files:packages/core/src/docs/docs-ops.ts,..."`
  - `cleo verify T1827 --gate testsPassed --evidence "tool:test"` — must show concurrency test passing
  - `cleo verify T1827 --gate qaPassed --evidence "tool:lint;tool:typecheck"`
  - `cleo verify T1827 --gate documented --evidence "files:packages/core/src/docs/docs-ops.ts"` (TSDoc on publishAdr)

### T1829 — Backfill walker
- **Spawn flags**: default (worktree)
- **Pre-condition**: T1825 and T1827 must be complete (files migrated + sequence available)
- **Key files**:
  - `packages/core/src/tools/adr-backfill-walker.ts` (new)
  - `.cleo/agent-outputs/T1824-5-backfill-report.md` (output artifact)
- **Evidence atoms required**:
  - `cleo verify T1829 --gate implemented --evidence "commit:<sha>;files:packages/core/src/tools/adr-backfill-walker.ts"`
  - `cleo verify T1829 --gate testsPassed --evidence "tool:test"` OR dry-run output verification
  - `cleo verify T1829 --gate documented --evidence "files:.cleo/agent-outputs/T1824-5-backfill-report.md"`
  - `cleo verify T1829 --gate cleanupDone --evidence "note:dry-run report reviewed before --apply; manual review queue documented"`

---

## Open Questions for HITL

### CRITICAL — ADR number collision between docs/adr/ and .cleo/adrs/

**Evidence**: `docs/adr/ADR-051-override-patterns.md` (Override Patterns) and `.cleo/adrs/ADR-051-programmatic-gate-integrity.md` (Gate Integrity) are two different files with the same ADR number.

**Impact**: At least ADR-051 through ADR-054 have name mismatches between the two directories (e.g., `docs/adr/` has `ADR-054-migration-system-hybrid-path-a-plus.md` while `.cleo/adrs/` has different content). These cannot be silently merged.

**Decision needed from owner before T1825 proceeds**:
- Option A: `docs/adr/` ADRs take precedence (rename `.cleo/adrs/` conflicts with a suffix like `-legacy`)
- Option B: `.cleo/adrs/` ADRs take precedence (archive the `docs/adr/` versions with `-docs-legacy` suffix)
- Option C: Both are valid; assign new sequential numbers to the `docs/adr/` files that conflict (they are different decisions, not duplicates)
- Option D: Full manual audit — present collision matrix to owner for individual decisions

**Recommended**: Option C or D. The two directories were built independently. Merging silently would destroy provenance. T1825 worker should generate the collision matrix and block on HITL before applying.

### LLM-validator model + confidence threshold

**Question**: The task description says "project default model" but does not specify what the threshold should be for REJECTING a write. The `dialectic-evaluator.ts` uses `GLOBAL_TRAIT_CONFIDENCE_THRESHOLD = 0.6` for traits.

**Decision needed**:
- What confidence threshold below which `storeDecision()` rejects? (Suggest: 0.7)
- Should the validator fire on ALL `storeDecision()` calls, or only on ADR-typed decisions (those with `adrPath` set or `confirmationState='accepted'`)?
- Should the validator fire in test environments? (Suggest: skip if `CLEO_ENV=test`)

### T1829 backfill scope — O-* observation promotion

**Question**: The acceptance criteria say `O-* observations matching ^ADR-\d+ in title or body promoted to decisions rows`. There are thousands of O-* observations. A regex scan of all of them could be expensive.

**Decision needed**:
- Should the walker scan all O-* observations or only observations created before T1826 landed (2026-05-04)?
- Should O-* be promoted (deleted from brain_observations + inserted to brain_decisions) or linked (kept in brain_observations + foreign-key linked to a new brain_decisions row)?

### T1830 separation strategy confirmation

**Question**: The acceptance criteria list both options (a) separate table and (b) type-discriminated column as valid. Plan above recommends (b) for lower blast radius.

**Decision needed**: Owner confirm option (b) `decision_category` column OR request option (a) separate `agent_dispatch_outcomes` table.

---

## New Tasks Proposed

### T-NEW-1: Update storeDecision() to auto-assign adrNumber

The T1826 schema has `adr_number` but `storeDecision()` never populates it. This means that even after T1827 creates `publishAdr()`, calling `storeDecision()` directly (e.g., via `cleo memory decision-store --adr-path ...`) will NOT auto-assign an ADR number — the caller must provide it explicitly.

**Recommendation**: Add a sub-task under T1826 OR fold into T1827 scope: implement `selectNextAdrNumber(db)` helper that runs `SELECT MAX(adr_number)+1 FROM brain_decisions` within a transaction, and call it in `storeDecision()` when `params.adrPath` is set (indicating this is an ADR-class decision). This ensures the CLI path and the publish path both use the same sequence.

**Owner decision required**: Should `adrNumber` only be assigned when `adrPath` is present, or on every `storeDecision()` call where `adrNumber` is not explicitly passed?

### T-NEW-2: Fix adrPath example comment in contracts

`packages/contracts/src/operations/memory.ts` lines 281 and 792 document `adrPath` with example value `"docs/adr/ADR-027.md"`. After T1825 migration this should read `.cleo/adrs/ADR-027.md`. This is a one-line documentation fix; can be bundled with T1825 or T1827.

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| ADR number collision between docs/adr/ and .cleo/adrs/ | HIGH | HITL gate before T1825 proceeds; collision matrix required |
| adrNumber sequence race in multi-worktree parallel publish | MEDIUM | SQLite UNIQUE constraint provides safety net; retry loop in publishAdr() |
| T1828 LLM validator adds latency to every storeDecision() call | MEDIUM | Scope validator to ADR-typed writes only (where adrPath set or adrNumber requested); skip in test env |
| T1829 backfill corrupts existing decisions rows | HIGH | Dry-run required before --apply; idempotency check on adr_number prevents double-insert |
| T1826 parent gate never closed — downstream tasks remain technically "blocked on T1826" | MEDIUM | Wave 0 closes this immediately; unblocks T1825/T1827/T1828/T1830 in parallel |
| T1854 had override-based evidence (not programmatic) for testsPassed | LOW | Pre-existing note states failures were pre-existing; T1860 fixed those; full test suite now passes at 758 files |
| T1827 publishAdr() adds new code path that publishDocs() tests do not cover | MEDIUM | New describe block in docs-ops.test.ts; concurrency test mandatory per acceptance criteria |
| docs/adr/ refs in packages/core/migrations/README.md point to ADR-054, ADR-051 — after migration these relative paths break | MEDIUM | T1825 worker must update all relative path refs; grep target provided above |

---

## Dependency Graph Summary

```
T1826 (Wave 0 — close gates)
  └─→ T1825 (Wave 1, parallel) — migrate docs/adr/ → .cleo/adrs/
  └─→ T1828 (Wave 1, parallel) — LLM-validator hook
  └─→ T1830 (Wave 1, parallel) — AGT-* type separation
       └─→ T1827 (Wave 2, after T1825) — publish wire-in + adrNumber sequence
            └─→ T1829 (Wave 2, after T1827) — backfill walker
```

Wave 1 tasks (T1825, T1828, T1830) are parallel-safe with each other. Wave 2 tasks (T1827, T1829) have logical sequential dependencies on Wave 1.

**Total estimated scope**: 1 closure task (T1826) + 3 parallel Wave 1 + 2 sequential Wave 2. T1829 is the largest (large sizing) and should be spawned last to leverage all schema + path work from prior waves.
