# T991 Worker Specifications — BRAIN Integrity Write-Path Guardrails

**Generated**: 2026-04-19 | **Lead**: Lead A (brain-integrity) | **Session**: ses_20260419003330_22e46b

---

## Key Findings from Codebase Survey

- `brain-retrieval.ts:797-814` — `observeBrain` uses inline SHA-256 dedup (lines 797-823), **not** `verifyAndStore`
- `learnings.ts:134`, `patterns.ts:148`, `decisions.ts:176` — all three have inline `createHash('sha256')` dedup, bypassing the gate
- `extraction-gate.ts:565` — `verifyAndStore` already exists and works; `verifyCandidate` at line 346 has no title-prefix blocklist
- `brain-purge.ts:207-248` — prefix classifier already exists (4 rules: `Task start: T`, `Task complete: T`, `Task T`, `Session note:`) — must be ported, not duplicated
- `quality-feedback.ts:343` — `prune_candidate=1` is SET but never DELETEd; no autonomous sweeper exists
- `brain-lifecycle.ts:751-783` — `runConsolidation` has Steps 9a (reward backfill) and 9b (STDP) but **no Step 9a.5** for `correlateOutcomes`; Step 9f does not exist
- `core/src/hooks/handlers/task-hooks.ts:74-77` — `correlateOutcomes` fires via `setImmediate` from task hooks (defense-in-depth path exists, formal path missing)
- `dream-cycle.ts:398-423` — `startDreamScheduler` uses `setTimeout` chaining (drift-prone); `checkAndDream` is the right API to call from tick
- `sentient/tick.ts` — daemon tick already runs via cron; no dream trigger wired
- `core/src/injection.ts:171-179` — `@.cleo/memory-bridge.md` and `@.cleo/nexus-bridge.md` injected unconditionally if files exist; no config gate
- `nexus_relations` schema (`nexus-schema.ts:293-335`) — has `id, projectId, sourceId, targetId, type, confidence, reason, step, indexedAt`; **no `weight`, `last_accessed_at`, or `co_accessed_count`**
- `memory-bridge.ts:248,362` — `writeFileSync` called unconditionally; no mode flag

---

## Dependency Order

```
Wave 1 (parallel): T992, T993, T997, T999
Wave 2 (after T992):  T994, T995
Wave 3 (after T995):  T996
Wave X (independent): T998
```

Rationale: T994 (`correlateOutcomes` step) and T995 (sweeper DELETE) both depend on T992 having clean write-path data flowing in. T996 (dream-daemon wiring) needs T995 done so the daemon has accurate prune signals. T998 (NEXUS plasticity) is a schema migration with no upstream dependency.

---

## T992 — Route observeBrain + storeLearning + storePattern + storeDecision through verifyAndStore

### Files to touch
- `/mnt/projects/cleocode/packages/core/src/memory/brain-retrieval.ts` (primary — `observeBrain`)
- `/mnt/projects/cleocode/packages/core/src/memory/learnings.ts` (`storeLearning`)
- `/mnt/projects/cleocode/packages/core/src/memory/patterns.ts` (`storePattern`)
- `/mnt/projects/cleocode/packages/core/src/memory/decisions.ts` (`storeDecision`)

### Approach
- In `brain-retrieval.ts:797-823`: replace the inline SHA-256 block and the raw `INSERT` with a call to `verifyAndStore` from `extraction-gate.ts`. The `ObservationCandidate` shape must be constructed from the existing `observeBrain` parameters before the call.
- In `learnings.ts`, `patterns.ts`, `decisions.ts`: remove the `createHash` dedup blocks (lines ~134, ~148, ~176 respectively) and delegate to `verifyAndStore` similarly. Each file already has a typed candidate object; wire it through.
- Remove inline `createHash` imports from all 4 files if they become unused after the migration.

### Tests
File: `/mnt/projects/cleocode/packages/core/src/memory/__tests__/dedup-gates.test.ts` (extend existing) or new `write-path-routing.test.ts`

1. Assert `observeBrain` with known-noise title (`Task start: T123`) is rejected by `verifyAndStore` gate
2. Assert `storeLearning` with duplicate content hash does not insert a second row (idempotent)
3. Assert `storePattern` with duplicate content hash returns existing `id` without new insert
4. Assert `storeDecision` with valid unique content inserts exactly once
5. Assert all 4 call paths produce no inline-dedup path: verify `createHash` is not called from `brain-retrieval.ts`, `learnings.ts`, `patterns.ts`, `decisions.ts` (structural test via import audit)
6. Regression: insert noise title via `observeBrain`, assert `brain_observations` count is 0 after call

