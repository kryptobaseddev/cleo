# E-PRIME-T04 + E-PRIME-T05 — Mem0 Write-Time Extraction Gate & Bitemporal + Four-Network Epistemology

> **Status**: PLANNING — owner review pending. Do NOT run `cleo add` from this document; this is a decomposition spec, not a state mutation.
>
> **Source masterplan**: `/mnt/projects/cleocode/docs/plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md` — §5 Tier 4, §5 Tier 5, §16.D (Mem0 V3 envelope), §16.E (Hindsight 4-network), §16.F (Graphiti 4-timestamp). Wave plan §18 (W0=schema lock-in, W1=trust funnel).
>
> **CLEO task model**: ADR-066 (`--type`, `--kind`, `--severity`, `--size`, `--acceptance` pipe-separated). Evidence atoms per ADR-051.
>
> **Anti-overlap**: this spec covers Tier 4 + Tier 5 ONLY. Tiers 1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14 are out of scope. Peer schema (Tier 3) is cited as `depends-on: E-PRIME-T03` where `recipient_peer_id` / `peer_id` linkage applies.

---

## Conventions

| Field | Rule |
|---|---|
| Task IDs | `E-PRIME-T04` and `E-PRIME-T05` are the epics. Phase tasks `T04.P<n>` / `T05.P<n>`. Subtasks `T04.P<n>.S<m>` / `T05.P<n>.S<m>`. These are PLANNING handles — owner assigns real `T####` IDs at `cleo add` time. |
| `--acceptance` | pipe-separated multi-criterion (see Owner Feedback `feedback_pipe_separated_acceptance.md`). |
| Evidence atoms | per ADR-051: `commit:<sha>`, `files:<paths>`, `tool:test`, `tool:lint`, `tool:typecheck`, `test-run:<json>`, `decision:<id>`, `note:<text>`. |
| `depends-on` | edge type is `hard` unless noted `soft`. Cross-epic links use the epic handle. |
| Package boundaries | see `AGENTS.md` Package-Boundary Check. Migrations live in `packages/core/migrations/drizzle-brain/`; schema in `packages/core/src/store/memory-schema.ts`; memory runtime in `packages/core/src/memory/`; shared types in `packages/contracts/src/`. |
| Wave alignment | W0 = schema lock-in (migrations only — must land before any code path reads new columns). W1 = trust funnel (verifyAndStore single-funnel + reader updates). |

---

# Epic E-PRIME-T04 — Mem0 Write-Time Extraction Gate

## Epic Identity

- **id**: `E-PRIME-T04`
- **type**: `epic`
- **kind**: `work`
- **severity**: `P0` (chokepoint discipline; without this, every downstream tier corrupts trust)
- **size**: `large`
- **title**: Mem0 V3 write-time extraction gate — single `verifyAndStore` funnel for all BRAIN writes
- **parent**: `MASTER-cleo-prime-sentient` (owner-assigned at `cleo add` time)
- **depends-on**: none (foundation tier)
- **blocks**: `E-PRIME-T05` (bitemporal layer reads the verdict envelope; cannot ship without the funnel), every Tier ≥ 6 (they all write through the gate)

## Vision

Every BRAIN write — peer cards, memory-block edits, ToM inferences, skill-distill candidates, conduit-ingested messages, auto-extract output, learnings, decisions, patterns — passes through one `verifyAndStore` funnel at `packages/core/src/memory/extraction-gate.ts:606`. The verdict envelope matches Mem0 V3 (`event ∈ {ADD, UPDATE, NONE}`, `linkedMemoryIds`, NO DELETE — Mem0 publicly conceded DELETE causes regressions). Reconciliation is two-phase: pass 1 extracts atomic facts, pass 2 retrieves top-k similar via kNN and emits the verdict. CI fails any commit that inserts into a `brain_*` table outside the allowlisted writer set. Without this funnel, every other tier eventually corrupts trust.

## Epic Acceptance Criteria

- AC1: 100% of `INSERT INTO brain_*` statements originate from `verifyAndStore` (CI AST-grep gate enforces; `_skipGate` re-entry shortcut restricted to documented batch-internal recursion only).
- AC2: Verdict envelope schema is a Zod-validated contract in `packages/contracts/src/memory/verdict.ts` matching Mem0 V3: `event ∈ {ADD, UPDATE, NONE}`, `linkedMemoryIds`, `classification ∈ {world, bank, opinion, observation}`, `entities`, `contradicts`, `updateTargetId?`, `rejectReason?`. NO DELETE event.
- AC3: Two-phase extract→kNN→verdict reconciliation lands in `packages/core/src/memory/reconcile.ts` (new) and is the only path through `verifyAndStore`.
- AC4: `BRAIN_GATE_BUDGET_MS = 2000` per-candidate timeout falls back to `hashDedupCheck` only; `BRAIN_GATE_DISABLED=1` is a kill-switch (forensic recovery), NOT a feature flag — documented in `docs/runbooks/brain-gate-disabled.md` with non-flag rationale.
- AC5: Audit trail by default — every memory-block edit writes a `brain_observations` row with `type='memory-edit'`, `peer_id=<editor>`, `recipient_peer_id=<block-owner>` (`recipient_peer_id` column delivered in T04.P1).
- AC6: Inserting "We use React 18" then "We migrated to React 19" produces a verdict `{event: 'UPDATE', updateTargetId: <R18-row>, linkedMemoryIds: [<R18-row>]}`; the gate then dispatches the supersession write into the bitemporal columns landed by `E-PRIME-T05`. (This AC partially overlaps with `E-PRIME-T05` AC2; verification requires both epics.)
- AC7: Observations with `network='opinion'` route through `observer-reflector.ts` with disposition weighting visible in logs (`disposition: skeptical|literal|empathetic`).
- AC8: All gates pass — `pnpm biome check --write .`, `pnpm run build`, `pnpm run typecheck`, `pnpm run test` zero new failures.

## Milestone Gates (programmatic, baseline → target)

| Gate | Baseline (today) | Target |
|---|---|---|
| MG-T04-A: % of `brain_*` table writes originating from `verifyAndStore` | measure baseline in T04.P0.S1 (expected 60-80% based on existing `_skipGate` audit) | 100% (CI AST-grep gate green) |
| MG-T04-B: Count of memory-edit audit rows in `brain_observations` (`type='memory-edit'`) | 0 | ≥1 after first peer-card edit in test run |
| MG-T04-C: `BRAIN_GATE_DISABLED=1` smoke test — gate is skipped, hashDedup-only path writes through | N/A | pass |
| MG-T04-D: Two-phase ingest test — pass 1 extracts ≥1 fact, pass 2 returns kNN top-k, verdict emitted | N/A | pass |
| MG-T04-E: Backstop test — `BRAIN_GATE_BUDGET_MS=10` forces timeout, fallback to hashDedup, observation still stored with `gate_skipped=true` provenance label | N/A | pass |
| MG-T04-F: CI gate (`scripts/verify-writers.mjs`) fails a synthetic PR that adds `db.insert(brainLearnings).values(...)` outside the allowlist | N/A | red → fixed (test PR closes red) |

## Phase / Wave Plan

