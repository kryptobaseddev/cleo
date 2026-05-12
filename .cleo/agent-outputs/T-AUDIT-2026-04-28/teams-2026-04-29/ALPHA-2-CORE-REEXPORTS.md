# ALPHA-2 — Core Re-Exports Audit (T1565)

**Agent:** Alpha-2 (Team Alpha · T-LAYERING-FIX prep)
**Date:** 2026-04-29
**Sole assignment:** ensure every contract type/value imported by `packages/cleo/src/` from `@cleocode/contracts` is re-exported by `@cleocode/core`.

---

## Headline numbers

| Metric | Value |
|--------|-------|
| Total `from '@cleocode/contracts'` import statements in `packages/cleo/src/` | **56** |
| Unique imported names (types + runtime values, deduped) | **29** |
| Already re-exported by `@cleocode/core` | **29** |
| Newly re-exported by this Alpha-2 work | **0** |
| Build clean (`pnpm run build`) | **yes** |
| `tsc --noEmit -p packages/core/tsconfig.json` clean | **yes** |
| Files modified | **0** |

---

## Why nothing was added

`packages/core/src/index.ts` line 27 already contains:

```ts
// Re-export ALL contracts types (consumers get types from @cleocode/core)
export * from '@cleocode/contracts';
```

`packages/contracts/src/index.ts` (the leaf package) already exports every name the cleo package currently imports. Because of the `export *` re-export in core, every contract symbol is transitively available via `@cleocode/core`.

The Alpha-3/4/5 import-rewrites can therefore proceed using the EXACT same names — no new exports, no sub-namespaces, and no source edits to core were required.

---

## The 29 unique names (all confirmed re-exported by `@cleocode/core`)

| # | Name | Kind | Origin file in contracts |
|---|------|------|--------------------------|
| 1 | `AgentWithProjectOverride` | type | `agent-registry.ts` |
| 2 | `CittyArgDef` | type | `operations/params.ts` |
| 3 | `CommitEntry` | type | `audit.ts` |
| 4 | `DataAccessor` | type | `data-accessor.ts` |
| 5 | `ExitCode` | runtime enum | `exit-codes.ts` |
| 6 | `GateResult` | type | `warp-chain.ts` |
| 7 | `GatewayMeta` | type | `lafs.ts` |
| 8 | `getErrorMessage` | runtime fn | `errors.ts` |
| 9 | `getExitCodeName` | runtime fn | `exit-codes.ts` |
| 10 | `isErrorCode` | runtime fn | `exit-codes.ts` |
| 11 | `isSuccessCode` | runtime fn | `exit-codes.ts` |
| 12 | `LafsEnvelope` | type | `lafs.ts` |
| 13 | `LafsError` | type | `lafs.ts` |
| 14 | `LafsSuccess` | type | `lafs.ts` |
| 15 | `MinimalTaskRecord` | type | `task-record.ts` |
| 16 | `NexusSigilListResult` | type | `operations/nexus.ts` |
| 17 | `ParamDef` | type | `operations/params.ts` |
| 18 | `PlaybookApproval` | type | `playbook.ts` |
| 19 | `PlaybookRun` | type | `playbook.ts` |
| 20 | `PlaybookRunStatus` | type | `playbook.ts` |
| 21 | `ProjectAgentRef` | type | `agent-registry.ts` |
| 22 | `Session` | type | `session.ts` |
| 23 | `SessionStartParams` | type | `operations/session.ts` (also referenced in a TSDoc-only comment) |
| 24 | `SessionStartResult` | type | `session.ts` |
| 25 | `Task` | type | `task.ts` |
| 26 | `TaskRecord` | type | `task-record.ts` |
| 27 | `TaskRecordRelation` | type | `task-record.ts` |
| 28 | `TaskWorkState` | type | `task.ts` |
| 29 | `WarpChain` | type | `warp-chain.ts` |

All names are surfaced via the single `export * from '@cleocode/contracts'` line in `packages/core/src/index.ts`.

---

## Verification methodology

1. Catalogued cleo→contracts imports (raw lines): `ALPHA-2-CONTRACTS-IMPORTS.txt` (45 unique import lines, 56 raw `from '@cleocode/contracts'` occurrences).
2. Extracted 29 unique names via shell parsing (handled `import type {…}`, `import {…}`, multi-name lists).
3. Verified each name is `export`ed from `packages/contracts/src/` source — all 29 hit.
4. Verified each name is publicly exposed via `packages/contracts/src/index.ts` — all 29 present.
5. Built a synthetic compilation unit at `/tmp/verify-core-reexports/verify.ts` that imports all 29 names from `@cleocode/core` (with TS-paths mapping), then ran `tsc --noEmit`. **Zero diagnostics.**
6. Ran `pnpm tsc --noEmit -p packages/core/tsconfig.json` → clean.
7. Ran `pnpm run build` → `Build complete.`

---

## File diff summary

```
(no files modified by Alpha-2)
```

The existing `export * from '@cleocode/contracts'` in `packages/core/src/index.ts` already satisfies the operator's layering rule for every name cleo currently imports from contracts. Alpha-3/4/5 can mechanically rewrite `from '@cleocode/contracts'` → `from '@cleocode/core'` for all 56 statements with zero "type not exported" errors.

---

## Recommendation for Alpha-3/4/5

Mechanical rewrite is safe. Suggested sed-style transform (per file):

```bash
# Inside each file under packages/cleo/src/ that matched the audit:
#   from '@cleocode/contracts'  →  from '@cleocode/core'
```

No name-level renaming, no structural changes, no sub-namespace hops required. The flat re-export surface of `@cleocode/core` covers every name in the audit.