### Evidence atoms
```
commit:<sha>;files:packages/core/src/memory/brain-retrieval.ts,packages/core/src/memory/learnings.ts,packages/core/src/memory/patterns.ts,packages/core/src/memory/decisions.ts;tool:pnpm-test;tool:biome;tool:tsc
```

---

## T993 — Title-prefix blocklist Check A0 in verifyCandidate

### Files to touch
- `/mnt/projects/cleocode/packages/core/src/memory/extraction-gate.ts` (primary — add Check A0 to `verifyCandidate`)
- `/mnt/projects/cleocode/packages/core/src/memory/brain-purge.ts` (read-only reference — port classifier, do NOT modify)

### Approach
- Export `BRAIN_NOISE_PREFIXES: readonly string[]` const from `extraction-gate.ts` containing the 7 prefixes from the acceptance criteria (`Task start:`, `Session note:`, `Started work on:`, `Fix evidence:`, `Verified:`, `Completed:`, `Auto-generated:`). Cross-reference with `brain-purge.ts:207-248` to ensure full coverage of the one-shot janitor's rules.
- At line ~346 in `verifyCandidate`, add Check A0 as the first guard before any hash/similarity work: if `candidate.title` starts with any `BRAIN_NOISE_PREFIXES` entry → return `{ action: 'rejected', reason: 'noise-prefix' }`.
- Single source of truth: `brain-purge.ts` classifier should import `BRAIN_NOISE_PREFIXES` rather than defining its own list (follow-on cleanup, optional in this task if it risks scope creep — note in code).

### Tests
File: `/mnt/projects/cleocode/packages/core/src/memory/__tests__/dedup-gates.test.ts` (extend)

1. `verifyCandidate` rejects `title: 'Task start: T123'` with `action='rejected'`
2. `verifyCandidate` rejects `title: 'Session note: handoff'` with `action='rejected'`
3. `verifyCandidate` rejects `title: 'Started work on: feature'` with `action='rejected'`
4. `verifyCandidate` rejects `title: 'Fix evidence: commit abc'` with `action='rejected'`
5. `verifyCandidate` rejects `title: 'Verified: T123 done'` with `action='rejected'`
6. `verifyCandidate` passes `title: 'Hebbian plasticity insight'` (legitimate title)
7. `verifyCandidate` passes `title: 'Decision: SQLite over Y.js'` (legitimate title)
8. `BRAIN_NOISE_PREFIXES` is exported and has exactly 7+ entries

### Evidence atoms
```
commit:<sha>;files:packages/core/src/memory/extraction-gate.ts;tool:pnpm-test;tool:biome;tool:tsc
```

---

## T994 — correlateOutcomes Step 9a.5 + trackMemoryUsage wiring

### Files to touch
- `/mnt/projects/cleocode/packages/core/src/memory/brain-lifecycle.ts` (add Step 9a.5 to `runConsolidation`)
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/complete.ts` (add `trackMemoryUsage` call — locate via `cleo complete` dispatch)
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/verify.ts` (add `trackMemoryUsage` call — locate via `cleo verify` dispatch)

**Note**: Worker must first locate the `cleo complete` and `cleo verify` dispatch handlers. Use `grep -rn "operation.*tasks.complete\|tasks\.complete"` in `packages/cleo/src/` to find them. Same for `verify`.

### Approach
- In `brain-lifecycle.ts:runConsolidation`, after Step 9a (reward backfill, ~line 757) and before Step 9b (STDP, ~line 763): add Step 9a.5 that imports and calls `correlateOutcomes` from `quality-feedback.ts`. Wrap in try/catch with `console.warn` identical to other steps. The existing `setImmediate` fire-and-forget in `task-hooks.ts:74-77` stays (defense-in-depth).
- In `cleo complete` and `cleo verify` handlers: import `trackMemoryUsage` from `@cleocode/core` and emit a usage record for the task's memory observations. The `taskId` and `outcome` (`'success'` for complete, `'verified'` for verify) are available from context.

### Tests
File: `/mnt/projects/cleocode/packages/core/src/memory/__tests__/quality-feedback.test.ts` (extend) and new `brain-lifecycle-step9a5.test.ts`