| Phase | Wave | Goal | Parallelism |
|---|---|---|---|
| T04.P0 | W0 | Baseline audit + spec writing (measure today's state, finalize Zod schema) | sequential |
| T04.P1 | W0 | Schema migration: `recipient_peer_id` on `brain_observations` (single migration; co-lands with T05.P1 migrations in the same W0 PR) | with T05.P1 |
| T04.P2 | W1 | Verdict envelope contract + reconciler module + extraction-gate refactor | sequential |
| T04.P3 | W1 | Migrate every direct writer to route through verifyAndStore | parallel-fan (5 files) |
| T04.P4 | W1 | Backstop + kill-switch implementation | with P3 |
| T04.P5 | W1 | Audit-trail-by-default wiring (`type='memory-edit'` rows) | after P3 |
| T04.P6 | W1 | CI AST-grep enforcement gate | after P3, P4, P5 |
| T04.P7 | W1 | Observer-reflector disposition weighting refactor | with P3 |

---

## Phase Tasks & Subtasks

### Phase T04.P0 — Baseline audit + envelope schema spec

**T04.P0** — task, work, P1, small. `--acceptance "Audit report enumerates every direct INSERT into brain_* tables and the % already routed through verifyAndStore | Zod schema for Mem0 V3 verdict envelope is reviewed in docs/architecture/mem0-v3-envelope.md"`

- **T04.P0.S1** — subtask, research, P1, small.
  - **title**: Audit direct `brain_*` writers across packages/core/src/memory
  - **files**: read-only inspection of `packages/core/src/memory/{auto-extract,llm-extraction,learnings,decisions,patterns,extraction-gate,observer-reflector,sleep-consolidation,dream-cycle,brain-reconciler,brain-consolidator,decision-cross-link,conduit-ingester}.ts` plus `packages/core/src/store/brain-accessor-impl.ts`
  - **acceptance**: `audit-report-mem0-funnel.md` lists every call site (file:line) that performs `db.insert(brain*)` or equivalent raw SQL | each site is labeled "via verifyAndStore" / "via _skipGate" / "direct" | baseline percentage published
  - **evidence**: `files:docs/architecture/audit-report-mem0-funnel.md;note:baseline measurement for MG-T04-A`
  - **depends-on**: —
  - **size**: small

- **T04.P0.S2** — subtask, work, P1, small.
  - **title**: Write Mem0 V3 envelope spec doc with worked examples
  - **files**: `docs/architecture/mem0-v3-envelope.md` (new)
  - **acceptance**: Document includes the Zod schema sketch | 5 worked examples (ADD-new-fact, UPDATE-superseded, NONE-duplicate, NONE-noise, NONE-pii) | explicit "DELETE intentionally removed — see masterplan §16.D" note
  - **evidence**: `files:docs/architecture/mem0-v3-envelope.md`
  - **depends-on**: T04.P0.S1

- **T04.P0.S3** — subtask, work, P1, small.
  - **title**: ADR — Mem0 V3 verdict envelope as the canonical funnel contract
  - **files**: `.cleo/adrs/ADR-XXX-mem0-v3-verdict-envelope.md` (number assigned at `cleo add` time)
  - **acceptance**: ADR captures: decision (adopt V3), context (V1 DELETE regressions), consequences (link-based soft-supersede only), supersedes (none) | status=proposed at write, accepted before T04.P2 starts
  - **evidence**: `decision:ADR-XXX;files:.cleo/adrs/ADR-XXX-mem0-v3-verdict-envelope.md`
  - **depends-on**: T04.P0.S2

---

### Phase T04.P1 — Schema: `recipient_peer_id` on `brain_observations`

**T04.P1** — task, work, P0, small. **WAVE W0** — schema must land before P2 reader/writer logic.

`--acceptance "Migration adds recipient_peer_id TEXT column to brain_observations (nullable, default NULL) | revert.sql drops the column | drizzle schema reflects the column | migration is idempotent (safe to re-run)"`

- **T04.P1.S1** — subtask, work, P0, small.
  - **title**: Drizzle migration — `brain_observations.recipient_peer_id`
  - **files**: `packages/core/migrations/drizzle-brain/<timestamp>_e-prime-t04-recipient-peer-id/migration.sql` (new), `revert.sql` (new)
  - **acceptance**: `ALTER TABLE brain_observations ADD COLUMN recipient_peer_id TEXT;` | index on `(recipient_peer_id)` for peer-to-peer queries | revert drops column + index | migration header comment cites E-PRIME-T04.P1.S1 + masterplan §4.3
  - **evidence**: `commit:<sha>;files:packages/core/migrations/drizzle-brain/<dir>/migration.sql,revert.sql`
  - **depends-on**: T04.P0.S3
  - **co-lands-with**: T05.P1.S1, T05.P1.S2, T05.P1.S3, T05.P1.S4 (single W0 PR; see §critical-dep note below)

- **T04.P1.S2** — subtask, work, P0, small.
  - **title**: Update `memory-schema.ts` — add `recipientPeerId` column to `brainObservations` table definition
  - **files**: `packages/core/src/store/memory-schema.ts` (edit; new column near line ~921)
  - **acceptance**: TS field `recipientPeerId: text('recipient_peer_id')` | TSDoc references masterplan §4.3 + Tier 3 peer-card schema link | type re-exported via `brain-row-types.ts` if affected
  - **evidence**: `commit:<sha>;files:packages/core/src/store/memory-schema.ts`
  - **depends-on**: T04.P1.S1

- **T04.P1.S3** — subtask, work, P1, small.
  - **title**: Migration smoke test — apply + revert + re-apply on fresh in-memory SQLite
  - **files**: `packages/core/src/store/__tests__/migration-e-prime-t04.test.ts` (new)
  - **acceptance**: Test asserts column exists after apply | revert removes it | re-apply succeeds (idempotency) | seeded observation row survives migration round-trip
  - **evidence**: `tool:test;files:packages/core/src/store/__tests__/migration-e-prime-t04.test.ts`
  - **depends-on**: T04.P1.S1, T04.P1.S2

---

### Phase T04.P2 — Verdict envelope + reconciler + extraction-gate refactor

**T04.P2** — task, work, P0, medium. **WAVE W1**.

`--acceptance "Zod schema in packages/contracts/src/memory/verdict.ts validates the Mem0 V3 envelope | reconcile.ts implements two-phase extract→kNN→verdict | verifyAndStore consumes the new verdict | all 485 existing LLM tests continue to pass | three new tests cover the ADD/UPDATE/NONE branches"`

- **T04.P2.S1** — subtask, work, P0, small.
  - **title**: Create `packages/contracts/src/memory/verdict.ts` with Zod schema
  - **files**: `packages/contracts/src/memory/verdict.ts` (new), `packages/contracts/src/index.ts` (edit — export)
  - **acceptance**: Zod schema matches masterplan §4.1 exactly (event enum, classification enum, entities array, contradicts array, linkedMemoryIds, updateTargetId, rejectReason) | NO DELETE event | TSDoc on every exported type | unit test in `packages/contracts/src/memory/__tests__/verdict.test.ts` covering parse-pass + parse-fail (DELETE rejected, wrong classification rejected)
  - **evidence**: `commit:<sha>;files:packages/contracts/src/memory/verdict.ts,packages/contracts/src/memory/__tests__/verdict.test.ts;tool:test`
  - **depends-on**: T04.P0.S3

- **T04.P2.S2** — subtask, work, P0, medium.
  - **title**: Create `packages/core/src/memory/reconcile.ts` — two-phase extract→kNN→verdict flow
  - **files**: `packages/core/src/memory/reconcile.ts` (new)
  - **acceptance**: Exports `runReconciliation(projectRoot, rawText, opts): Promise<Verdict>` | pass 1 calls `executeForRole('extraction')` to extract atomic facts | pass 2 calls `searchBrainCompact({mode:'hybrid', k:5})` for kNN | LLM emits verdict against retrieved neighbors (uses `structured-output.ts` for schema enforcement) | function is pure with side-effects pushed to caller | unit test seeds 2 existing observations + a contradicting new candidate, asserts UPDATE verdict with correct `updateTargetId`
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/reconcile.ts,packages/core/src/memory/__tests__/reconcile.test.ts;tool:test`
  - **depends-on**: T04.P2.S1

- **T04.P2.S3** — subtask, work, P0, medium.
  - **title**: Refactor `extraction-gate.ts:606` — `verifyAndStore` consumes the new verdict
  - **files**: `packages/core/src/memory/extraction-gate.ts` (edit)
  - **acceptance**: `verifyAndStore` calls `runReconciliation` first | routes by `verdict.event`: ADD → `storeVerifiedCandidate`, UPDATE → `storeWithSupersession` (helper that writes new row + sets `expired_at`/`superseded_by` on prior — requires T05.P1 columns; this is the documented cross-epic seam), NONE → no-op with metric log | preserves existing `hashDedup` early-out for performance | preserves `_skipGate` documented usage but adds runtime warning when called | all existing tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/extraction-gate.ts;tool:test;tool:typecheck`
  - **depends-on**: T04.P2.S2, T05.P1.S1 (the `expired_at` / `superseded_by` columns must exist before this lands — the migration in T05.P1 is the W0 prerequisite)

- **T04.P2.S4** — subtask, work, P0, small.
  - **title**: Implement `storeWithSupersession` helper in extraction-gate.ts
  - **files**: `packages/core/src/memory/extraction-gate.ts` (edit)
  - **acceptance**: Helper writes the new row in a transaction with the supersession update on the prior row (`expired_at=now`, `superseded_by=<new>`) | both rows share the same `transaction_id` for forensic audit | test asserts both rows persist on success and roll back together on failure
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/extraction-gate.ts,packages/core/src/memory/__tests__/extraction-gate-supersession.test.ts;tool:test`
  - **depends-on**: T04.P2.S3

- **T04.P2.S5** — subtask, work, P1, small.
  - **title**: Concurrent extract+invalidate — parallelize the two passes via `Promise.all`
  - **files**: `packages/core/src/memory/reconcile.ts` (edit)
  - **acceptance**: Pass 1 (extract) and pass 2 (kNN+invalidate of contradicted neighbors) run via `Promise.all` | regression test asserts ordering preservation: if the LLM emits `contradicts: [X]`, X is invalidated BEFORE the new row's `created_at` is committed (use a SQLite txn with a barrier) | benchmark in test asserts ≥1.5× speedup vs the serial baseline on a synthetic 10-fact episode
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/reconcile.ts,packages/core/src/memory/__tests__/reconcile-concurrent.test.ts;tool:test`
  - **depends-on**: T04.P2.S2, T05.P1.S1 (needs `invalid_at` writable on neighbors)

---

### Phase T04.P3 — Migrate every direct writer to route through verifyAndStore

**T04.P3** — task, work, P0, medium. **WAVE W1, parallel-fan (5 files).**

`--acceptance "Every direct INSERT into brain_observations / brain_learnings / brain_patterns / brain_decisions in the listed files is replaced with a verifyAndStore call OR documented in the _skipGate allowlist | each PR cites the audit-report row it closes | tests for each module continue to pass"`

- **T04.P3.S1** — subtask, work, P0, small.
  - **title**: Migrate `auto-extract.ts` direct writers → `verifyAndStore`
  - **files**: `packages/core/src/memory/auto-extract.ts` (edit)
  - **acceptance**: zero raw `db.insert(brain*)` calls remain | candidates built as `MemoryCandidate` and dispatched through `verifyAndStore` | existing tests in `auto-extract.test.ts` pass without modification (no expectation changes)
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/auto-extract.ts;tool:test`
  - **depends-on**: T04.P2.S3

- **T04.P3.S2** — subtask, work, P0, small.
  - **title**: Migrate `llm-extraction.ts` — confirm all five candidate types (pattern, learning, constraint, correction, decision) route through verifyAndStore
  - **files**: `packages/core/src/memory/llm-extraction.ts` (edit)
  - **acceptance**: Existing comment block (lines 169-188) is now ground truth — code matches the documented "all routed through verifyAndStore" claim | remove any residual `checkHashDedup`-only paths that bypass the verdict envelope | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/llm-extraction.ts;tool:test`
  - **depends-on**: T04.P2.S3

- **T04.P3.S3** — subtask, work, P0, small.
  - **title**: Migrate `learnings.ts` — remove `_skipGate` shortcut except for documented batch-internal recursion
  - **files**: `packages/core/src/memory/learnings.ts` (edit)
  - **acceptance**: `_skipGate=true` call sites enumerated in PR description with justification | external API (`storeLearning`) always routes through `verifyAndStore` | T992 batch-internal recursion path documented in `_skipGate` allowlist comment | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/learnings.ts;tool:test`
  - **depends-on**: T04.P2.S3

- **T04.P3.S4** — subtask, work, P0, small.
  - **title**: Migrate `decisions.ts` — same `_skipGate` removal
  - **files**: `packages/core/src/memory/decisions.ts` (edit)
  - **acceptance**: External API (`storeDecision`) always routes through `verifyAndStore` | `decisions` go to `brain_decisions` not `brain_observations` (preserve routing) | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/decisions.ts;tool:test`
  - **depends-on**: T04.P2.S3

- **T04.P3.S5** — subtask, work, P0, small.
  - **title**: Migrate `patterns.ts` — same `_skipGate` removal
  - **files**: `packages/core/src/memory/patterns.ts` (edit)
  - **acceptance**: External API (`storePattern`) always routes through `verifyAndStore` | procedural candidates route to `brain_patterns` | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/patterns.ts;tool:test`
  - **depends-on**: T04.P2.S3

- **T04.P3.S6** — subtask, work, P1, small.
  - **title**: Migrate `decision-cross-link.ts` writes
  - **files**: `packages/core/src/memory/decision-cross-link.ts` (edit)
  - **acceptance**: Any direct `brain_*` writes route through verifyAndStore | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/decision-cross-link.ts;tool:test`
  - **depends-on**: T04.P2.S3

- **T04.P3.S7** — subtask, work, P1, small.
  - **title**: Migrate `brain-consolidator.ts` consolidation writes
  - **files**: `packages/core/src/memory/brain-consolidator.ts` (edit)
  - **acceptance**: Consolidator routes its output through verifyAndStore | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/brain-consolidator.ts;tool:test`
  - **depends-on**: T04.P2.S3

- **T04.P3.S8** — subtask, work, P1, small.
  - **title**: Migrate `dream-cycle.ts` insight writes
  - **files**: `packages/core/src/memory/dream-cycle.ts` (edit)
  - **acceptance**: Dream insights route through verifyAndStore (so dreamed-up learnings are subject to the funnel) | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/dream-cycle.ts;tool:test`
  - **depends-on**: T04.P2.S3

---

### Phase T04.P4 — Backstop + kill-switch

**T04.P4** — task, work, P0, small. **WAVE W1**.

`--acceptance "BRAIN_GATE_BUDGET_MS env (default 2000) enforces a per-candidate timeout that falls back to hashDedupCheck | BRAIN_GATE_DISABLED=1 short-circuits to hashDedup-only and writes a forensic warning to the audit log | both behaviors documented in docs/runbooks/brain-gate-disabled.md as kill-switches NOT feature flags"`

- **T04.P4.S1** — subtask, work, P0, small.
  - **title**: Implement `BRAIN_GATE_BUDGET_MS` timeout in extraction-gate
  - **files**: `packages/core/src/memory/extraction-gate.ts` (edit)
  - **acceptance**: `runReconciliation` is wrapped in `Promise.race([reconcile, timeout])` with `BRAIN_GATE_BUDGET_MS` (default 2000) | on timeout, fall back to `hashDedupCheck` and store with `provenance.gate_skipped='timeout'` | test forces timeout via `BRAIN_GATE_BUDGET_MS=10` and asserts fallback path
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/extraction-gate.ts;tool:test`
  - **depends-on**: T04.P2.S3

- **T04.P4.S2** — subtask, work, P0, small.
  - **title**: Implement `BRAIN_GATE_DISABLED=1` kill-switch
  - **files**: `packages/core/src/memory/extraction-gate.ts` (edit)
  - **acceptance**: When env is `1`, `verifyAndStore` skips reconcile entirely and runs hashDedup-only | every skipped write emits a `console.warn` AND writes a `brain_audit_log` entry with `event='gate-disabled-write'` | smoke test asserts gate-disabled path stores the row
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/extraction-gate.ts;tool:test`
  - **depends-on**: T04.P4.S1

- **T04.P4.S3** — subtask, work, P1, small.
  - **title**: Document kill-switch — `docs/runbooks/brain-gate-disabled.md`
  - **files**: `docs/runbooks/brain-gate-disabled.md` (new)
  - **acceptance**: Runbook explains: when to use (forensic recovery only), why this is NOT a feature flag (no graceful long-term mode), how to re-enable, where to find the audit log of skipped writes | linked from `CLEO-PRIME-SENTIENT-MASTERPLAN.md` §4.2
  - **evidence**: `files:docs/runbooks/brain-gate-disabled.md`
  - **depends-on**: T04.P4.S2

---

### Phase T04.P5 — Audit-trail-by-default

**T04.P5** — task, work, P0, small. **WAVE W1**.

`--acceptance "Every memory-block edit emits a brain_observations row with type='memory-edit', peer_id=<editor>, recipient_peer_id=<block-owner> | row is durable across daemon restart | end-to-end test from cleo memory edit-block to query asserts row present"`

- **T04.P5.S1** — subtask, work, P0, small.
  - **title**: Emit `type='memory-edit'` audit row on memory-block edit
  - **files**: `packages/core/src/memory/memory-block-edit.ts` (edit or new), `packages/core/src/store/memory-schema.ts` (verify `type` column accepts `memory-edit`)
  - **acceptance**: On `memory.edit_block(blockId, content)`, the handler builds a `MemoryCandidate { type: 'memory-edit', peerId: editor, recipientPeerId: blockOwner, content: diffSummary }` and routes through `verifyAndStore` | row persists with both `peer_id` and `recipient_peer_id`
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/memory-block-edit.ts;tool:test`
  - **depends-on**: T04.P1.S2, T04.P3 (all S*)

- **T04.P5.S2** — subtask, work, P1, small.
  - **title**: End-to-end test — CLI edit-block → query returns audit row
  - **files**: `packages/cleo/src/__tests__/memory-edit-audit.e2e.test.ts` (new)
  - **acceptance**: Test invokes `cleo memory edit-block <id> "new content"` then `cleo memory find --type memory-edit --peer <owner>` and asserts the audit row appears with both peer columns populated
  - **evidence**: `tool:test;files:packages/cleo/src/__tests__/memory-edit-audit.e2e.test.ts`
  - **depends-on**: T04.P5.S1

---

### Phase T04.P6 — CI AST-grep enforcement gate

**T04.P6** — task, work, P0, medium. **WAVE W1, blocks epic completion.**

`--acceptance "scripts/verify-writers.mjs uses ast-grep to find every db.insert(brain*) call site | allowlist enumerates verifyAndStore + storeVerifiedCandidate + storeWithSupersession + documented _skipGate sites | CI job fails on any new violation | synthetic offending PR (test fixture) goes red"`

- **T04.P6.S1** — subtask, work, P0, medium.
  - **title**: Implement `packages/core/scripts/verify-writers.mjs` (AST-grep based)
  - **files**: `packages/core/scripts/verify-writers.mjs` (new), `packages/core/scripts/__fixtures__/offending-writer.ts` (new — test fixture)
  - **acceptance**: Script uses `@ast-grep/napi` (or shells out to `ast-grep`) to find `db.insert(brainObservations|brainLearnings|brainPatterns|brainDecisions)` call expressions | compares each match against an allowlist of file paths in `verify-writers.allowlist.json` | exit non-zero on any unallowlisted match | fixture file is excluded from the live source tree but used by a vitest test to assert the script catches violations
  - **evidence**: `commit:<sha>;files:packages/core/scripts/verify-writers.mjs,packages/core/scripts/verify-writers.allowlist.json,packages/core/scripts/__fixtures__/offending-writer.ts;tool:test`
  - **depends-on**: T04.P3 (all S*)

- **T04.P6.S2** — subtask, work, P0, small.
  - **title**: Wire `verify-writers.mjs` into CI workflow
  - **files**: `.github/workflows/ci.yml` (edit) — add a new step "Verify BRAIN writers funnel"
  - **acceptance**: New CI step runs `node packages/core/scripts/verify-writers.mjs` after install + build | step is required for the "CI" check; the branch protection contexts list (per AGENTS.md release section) is updated by owner during the next release
  - **evidence**: `commit:<sha>;files:.github/workflows/ci.yml`
  - **depends-on**: T04.P6.S1

- **T04.P6.S3** — subtask, work, P0, small.
  - **title**: Synthetic-PR test — assert CI gate goes red on an offending diff
  - **files**: `packages/core/scripts/__tests__/verify-writers.test.ts` (new)
  - **acceptance**: Vitest test loads the fixture offending-writer.ts and asserts `verify-writers.mjs` exits non-zero with a structured violation report | second test asserts a compliant file passes
  - **evidence**: `tool:test;files:packages/core/scripts/__tests__/verify-writers.test.ts`
  - **depends-on**: T04.P6.S1

---

### Phase T04.P7 — Observer-reflector disposition weighting (refactor existing module)

**T04.P7** — task, work, P1, medium. **WAVE W1.**

`--acceptance "observer-reflector.ts applies disposition trait (skeptical|literal|empathetic) to opinion-network observations | disposition is configurable per peer via BBTT briefing config | log lines include the disposition used | test seeds two opposing dispositions and asserts the reflector emits different downstream weights"`

> Note: `observer-reflector.ts` already exists in `packages/core/src/memory/`. This phase REFACTORS it; per AGENTS.md "NEVER remove code — ALWAYS improve existing code."

- **T04.P7.S1** — subtask, work, P1, small.
  - **title**: Add `disposition` field to BBTT briefing config types
  - **files**: `packages/contracts/src/briefing.ts` (edit OR new — locate existing briefing-config schema first), `packages/core/src/sessions/briefing.ts` (edit)
  - **acceptance**: Type `Disposition = 'skeptical' | 'literal' | 'empathetic'` exported from contracts | optional `disposition?: Disposition` on briefing-config | default `literal` if absent
  - **evidence**: `commit:<sha>;files:packages/contracts/src/briefing.ts,packages/core/src/sessions/briefing.ts;tool:typecheck`
  - **depends-on**: T04.P2.S1

- **T04.P7.S2** — subtask, work, P1, medium.
  - **title**: Refactor `observer-reflector.ts` to apply disposition weighting
  - **files**: `packages/core/src/memory/observer-reflector.ts` (edit)
  - **acceptance**: `reflectOnObservation(obs, disposition)` weights opinion-network rows: skeptical reduces confidence by 0.2 on contradicting evidence (vs default 0.1), literal accepts at face value, empathetic preserves narrative observations more aggressively | log line `[observer-reflector] disposition=<x> peer=<y> delta=<n>` emitted | two-disposition test confirms different deltas
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/observer-reflector.ts,packages/core/src/memory/__tests__/observer-reflector-disposition.test.ts;tool:test`
  - **depends-on**: T04.P7.S1, T05.P3.S1 (needs `confidence` column on opinion-network rows)

- **T04.P7.S3** — subtask, work, P1, small.
  - **title**: Wire disposition into spawn briefing rendering
  - **files**: `packages/core/src/sessions/briefing.ts` (edit)
  - **acceptance**: When a spawn briefing is composed, the resolved peer's `disposition` is included in the `## Who you are` block and passed into the agent's runtime config | end-to-end test asserts the field round-trips
  - **evidence**: `commit:<sha>;files:packages/core/src/sessions/briefing.ts;tool:test`
  - **depends-on**: T04.P7.S2

---

# Epic E-PRIME-T05 — Bitemporal + Four-Network Epistemology

## Epic Identity

- **id**: `E-PRIME-T05`
- **type**: `epic`
- **kind**: `work`
- **severity**: `P0`
- **size**: `large`
- **title**: Bitemporal validity (Graphiti 4-timestamp) + four-network epistemology (Hindsight World/Bank/Opinion/Observation) + LangMem typed routing + `cleo brain query --at` time-travel CLI
- **parent**: `MASTER-cleo-prime-sentient`
- **depends-on**: `E-PRIME-T03` (peer-card schema for `recipient_peer_id` & `peer_id` linkage in opinion-network rows), `E-PRIME-T04` (`verifyAndStore` funnel; verdict envelope's `event=UPDATE` flow IS the supersession write — see masterplan §5.1 invalidation-as-LLM-call note)
- **blocks**: Tier 6 (PSYCHE reconciler operates on bitemporal columns), Tier 7 (four-bus integration injects brain context filtered by `valid_at`/`invalid_at`), Tier 12 (Mastra 3-date model partially absorbed)

## Vision

BRAIN can answer "what did the system believe on date X?" with a four-timestamp clock model — `created_at` (system-time write), `expired_at` (system-time supersession), `valid_at` (world-time assertion start), `invalid_at` (world-time assertion end). Cognitive type taxonomy widens from 3-network (semantic/episodic/procedural — kept for back-compat) to 4-network (World/Bank/Opinion/Observation) via a parallel `network` column. Opinion-network rows carry `confidence: REAL` + `evidence_ids: TEXT` (JSON array of source observation IDs) that update on new evidence arrival — solves the D0xx-overload problem in MEMORY.md by separating evidence (World+Bank) from inference (Opinion). Peer-to-peer beliefs use `recipient_peer_id` (column landed by `E-PRIME-T04.P1`). Invalidation runs as an LLM call (Graphiti pattern) inside the `E-PRIME-T04` verdict pipeline. Time-travel queries via `cleo brain query --at <iso>`.

## Epic Acceptance Criteria

- AC1: All 4 typed tables (`brain_observations`, `brain_learnings`, `brain_patterns`, `brain_decisions`) carry the full 4-timestamp schema. `created_at` + `valid_at` (existing — verified at `memory-schema.ts:200,458,604,742`) are kept. `invalid_at` is kept (do NOT rename to `valid_to`). `expired_at` (system-time supersession) and `superseded_by` (FK) are added.
- AC2: Inserting "We use React 18" then "We migrated to React 19" sets `expired_at + superseded_by` on the first row; the second row has higher confidence (post-T05.P3) and the verdict envelope from `E-PRIME-T04` carries `event='UPDATE', updateTargetId=<R18-row>`.
- AC3: All 4 typed tables carry a `network` enum column with values `world|bank|opinion|observation` (parallel to existing `memory_type`, NOT a replacement — back-compat with 3-network code paths preserved).
- AC4: Opinion-network rows ONLY carry non-null `confidence` (REAL, 0..1) and `evidence_ids` (TEXT JSON array). CHECK constraint enforces non-null for opinion-network rows.
- AC5: When new evidence (World or Bank) contradicts an Opinion-network row's `evidence_ids` set, the opinion's `confidence` is reduced (NOT rewritten). At least one regression test demonstrates this. (Owner Note: this implements masterplan §16.E "load-bearing idea".)
- AC6: All BRAIN readers updated to query: `valid_at <= now AND (invalid_at IS NULL OR invalid_at > now) AND expired_at IS NULL`. CLI helper `applyTemporalFilter(query, asOf)` exists and is called from every read site.
- AC7: `cleo brain query --at 2026-04-01` returns a different row set than `--at now` on a database with at least one superseded row.
- AC8: `recipient_peer_id` (from `E-PRIME-T04.P1`) is populated on ToM-derived rows; `cleo memory find --recipient <peer>` filters correctly.
- AC9: LangMem typed routing enforced — every `memory_type` value routes to the documented table: `factual→brain_learnings`, `episodic→brain_observations`, `procedural→brain_patterns`, `decision→brain_decisions`. Routing test catches misrouting.
- AC10: All quality gates pass.

## Milestone Gates (programmatic, baseline → target)

| Gate | Baseline | Target |
|---|---|---|
| MG-T05-A: Count of rows with `expired_at` OR `invalid_at` populated | 0 (today: `invalid_at` exists but unused — verify with sqlite count in T05.P0.S1) | ≥1 after first supersession in test run |
| MG-T05-B: "We use React 18" + "We migrated to React 19" supersession test — first row has `expired_at != NULL` AND `superseded_by != NULL`, second row has higher `confidence` | N/A | pass |
| MG-T05-C: `cleo brain query --at <past-date>` returns a different row set than `--at now` | N/A | pass |
| MG-T05-D: Opinion-network confidence reduces when contradicting evidence arrives (numeric assertion: `confidence_after < confidence_before`) | 0 such observations exist | ≥1 |
| MG-T05-E: All 5 `memory_type` values (`semantic|episodic|procedural|factual|decision`) present in `brain_observations` after seeding test data | not all 5 present | all 5 present (masterplan §5 acceptance Tier 5 row 2) |
| MG-T05-F: Reader audit — count of read-call sites NOT filtered by `valid_at`/`invalid_at`/`expired_at` | measure baseline in T05.P0.S2 | 0 |
| MG-T05-G: `recipient_peer_id` populated on ToM-derived observations in test fixture | 0 | ≥1 |
| MG-T05-H: LangMem routing test — misrouting a `factual` candidate to `brain_observations` fails the routing assertion | N/A | pass |

## Phase / Wave Plan

| Phase | Wave | Goal | Parallelism |
|---|---|---|---|
| T05.P0 | W0 | Baseline reader audit + ADR ratification | sequential |
| T05.P1 | W0 | **Schema migrations** — 4 tables × (expired_at, valid_at-presence-check, superseded_by, network, opinion-only confidence + evidence_ids) | parallel-fan (4 tables) |
| T05.P2 | W1 | Reader updates — apply temporal filter everywhere | parallel-fan (read-call audit) |
| T05.P3 | W1 | Opinion-network confidence-update logic | sequential |
| T05.P4 | W1 | Invalidation-as-LLM-call wiring inside T04.P2.S2 reconcile pipeline | after T04.P2.S2 |
| T05.P5 | W1 | LangMem typed routing enforcement | with P2 |
| T05.P6 | W1 | `cleo brain query --at <iso>` CLI flag | after P2 |
| T05.P7 | W1 | Integration tests + masterplan acceptance fixtures | after all |

---

## Phase Tasks & Subtasks

### Phase T05.P0 — Reader audit + ADR ratification

**T05.P0** — task, research, P1, small. **WAVE W0.**

`--acceptance "Audit lists every read-call site that queries brain_observations / brain_learnings / brain_patterns / brain_decisions | each site labeled 'temporal-filtered' or 'naive' | ADR for the 4-timestamp scheme is accepted before T05.P1 starts"`

- **T05.P0.S1** — subtask, research, P1, small.
  - **title**: Audit reader call sites across packages/core/src/memory
  - **files**: read-only — `packages/core/src/memory/{brain-retrieval,brain-search,brain-similarity,brain-page-nodes,context-engines,graph-queries}.ts` plus accessors in `packages/core/src/store/brain-accessor-impl.ts`
  - **acceptance**: `audit-report-bitemporal-readers.md` enumerates every `db.select().from(brain*)` site | each labeled "temporal-filtered" (already uses `valid_at`/`invalid_at`) or "naive" | baseline count published as MG-T05-F starting value
  - **evidence**: `files:docs/architecture/audit-report-bitemporal-readers.md;note:baseline measurement for MG-T05-F`
  - **depends-on**: —

- **T05.P0.S2** — subtask, work, P1, small.
  - **title**: ADR — Graphiti 4-timestamp schema, keep `invalid_at` naming
  - **files**: `.cleo/adrs/ADR-XXX-graphiti-4-timestamp.md`
  - **acceptance**: ADR captures: decision (adopt 4-timestamp, keep `invalid_at` over `valid_to` per masterplan §16.F), context (existing `invalid_at` on 4 tables, Graphiti canonical naming), consequences (readers must combine system+world time), supersedes (any prior `valid_to`-rename plans) | status=proposed at write, accepted before T05.P1 lands
  - **evidence**: `decision:ADR-XXX;files:.cleo/adrs/ADR-XXX-graphiti-4-timestamp.md`
  - **depends-on**: T05.P0.S1

- **T05.P0.S3** — subtask, work, P1, small.
  - **title**: ADR — Hindsight 4-network parallel-column approach (not a replacement)
  - **files**: `.cleo/adrs/ADR-XXX-hindsight-4-network.md`
  - **acceptance**: ADR captures: decision (parallel `network` column, keep `memory_type`), context (Hindsight §16.E load-bearing separation of evidence/inference), consequences (Opinion rows carry `confidence` + `evidence_ids`), supersedes (none) | status=proposed at write, accepted before T05.P1 lands
  - **evidence**: `decision:ADR-XXX;files:.cleo/adrs/ADR-XXX-hindsight-4-network.md`
  - **depends-on**: T05.P0.S1

---

### Phase T05.P1 — Schema migrations (W0 — single PR with T04.P1)

**T05.P1** — task, work, P0, medium. **WAVE W0 — co-lands with T04.P1.S1 in a single migration PR per masterplan §18.**

> **Critical-dependency note** (per task prompt): "schema migrations land in wave W0; reader updates run parallel in W1 after columns exist." All T05.P1 subtasks ARE the W0 work; T05.P2/T05.P3 depend on them and run in W1.

`--acceptance "Migrations add expired_at, superseded_by, network, confidence, evidence_ids columns to the 4 typed tables | revert.sql drops them | drizzle schema reflects | migrations are idempotent | round-trip apply→revert→apply succeeds on fresh in-memory SQLite | indexes added for time-travel query performance"`

- **T05.P1.S1** — subtask, work, P0, small.
  - **title**: Drizzle migration — add `expired_at` + `superseded_by` to all 4 typed tables
  - **files**: `packages/core/migrations/drizzle-brain/<timestamp>_e-prime-t05-bitemporal-columns/migration.sql`, `revert.sql`
  - **acceptance**: ALTER TABLE adds `expired_at TEXT NULL`, `superseded_by TEXT NULL` to brain_observations, brain_learnings, brain_patterns, brain_decisions (4 tables) | `valid_at` is verified pre-existing (no-op for those columns) | `invalid_at` is verified pre-existing and NOT renamed | index `idx_<table>_expired_at` on `(expired_at)` for time-travel | revert drops the 8 new columns + 4 indexes idempotently | header comment cites E-PRIME-T05.P1.S1 + masterplan §5.1 + ADR-XXX
  - **evidence**: `commit:<sha>;files:packages/core/migrations/drizzle-brain/<dir>/migration.sql,revert.sql`
  - **depends-on**: T05.P0.S2

- **T05.P1.S2** — subtask, work, P0, small.
  - **title**: Drizzle migration — add `network` enum column to all 4 typed tables
  - **files**: `packages/core/migrations/drizzle-brain/<timestamp>_e-prime-t05-network-column/migration.sql`, `revert.sql`
  - **acceptance**: ALTER TABLE adds `network TEXT CHECK(network IN ('world','bank','opinion','observation'))` to all 4 tables with default by table per masterplan §5.2 mapping: brain_observations→`bank`/`observation` per row, brain_learnings→`world`, brain_patterns→`procedural` row remains in patterns but `network` left NULL (patterns are a separate axis per §5.2), brain_decisions→`opinion` default | revert drops column | header cites ADR-XXX-hindsight-4-network
  - **evidence**: `commit:<sha>;files:packages/core/migrations/drizzle-brain/<dir>/migration.sql,revert.sql`
  - **depends-on**: T05.P0.S3

- **T05.P1.S3** — subtask, work, P0, small.
  - **title**: Drizzle migration — add `confidence` REAL + `evidence_ids` TEXT (JSON) with opinion-network CHECK constraint
  - **files**: `packages/core/migrations/drizzle-brain/<timestamp>_e-prime-t05-opinion-confidence/migration.sql`, `revert.sql`
  - **acceptance**: ALTER TABLE adds `confidence REAL`, `evidence_ids TEXT` (JSON-encoded array) to all 4 tables | CHECK constraint: `(network != 'opinion') OR (confidence IS NOT NULL AND evidence_ids IS NOT NULL)` — i.e., opinion-network rows MUST have both populated | index `idx_<table>_evidence_ids` (cheap text index for substring lookups of source IDs) | revert drops | header cites masterplan §5.2
  - **evidence**: `commit:<sha>;files:packages/core/migrations/drizzle-brain/<dir>/migration.sql,revert.sql`
  - **depends-on**: T05.P1.S2

- **T05.P1.S4** — subtask, work, P0, small.
  - **title**: Update `memory-schema.ts` — add new columns to all 4 table definitions
  - **files**: `packages/core/src/store/memory-schema.ts` (edit — 4 table objects near lines 187, 445, 591, 729)
  - **acceptance**: TS fields `expiredAt`, `supersededBy` (with `references((): AnySQLiteColumn => <self-table>.id)`), `network` (enum-typed), `confidence`, `evidenceIds` added to all 4 tables | TSDoc on each | row types in `brain-row-types.ts` updated to surface new fields | type checks pass
  - **evidence**: `commit:<sha>;files:packages/core/src/store/memory-schema.ts,packages/core/src/memory/brain-row-types.ts;tool:typecheck`
  - **depends-on**: T05.P1.S1, T05.P1.S2, T05.P1.S3

- **T05.P1.S5** — subtask, work, P0, small.
  - **title**: Migration smoke tests — apply → revert → re-apply round-trip
  - **files**: `packages/core/src/store/__tests__/migration-e-prime-t05.test.ts` (new)
  - **acceptance**: Test asserts all 8 columns exist after apply | revert removes them | re-apply succeeds (idempotency) | CHECK constraint rejects an opinion-network row with NULL confidence | seeded rows survive round-trip
  - **evidence**: `tool:test;files:packages/core/src/store/__tests__/migration-e-prime-t05.test.ts`
  - **depends-on**: T05.P1.S4

- **T05.P1.S6** — subtask, work, P1, small.
  - **title**: Backfill plan doc — how operational installs get column defaults
  - **files**: `docs/migration/e-prime-t05-backfill.md`
  - **acceptance**: Doc covers: new installs auto-pick up via `cleo init`, existing installs auto-migrate on next `cleo` invocation, existing rows get `network=NULL` (opt-in, no forced reclassification), backfill script `cleo memory backfill-network` left for owner if they want to retroactively classify
  - **evidence**: `files:docs/migration/e-prime-t05-backfill.md`
  - **depends-on**: T05.P1.S5

---

### Phase T05.P2 — Reader updates (W1, parallel-fan)

**T05.P2** — task, work, P0, medium. **WAVE W1.**

`--acceptance "Every read site identified in T05.P0.S1 is updated to filter by valid_at <= now AND (invalid_at IS NULL OR invalid_at > now) AND expired_at IS NULL | applyTemporalFilter(query, asOf?) helper exported from packages/core/src/memory/temporal-supersession.ts | all existing tests pass | new test seeds a superseded row and asserts it is NOT in default reads"`

- **T05.P2.S1** — subtask, work, P0, small.
  - **title**: Create `applyTemporalFilter` helper in `temporal-supersession.ts`
  - **files**: `packages/core/src/memory/temporal-supersession.ts` (new OR edit if exists — masterplan §13 lists this as a target file)
  - **acceptance**: `applyTemporalFilter<T extends BrainTable>(query, asOf?: Date): typeof query` adds the three-clause WHERE filter | default `asOf = new Date()` | unit test covers `asOf=undefined` (uses now) and `asOf=<past>` (time-travel)
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/temporal-supersession.ts,packages/core/src/memory/__tests__/temporal-supersession.test.ts;tool:test`
  - **depends-on**: T05.P1.S4

- **T05.P2.S2** — subtask, work, P0, small.
  - **title**: Update `brain-retrieval.ts` readers
  - **files**: `packages/core/src/memory/brain-retrieval.ts` (edit)
  - **acceptance**: Every `db.select().from(brain*)` call wraps with `applyTemporalFilter` | `getBrainObservations`, `getBrainLearnings`, etc. take optional `asOf?: Date` and thread to helper | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/brain-retrieval.ts;tool:test`
  - **depends-on**: T05.P2.S1

- **T05.P2.S3** — subtask, work, P0, small.
  - **title**: Update `brain-search.ts` readers
  - **files**: `packages/core/src/memory/brain-search.ts` (edit)
  - **acceptance**: All search paths apply temporal filter | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/brain-search.ts;tool:test`
  - **depends-on**: T05.P2.S1

- **T05.P2.S4** — subtask, work, P0, small.
  - **title**: Update `brain-similarity.ts` and `brain-page-nodes.ts` readers
  - **files**: `packages/core/src/memory/brain-similarity.ts`, `packages/core/src/memory/brain-page-nodes.ts` (edit)
  - **acceptance**: Temporal filter applied | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/brain-similarity.ts,packages/core/src/memory/brain-page-nodes.ts;tool:test`
  - **depends-on**: T05.P2.S1

- **T05.P2.S5** — subtask, work, P0, small.
  - **title**: Update `context-engines/*` readers
  - **files**: `packages/core/src/memory/context-engines/*.ts` (edit each)
  - **acceptance**: Every context engine that reads BRAIN applies temporal filter | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/context-engines/<files>;tool:test`
  - **depends-on**: T05.P2.S1

- **T05.P2.S6** — subtask, work, P0, small.
  - **title**: Update `graph-queries.ts` and `graph-memory-bridge.ts` readers
  - **files**: `packages/core/src/memory/graph-queries.ts`, `packages/core/src/memory/graph-memory-bridge.ts` (edit)
  - **acceptance**: Graph traversals exclude superseded/expired/invalid nodes | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/graph-queries.ts,packages/core/src/memory/graph-memory-bridge.ts;tool:test`
  - **depends-on**: T05.P2.S1

- **T05.P2.S7** — subtask, work, P0, small.
  - **title**: Update `brain-accessor-impl.ts` storage-layer reads
  - **files**: `packages/core/src/store/brain-accessor-impl.ts` (edit)
  - **acceptance**: Storage-layer accessors take `asOf?: Date` and apply filter at the data-access boundary | tests pass
  - **evidence**: `commit:<sha>;files:packages/core/src/store/brain-accessor-impl.ts;tool:test`
  - **depends-on**: T05.P2.S1

- **T05.P2.S8** — subtask, work, P0, small.
  - **title**: Regression test — supersession hides the prior row from default reads
  - **files**: `packages/core/src/memory/__tests__/bitemporal-supersession.test.ts` (new)
  - **acceptance**: Test seeds row A (`valid_at=t0`), supersedes with row B at `t1` (sets `expired_at=t1` on A), asserts `getBrainObservations()` returns only B | asserts `getBrainObservations(t0)` returns A | asserts row A is still in the table (no DELETE)
  - **evidence**: `tool:test;files:packages/core/src/memory/__tests__/bitemporal-supersession.test.ts`
  - **depends-on**: T05.P2.S2

---

### Phase T05.P3 — Opinion-network confidence update logic

**T05.P3** — task, work, P0, medium. **WAVE W1.**

`--acceptance "New World/Bank evidence that contradicts an Opinion-network row's evidence_ids set reduces that opinion's confidence | reduction is non-rewriting (the opinion's text stays, only confidence changes) | confidence floor at 0 and ceiling at 1 | regression test demonstrates the reduction"`

- **T05.P3.S1** — subtask, work, P0, small.
  - **title**: Implement `reduceOpinionConfidence(opinionId, contradictingEvidenceId, delta)` in `temporal-supersession.ts`
  - **files**: `packages/core/src/memory/temporal-supersession.ts` (edit)
  - **acceptance**: Function: 1) loads opinion row, 2) appends `contradictingEvidenceId` to its `evidence_ids` JSON with kind=`contradicting`, 3) writes `confidence = max(0, confidence - delta)`, 4) does NOT modify the opinion's text | unit test asserts numeric decrement
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/temporal-supersession.ts;tool:test`
  - **depends-on**: T05.P1.S4

- **T05.P3.S2** — subtask, work, P0, small.
  - **title**: Wire opinion-update into verdict-processing
  - **files**: `packages/core/src/memory/extraction-gate.ts` (edit), `packages/core/src/memory/reconcile.ts` (edit)
  - **acceptance**: When the verdict envelope contains `contradicts: [{id, severity}]` AND the contradicted row's `network = 'opinion'`, dispatch to `reduceOpinionConfidence` instead of supersession (supersession is for fact-class rows: world/bank) | severity-to-delta mapping: minor=0.1, major=0.3 | regression test seeds an opinion with `confidence=0.8`, adds contradicting world-fact, asserts `confidence` drops to 0.7 (minor) or 0.5 (major)
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/extraction-gate.ts,packages/core/src/memory/reconcile.ts,packages/core/src/memory/__tests__/opinion-confidence.test.ts;tool:test`
  - **depends-on**: T05.P3.S1, T04.P2.S3

