---
id: t9956-memory-wire-shapes
tasks: [T9956]
kind: refactor
prs: []
summary: "Promote 15 BRAIN memory wire-shapes from `@cleocode/core` to `@cleocode/contracts/memory` (Phase 0e of SG-ARCH-SOLID)."
---

Phase 0e of [Saga SG-ARCH-SOLID (T9831)](https://github.com/kryptobaseddev/cleo)
· Epic [E-CONTRACTS-FOUNDATION (T9832)](https://github.com/kryptobaseddev/cleo).
Promotes 15 public memory wire-shapes from
`packages/core/src/memory/brain-retrieval.ts` (lines 43-236, plus the
T549 Wave 3-A budgeted-retrieval region) to a new
`packages/contracts/src/memory/` subdirectory, grouped by retrieval layer:

- `memory/search.ts` — `BrainCompactHit`, `SearchBrainCompactParams`, `SearchBrainCompactResult`
- `memory/timeline.ts` — `BrainAnchor`, `TimelineBrainParams`, `TimelineNeighbor`, `TimelineBrainResult`
- `memory/fetch.ts` — `FetchBrainEntriesParams`, `FetchedBrainEntry`, `FetchBrainEntriesResult`
- `memory/observe.ts` — `BRAIN_OBSERVATION_SOURCE_TYPES` (const), `BrainObservationSourceType`, `ObserveBrainParams`, `ObserveBrainResult`
- `memory/budgeted.ts` — `BudgetedRetrievalOptions`, `BudgetedEntry`, `BudgetedResult`

`packages/core/src/memory/brain-retrieval.ts` retains a thin
`export type { … } from '@cleocode/contracts'` block so existing
`from './brain-retrieval.js'` imports keep working unchanged across the
~12 callers (engine-compat, session-memory, mental-model-queue,
dialectic-evaluator, observation-provenance, mental-model-wave-8,
hook-automation-e2e, etc.).

`packages/core/src/store/memory-schema.ts` now re-exports the
`BRAIN_OBSERVATION_SOURCE_TYPES` const from `@cleocode/contracts` so
Drizzle's `{ enum: ... }` column constraint and the derived
`BrainObservationSourceType` union share a single source of truth.

Unblocks [T9834 E-CORE-DECOMP](https://github.com/kryptobaseddev/cleo)
brain-retrieval split (the 2348-LOC god-module is now ready to be carved
into 8 cohesive files without dragging its public type surface along).

Zero behavior change. CLI `cleo memory find / timeline / fetch / observe`,
the dispatch validators, and the Studio memory routes all continue to
operate on byte-identical types — the move is pure import-path
re-plumbing plus a new pure-types compilation unit in contracts.