1. `runConsolidation` calls `correlateOutcomes` as Step 9a.5 (mock correlateOutcomes, assert called)
2. Step 9a.5 executes after Step 9a and before Step 9b (verify call order via mock sequence)
3. Step 9a.5 failure does NOT abort consolidation (wrap in try/catch, assert remaining steps run)
4. `trackMemoryUsage` called from `cleo complete` handler with `outcome='success'`
5. `trackMemoryUsage` called from `cleo verify` handler with `outcome='verified'`
6. Integration: complete 2 tasks, assert `brain_retrieval_log` updated with outcome data

### Evidence atoms
```
commit:<sha>;files:packages/core/src/memory/brain-lifecycle.ts,<complete-handler-path>,<verify-handler-path>;tool:pnpm-test;tool:biome;tool:tsc
```

---

## T995 — Step 9f hard-sweeper — autonomous DELETE for prune candidates

### Files to touch
- `/mnt/projects/cleocode/packages/core/src/memory/brain-maintenance.ts` (add Step 9f sweeper function)
- `/mnt/projects/cleocode/packages/core/src/memory/brain-lifecycle.ts` (wire Step 9f into `runConsolidation` after Step 9e)

### Approach
- In `brain-maintenance.ts`: add `runPruneSweep(projectRoot, options?: { dryRun?: boolean; maxDeletePerRun?: number })` that runs the DELETE SQL across the 4 typed tables (`brain_decisions`, `brain_patterns`, `brain_learnings`, `brain_observations`) with the predicate `prune_candidate=1 AND quality_score<0.2 AND citation_count=0 AND age_days>30`. Dry-run mode logs would-delete count and returns without mutating. Write a row to `brain_consolidation_events` for audit trail.
- Config: read `brain.sweeper.maxDeletePerRun` from project config (default 500). Enforce per-run cap.
- In `brain-lifecycle.ts:runConsolidation`: after Step 9e (~line 830), add Step 9f that calls `runPruneSweep`. Same try/catch pattern.
- Age calculation: use `julianday('now') - julianday(created_at) > 30` for SQLite portability.

### Tests
File: `/mnt/projects/cleocode/packages/core/src/memory/__tests__/brain-maintenance.test.ts` (new)

1. Seed 100 rows (50 with `prune_candidate=1, quality_score=0.1, citation_count=0, age>30d`; 50 clean), run sweeper, assert exactly 50 deleted
2. Dry-run mode returns would-delete count but makes 0 DB mutations
3. `maxDeletePerRun=10` caps at 10 deletes even when 50 qualify
4. Rows with `prune_candidate=1` but `quality_score>=0.2` are NOT deleted
5. Rows with `prune_candidate=1, quality_score<0.2, citation_count=1` are NOT deleted (has citations)
6. Delete count written to `brain_consolidation_events` with `trigger='step-9f'`
7. `runConsolidation` includes Step 9f after Step 9e (verify position via mock)

### Evidence atoms
```
commit:<sha>;files:packages/core/src/memory/brain-maintenance.ts,packages/core/src/memory/brain-lifecycle.ts;tool:pnpm-test;tool:biome;tool:tsc
```

---

## T996 — Migrate dream cycle into sentient daemon tick loop

**Dependency**: T995 must ship first (tick triggers make most sense once clean prune signals exist).

### Files to touch
- `/mnt/projects/cleocode/packages/cleo/src/sentient/tick.ts` (add volume + idle dream triggers)
- `/mnt/projects/cleocode/packages/core/src/memory/dream-cycle.ts` (delete `startDreamScheduler` setTimeout pattern ~lines 398-423)

### Approach
- In `tick.ts`: import `checkAndDream` from `dream-cycle.ts`. Add two trigger conditions to `safeRunTick`:
  1. Volume trigger: query `brain_observations` for write count since last dream; if > configurable threshold (default 50), call `checkAndDream(projectRoot, { inline: false })`.
  2. Idle trigger: if no tasks have been picked for N consecutive ticks (track in tick state), call `checkAndDream`.
  - Use cron-aligned scheduling (the daemon already runs `*/5 * * * *`) rather than introducing a separate timer.
- In `dream-cycle.ts:398-423`: delete `startDreamScheduler` and the `nightlyTimer` module-level variable. Keep `checkAndDream` and `triggerManualDream` (those remain valid public APIs). Remove the export from `index.ts` if present.

### Tests
File: `/mnt/projects/cleocode/packages/cleo/src/sentient/__tests__/daemon.test.ts` (extend) or `dream-tick-integration.test.ts`