- **T05.P3.S3** — subtask, work, P1, small.
  - **title**: Index `evidence_ids` for substring lookup
  - **files**: covered in T05.P1.S3 migration; verify index is used by `EXPLAIN QUERY PLAN`
  - **acceptance**: Test asserts the lookup query for "opinions linked to this evidence id" uses the index (EXPLAIN inspection) | if not, add a virtual column or FTS5 index in a follow-up migration
  - **evidence**: `tool:test;files:packages/core/src/memory/__tests__/evidence-id-index.test.ts`
  - **depends-on**: T05.P1.S3

---

### Phase T05.P4 — Invalidation-as-LLM-call inside reconcile pipeline

**T05.P4** — task, work, P0, medium. **WAVE W1.**

`--acceptance "On each new BRAIN write, kNN-retrieve semantically-adjacent rows | LLM emits contradicts: [{id, reason}] | contradicted edge gets invalid_at = newRow.valid_at | concurrent extract+invalidate via Promise.all (covered by T04.P2.S5; THIS phase wires the invalidate side) | audit trail preserved (no DELETE)"`

- **T05.P4.S1** — subtask, work, P0, small.
  - **title**: Implement `invalidateContradictedNeighbors(verdict, newRow)` in reconcile.ts
  - **files**: `packages/core/src/memory/reconcile.ts` (edit)
  - **acceptance**: For each `contradicts[i].id` in the verdict, set `invalid_at = newRow.valid_at` and append to `superseded_by` chain | if neighbor is opinion-network, route through `reduceOpinionConfidence` instead (per T05.P3) | function is idempotent (re-running for same verdict is a no-op)
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/reconcile.ts;tool:test`
  - **depends-on**: T04.P2.S2, T05.P3.S2

- **T05.P4.S2** — subtask, work, P0, small.
  - **title**: Concurrent extract+invalidate — verify Promise.all ordering preservation
  - **files**: `packages/core/src/memory/__tests__/reconcile-concurrent-ordering.test.ts` (new)
  - **acceptance**: This test extends T04.P2.S5's ordering test with bitemporal assertions: after concurrent extract+invalidate, the contradicted neighbor's `invalid_at` equals the new row's `valid_at` to the millisecond | both writes commit in the same SQLite txn
  - **evidence**: `tool:test;files:packages/core/src/memory/__tests__/reconcile-concurrent-ordering.test.ts`
  - **depends-on**: T05.P4.S1, T04.P2.S5

---

### Phase T05.P5 — LangMem typed routing enforcement

**T05.P5** — task, work, P0, small. **WAVE W1.**

`--acceptance "memory_type='factual' routes to brain_learnings | 'episodic' to brain_observations | 'procedural' to brain_patterns | 'decision' to brain_decisions | routing enforced inside verifyAndStore (rejects mismatched table targets) | misrouting test fails with E_ROUTING_VIOLATION"`

- **T05.P5.S1** — subtask, work, P0, small.
  - **title**: Implement `routeByMemoryType(candidate): TableTarget` in extraction-gate
  - **files**: `packages/core/src/memory/extraction-gate.ts` (edit), `packages/contracts/src/memory/verdict.ts` (edit — add `TableTarget` type)
  - **acceptance**: Pure function maps memory_type → target table | called inside `verifyAndStore` before write | if caller passed an explicit table that differs, throw `E_ROUTING_VIOLATION` with structured error
  - **evidence**: `commit:<sha>;files:packages/core/src/memory/extraction-gate.ts,packages/contracts/src/memory/verdict.ts;tool:test`
  - **depends-on**: T04.P2.S3

- **T05.P5.S2** — subtask, work, P0, small.
  - **title**: Routing test — misrouting fails loudly
  - **files**: `packages/core/src/memory/__tests__/typed-routing.test.ts` (new)
  - **acceptance**: Test seeds 4 candidates with the 4 memory_type values, asserts each lands in the documented table | second test attempts to write a `factual` candidate to `brain_observations` and asserts `E_ROUTING_VIOLATION` is thrown
  - **evidence**: `tool:test;files:packages/core/src/memory/__tests__/typed-routing.test.ts`
  - **depends-on**: T05.P5.S1

---

### Phase T05.P6 — `cleo brain query --at <iso>` CLI flag

**T05.P6** — task, work, P0, small. **WAVE W1.**

`--acceptance "cleo brain query --at <iso> accepts ISO-8601 datetime | applyTemporalFilter is called with parsed Date | output renders rows the system believed at that moment | help text documents the flag | invalid date returns E_VALIDATION"`

- **T05.P6.S1** — subtask, work, P0, small.
  - **title**: Add `--at <iso>` flag to `cleo brain query` command
  - **files**: `packages/cleo/src/commands/brain/query.ts` (edit — locate via grep)
  - **acceptance**: Citty arg `at` (string, optional) | parsed via `new Date(value)` with NaN check → throws `E_VALIDATION` | passed through to retrieval helper | help text: "Time-travel query: return rows the system believed at this ISO-8601 timestamp"
  - **evidence**: `commit:<sha>;files:packages/cleo/src/commands/brain/query.ts;tool:test`
  - **depends-on**: T05.P2.S1

- **T05.P6.S2** — subtask, work, P0, small.
  - **title**: CLI integration test — `--at` returns different rows
  - **files**: `packages/cleo/src/__tests__/brain-query-at.e2e.test.ts` (new)
  - **acceptance**: Test seeds row A (`valid_at=2026-04-01`), supersedes with B (`valid_at=2026-05-01`), runs `cleo brain query --at 2026-04-15` and asserts A only | runs `--at 2026-05-15` and asserts B only | runs no flag and asserts B only (default=now)
  - **evidence**: `tool:test;files:packages/cleo/src/__tests__/brain-query-at.e2e.test.ts`
  - **depends-on**: T05.P6.S1

- **T05.P6.S3** — subtask, work, P1, small.
  - **title**: Document the flag in CLEO-INJECTION.md memory section
  - **files**: `packages/cleo/templates/CLEO-INJECTION.md` (edit OR centralized injection source) — verify the path during execution
  - **acceptance**: A `## Time-travel query` line is added to the memory section with one example | `cleo briefing` reflects the new line after the next build
  - **evidence**: `commit:<sha>;files:<injection-file>`
  - **depends-on**: T05.P6.S1

