---
"@cleocode/cleo": patch
"@cleocode/core": minor
---

refactor(T10131): decompose system.ts (1302 LOC) into packages/core/src/render/{session,orchestration,brain}/ (B6)

Migrates all 22 renderers from `packages/cleo/src/cli/renderers/system.ts` into
`packages/core/src/render/` organized by family:
- `session/` (11) — briefing, blockers, next, current, doctor, session, version,
  start, stop, schema, generic
- `orchestration/` (4 + 1 helper) — tree, waves, plan, audit-reconstruct, stats
  (+ `renderCompletionBar`)
- `brain/` (6) — maintenance, backfill, purge, plasticity-stats, quality, export

Each renderer also self-registers into the B5 renderer registry (under
`kind: 'generic'`) via a `wrapLegacyRenderer` adapter so future
envelope-aware callers can resolve them through `renderEnvelopeForHuman`.
The cleo dispatcher in `packages/cleo/src/cli/renderers/index.ts` updates
its imports to pull these names from `@cleocode/core` instead of the
deleted `./system.js`. Zero behavior change — snapshot tests pass unchanged.

Resolves AGENTS.md Package-Boundary Check violation (rendering logic belongs
in core).

Subtasks: T10147 (session), T10148 (orchestration), T10149 (brain).