1. Volume threshold exceeded → `checkAndDream` is called within next tick
2. Volume threshold NOT exceeded → `checkAndDream` is NOT called
3. Idle N ticks reached → `checkAndDream` is called
4. `startDreamScheduler` no longer exported from `dream-cycle.ts`
5. `checkAndDream` invocation failure does NOT crash the tick (handled via `.catch`)
6. Two ticks in rapid succession do not double-invoke dream (idempotency guard)

### Evidence atoms
```
commit:<sha>;files:packages/cleo/src/sentient/tick.ts,packages/core/src/memory/dream-cycle.ts;tool:pnpm-test;tool:biome;tool:tsc
```

---

## T997 — cleo memory promote-explain CLI command

**Wave 1 parallel** — no upstream dependency.

### Files to touch
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/memory.ts` (add `promote-explain` subcommand, ~line 1714 area near existing `verify` subcommand)

### Approach
- Register `cleo memory promote-explain <id>` as a new subcommand in the `memory` command tree. Read-only: no DB writes.
- Query: join `brain_page_edges` (STDP weights) + `brain_retrieval_log` (hit count + last access) + the typed memory table entry (citation_count, quality_score, prune_candidate). Auto-detect which typed table based on the `id` prefix or a fallback scan order.
- Output: human-readable text listing weights, retrieval hits, citation_count, quality_score, prune_candidate, promotion tier (`pending/promoted/rejected`) + reason string. With `--json`: emit LAFS envelope.

### Tests
File: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/__tests__/memory-promote-explain.test.ts` (new)

1. Unknown `<id>` → LAFS error envelope with `E_NOT_FOUND`
2. Promoted entry → output includes `tier: promoted` and non-zero `citation_count`
3. Rejected entry → output includes `tier: rejected` and `prune_candidate: true`
4. Pending entry → output includes `tier: pending` with explanation
5. Entry with no STDP data → output degrades gracefully (`weights: none`)
6. Entry with no citations → `citation_count: 0` shown without error
7. `--json` flag emits valid LAFS envelope with `success: true`

### Evidence atoms
```
commit:<sha>;files:packages/cleo/src/cli/commands/memory.ts;tool:pnpm-test;tool:biome;tool:tsc
```

---

## T998 — NEXUS plasticity migration (weight + last_accessed_at + strengthenNexusCoAccess)

**Wave X independent** — no upstream dependency from T991 wave. Can run in parallel with Wave 1.

### Files to touch
- `/mnt/projects/cleocode/packages/core/src/store/nexus-schema.ts` (add 3 columns to `nexusRelations`)
- `/mnt/projects/cleocode/packages/core/src/store/` — Drizzle migration file (new, filename: `0NNN_nexus-plasticity.sql` or equivalent per project convention — worker must check existing migration files for naming pattern)
- `/mnt/projects/cleocode/packages/core/src/memory/brain-plasticity-class.ts` OR new `nexus-plasticity.ts` — `strengthenNexusCoAccess` function
- `/mnt/projects/cleocode/packages/core/src/memory/brain-lifecycle.ts` (wire Step 6b)
- `/mnt/projects/cleocode/packages/core/src/store/nexus-schema.ts` — extend `NEXUS_RELATION_TYPES` enum with `co_changed` and `co_cited_in_task`

### Approach
- Add Drizzle columns to `nexusRelations`: `weight: real('weight').default(0.0)`, `lastAccessedAt: text('last_accessed_at')`, `coAccessedCount: integer('co_accessed_count').default(0)`. Add index on `lastAccessedAt`.
- Write migration SQL: `ALTER TABLE nexus_relations ADD COLUMN weight REAL DEFAULT 0.0; ALTER TABLE nexus_relations ADD COLUMN last_accessed_at TEXT; ALTER TABLE nexus_relations ADD COLUMN co_accessed_count INTEGER DEFAULT 0; CREATE INDEX idx_nexus_relations_last_accessed ON nexus_relations(last_accessed_at);`
- `strengthenNexusCoAccess(projectRoot, pairs: Array<{sourceId: string, targetId: string}>)`: for each pair, `UPDATE nexus_relations SET weight = MIN(1.0, weight + 0.05), co_accessed_count = co_accessed_count + 1, last_accessed_at = datetime('now') WHERE source_id=? AND target_id=?`. Hebbian: fire together wire together.
- Wire as Step 6b in `runConsolidation` after Step 6 (edge strengthening). Source co-access pairs from `brain_retrieval_log` joined on session.
- Extend `NEXUS_RELATION_TYPES` with `'co_changed'` and `'co_cited_in_task'`.