---

### Phase T05.P7 — Integration tests + masterplan acceptance fixtures

**T05.P7** — task, work, P0, medium. **WAVE W1, blocks epic completion.**

`--acceptance "End-to-end fixtures cover all milestone gates MG-T05-A through MG-T05-H | the React 18→19 supersession fixture is checked in | the opinion-confidence-reduction fixture is checked in | acceptance test for masterplan §5 Tier 5 acceptance rows passes"`

- **T05.P7.S1** — subtask, work, P0, small.
  - **title**: Acceptance fixture — React 18 → React 19 supersession
  - **files**: `packages/core/src/memory/__tests__/fixtures/react-18-to-19.test.ts` (new)
  - **acceptance**: Test ingests "We use React 18" (world-fact) at `t0`, ingests "We migrated to React 19" at `t1` | asserts row A has `expired_at != NULL` AND `superseded_by = <B.id>` | asserts row B's `confidence > row A.confidence` post-supersession | satisfies MG-T04-{A,B} cross-epic + MG-T05-{A,B}
  - **evidence**: `tool:test;files:packages/core/src/memory/__tests__/fixtures/react-18-to-19.test.ts`
  - **depends-on**: T05.P2.S8, T05.P4.S1

- **T05.P7.S2** — subtask, work, P0, small.
  - **title**: Acceptance fixture — Opinion confidence reduces on contradicting evidence
  - **files**: `packages/core/src/memory/__tests__/fixtures/opinion-confidence-reduction.test.ts` (new)
  - **acceptance**: Seeds opinion ("Redis is the right cache for X") with `confidence=0.8, network='opinion', evidence_ids=[E1,E2]` | ingests contradicting world-fact "Redis was removed from X in v2" | asserts opinion's `confidence` reduced (satisfies MG-T05-D) | asserts opinion text unchanged
  - **evidence**: `tool:test;files:packages/core/src/memory/__tests__/fixtures/opinion-confidence-reduction.test.ts`
  - **depends-on**: T05.P3.S2

- **T05.P7.S3** — subtask, work, P0, small.
  - **title**: Acceptance fixture — all 5 memory_type values present after seeding
  - **files**: `packages/core/src/memory/__tests__/fixtures/all-memory-types.test.ts` (new)
  - **acceptance**: Test seeds one row of each type (`semantic|episodic|procedural|factual|decision`), runs the masterplan §5 SQL `SELECT memory_type, COUNT(*) FROM brain_observations GROUP BY memory_type` and asserts all 5 present (satisfies MG-T05-E)
  - **evidence**: `tool:test;files:packages/core/src/memory/__tests__/fixtures/all-memory-types.test.ts`
  - **depends-on**: T05.P5.S2

- **T05.P7.S4** — subtask, work, P0, small.
  - **title**: Acceptance fixture — `recipient_peer_id` populated on ToM-derived rows
  - **files**: `packages/core/src/memory/__tests__/fixtures/recipient-peer-id.test.ts` (new)
  - **acceptance**: Test seeds an inferred ToM observation ("cleo-prime believes operator prefers X") via `verifyAndStore({recipientPeerId: 'operator'})` | asserts row has `recipient_peer_id='operator'` (satisfies MG-T05-G)
  - **evidence**: `tool:test;files:packages/core/src/memory/__tests__/fixtures/recipient-peer-id.test.ts`
  - **depends-on**: T04.P5.S1