### Tests
File: `/mnt/projects/cleocode/packages/core/src/memory/__tests__/nexus-plasticity.test.ts` (new)

1. Migration: `nexus_relations` has `weight`, `last_accessed_at`, `co_accessed_count` columns after migrate
2. `strengthenNexusCoAccess` increments `weight` and `co_accessed_count` for matching pairs
3. Weight caps at `1.0` (no runaway strengthening)
4. `last_accessed_at` updated on each strengthen call
5. Non-matching pairs not mutated
6. `runConsolidation` Step 6b calls `strengthenNexusCoAccess` (assert via mock)
7. `NEXUS_RELATION_TYPES` includes `co_changed` and `co_cited_in_task`

### Evidence atoms
```
commit:<sha>;files:packages/core/src/store/nexus-schema.ts,<migration-file>,<plasticity-file>,packages/core/src/memory/brain-lifecycle.ts;tool:pnpm-test;tool:biome;tool:tsc
```

---

## T999 — Markdown bridge kill — CLI directive replaces @-inject

**Wave 1 parallel** — no upstream dependency.

### Files to touch
- `/mnt/projects/cleocode/packages/core/src/injection.ts` (gate the `@.cleo/memory-bridge.md` and `@.cleo/nexus-bridge.md` lines behind config flag)
- `/mnt/projects/cleocode/packages/core/src/memory/memory-bridge.ts` (gate `writeFileSync` at lines 248 and 362)
- `/mnt/projects/cleocode/packages/contracts/src/` — add `brain.memoryBridge.mode: 'cli' | 'file'` to config contract (worker must check existing config contract file)

### Approach
- Add config key `brain.memoryBridge.mode` (default `'cli'`) to the contracts config type.
- In `injection.ts:171-179`: read the config value; when `mode='cli'`, replace the `@.cleo/memory-bridge.md` line with a plain-text CLI directive: `# Run: cleo memory digest --brief` (or equivalent). Similarly for nexus-bridge.
- In `memory-bridge.ts:248,362`: guard `writeFileSync` behind `if (mode === 'file')`. When `mode='cli'`, skip writing both `.md` files.
- Reversible: setting `mode='file'` restores the original behavior exactly.

### Tests
File: `/mnt/projects/cleocode/packages/core/src/memory/__tests__/memory-bridge.test.ts` (extend existing)

1. `mode='file'`: `.cleo/memory-bridge.md` is written after `runMemoryBridge` call
2. `mode='cli'`: `.cleo/memory-bridge.md` is NOT written
3. `mode='cli'`: AGENTS.md contains CLI directive instead of `@.cleo/memory-bridge.md`
4. `mode='file'`: AGENTS.md contains `@.cleo/memory-bridge.md` (original behavior)
5. `mode='cli'`: `.cleo/nexus-bridge.md` is NOT written
6. Config defaults to `'cli'` when not explicitly set
7. Integration: simulate session start with `mode='cli'`, verify no bridge files generated

### Evidence atoms
```
commit:<sha>;files:packages/core/src/injection.ts,packages/core/src/memory/memory-bridge.ts,<contracts-config-path>;tool:pnpm-test;tool:biome;tool:tsc
```

---

## Dependency Wire Summary

| Task | Depends on | Can start |
|------|-----------|-----------|
| T992 | none | immediately |
| T993 | none | immediately |
| T997 | none | immediately |
| T999 | none | immediately |
| T994 | T992 (clean write-path) | after T992 done |
| T995 | T992 (clean write-path) | after T992 done |
| T996 | T995 (prune signals) | after T995 done |
| T998 | none | immediately (independent) |

---

## ADR-051 Evidence Reminder

Every task MUST run:
```bash
cleo verify T99# --gate implemented --evidence "commit:<sha>;files:<list>"
cleo verify T99# --gate testsPassed --evidence "tool:pnpm-test"
cleo verify T99# --gate qaPassed    --evidence "tool:biome;tool:tsc"
cleo complete T99#
cleo memory observe "..." --title "..."
```

Workers MUST NOT `cleo complete` without all 3 gates verified. No `--force`. No `CLEO_OWNER_OVERRIDE` unless blocked by a hard infra issue.