- **T05.P7.S5** — subtask, work, P0, small.
  - **title**: Aggregate quality-gate run + evidence bundle for epic complete
  - **files**: N/A — runtime verification
  - **acceptance**: `pnpm biome check --write .` clean | `pnpm run build` zero errors | `pnpm run typecheck` zero errors | `pnpm run test` zero new failures | `node packages/core/scripts/verify-writers.mjs` exits 0 | all 8 MG-T05 gates green
  - **evidence**: `tool:lint;tool:typecheck;tool:test;tool:build;note:all milestone gates green`
  - **depends-on**: T05.P7.S1, T05.P7.S2, T05.P7.S3, T05.P7.S4, T04.P6.S2

---

## Cross-epic dependency map (W0 → W1 critical path)

```
W0 (single PR — schema lock-in):
   T04.P0.S1 → T04.P0.S2 → T04.P0.S3 ─┐
   T05.P0.S1 → T05.P0.S2, T05.P0.S3 ──┤
                                       ├─► T04.P1.S{1,2,3} (recipient_peer_id)
                                       └─► T05.P1.S{1,2,3,4,5,6} (bitemporal + network + opinion-confidence)

W1 (parallel-fan after W0 lands):
   T04.P2 (verdict envelope + reconcile + extraction-gate refactor) ──┐
                                                                       ├─► T04.P3.S{1..8} (writer migration)
                                                                       ├─► T04.P4 (backstop + kill-switch)
                                                                       ├─► T04.P5 (audit trail)
                                                                       ├─► T04.P7 (observer-reflector disposition)
                                                                       │
   T05.P2.S1 (applyTemporalFilter) ─────────────────────────────────────┼─► T05.P2.S{2..8} (reader updates)
                                                                       ├─► T05.P3 (opinion confidence)
                                                                       ├─► T05.P4 (invalidation-as-LLM-call)
                                                                       ├─► T05.P5 (typed routing)
                                                                       └─► T05.P6 (time-travel CLI)

   ──► T04.P6 (CI AST-grep gate) ── blocks E-PRIME-T04 complete
   ──► T05.P7 (integration fixtures) ── blocks E-PRIME-T05 complete
```

---

## Risk register

| Risk | Mitigation |
|---|---|
| Migration order — T04.P1 and T05.P1 must land in a single PR or readers will go red | Bundle into one W0 PR; T04.P1 + T05.P1 share a `branch: feat/E-PRIME-T04-T05-schema` per AGENTS.md `feat/T####` convention |
| `_skipGate` removal breaks legacy batch paths | T04.P3.S3/S4/S5 explicitly preserve the documented batch-internal recursion path, just narrowing it; PR description enumerates every removed call site |
| AST-grep CI gate produces noise on legitimate accessor code in `brain-accessor-impl.ts` | Allowlist file (`verify-writers.allowlist.json`) explicitly lists accessor file as the SINGLE storage-layer write site; verifyAndStore is the SOLE caller of the accessor |
| Existing `invalid_at` column is unused — renaming was tempting but masterplan §16.F reverses that decision | ADR T05.P0.S2 explicitly captures the reversal; reader audit T05.P0.S1 confirms current usage |
| Concurrent extract+invalidate races on the same neighbor | SQLite txn barrier inside `runReconciliation` ensures ordering; regression test T04.P2.S5 + T05.P4.S2 cover |
| Opinion-network CHECK constraint rejects pre-existing rows during migration | T05.P1.S3 migration sets `network=NULL` for existing rows (CHECK passes when `network != 'opinion'`); backfill is opt-in per T05.P1.S6 |
| Citty CLI arg parsing for `--at <iso>` may not validate ISO strings natively | T05.P6.S1 explicitly adds `new Date(value)` + NaN guard returning `E_VALIDATION` |
| Cross-epic AC6 (T04) requires T05 columns — could deadlock complete order | Documented as cross-epic seam in T04.P2.S3; T04 completes structurally with verdict pipeline, T05 completes when bitemporal writes succeed end-to-end |

---

## Deferred follow-ups (NOT in scope for these epics)

- Tier 3 peer schema work (`E-PRIME-T03`) — `recipient_peer_id` consumption fully wired by `E-PRIME-T03`; we land the column + audit-row writer here but Tier 3 owns peer-card retrieval that surfaces these rows.
- Tier 6 PSYCHE reconciler integration — once bitemporal lands, the reconciler's `syncVectorIndex` purge-superseded logic becomes correct; that wiring is Tier 6 work.
- Tier 7 four-bus integration — spawn-context-builder filters by `valid_at`/`expired_at`; landed there.
- Tier 12 Mastra 3-date model (observation_date / referenced_date / relative_date) — masterplan §16.H absorbed by Tier 5.1 but extra date fields beyond `valid_at` are deferred.
- A-Mem LLM-edge generation (`linkedNodes: {id, kind, reason}[]`) — Tier 13.
- LangMem Episodes type — Tier 13.
- MemGPT heartbeat — Tier 13.
- Hindsight Tempr+Cara subsystem-level extraction — only the disposition + 4-network + confidence-on-evidence-change parts land here; full Tempr/Cara mapping is deferred.
- Backfill script `cleo memory backfill-network` (referenced in T05.P1.S6) — owner-discretion follow-up.
- BRAIN MCP server question (Tier 14) — explicitly deferred per masterplan §17.

---

## Counts

- **Epics**: 2 (`E-PRIME-T04`, `E-PRIME-T05`)
- **Phase tasks**: 16 (8 in T04: P0–P7; 8 in T05: P0–P7)
- **Atomic subtasks**: 56 total
  - T04: 3 + 3 + 5 + 8 + 3 + 2 + 3 + 3 = 30
  - T05: 3 + 6 + 8 + 3 + 2 + 2 + 3 + 5 = 32 (recount: 3+6+8+3+2+2+3+5 = 32; reconciled below)

> **Subtask reconciliation**:
> T04: P0=3, P1=3, P2=5, P3=8, P4=3, P5=2, P6=3, P7=3 → **30**
> T05: P0=3, P1=6, P2=8, P3=3, P4=2, P5=2, P6=3, P7=5 → **32**
> **Grand total: 62 atomic subtasks** across 16 phase tasks and 2 epics.

---

## Ready-for-`cleo add` checklist (owner action)

When this spec is approved, owner runs (real IDs assigned by `cleo`):

1. `cleo add --type epic --kind work --severity P0 --size large --title "Mem0 V3 write-time extraction gate" --acceptance "<AC1>|<AC2>|...|<AC8>" --parent <MASTER-id>` → captures `E-PRIME-T04`
2. `cleo add --type epic --kind work --severity P0 --size large --title "Bitemporal + 4-network epistemology" --acceptance "<AC1>|...|<AC10>" --parent <MASTER-id>` → captures `E-PRIME-T05`
3. For each phase task: `cleo add --type task --parent <epic-id> ...`
4. For each subtask: `cleo add --type subtask --parent <phase-task-id> ...`
5. `cleo orchestrate start <epic-id>` after both epics are decomposed (auto-inits LOOM)
6. Run `cleo orchestrate ready --epic <id>` to discover W0 parallel-safe wave (T04.P1 + T05.P1 schema migrations co-land)

**This spec contains zero state mutations.** It is a planning artefact for owner review only.
