# Pipeline Manifest — T1467 Thin Dispatch Wave

## T948-A — harden @cleocode/core publish surface (files allowlist)

**Status**: complete
**Commit**: `6dd468c65c47d3710f57c28326e0d5e3035281e8`
**Date**: 2026-04-27

### Changes

| File | Change |
|------|--------|
| `packages/core/package.json` | Removed `src` from `files` array; added `README.md` and `STABILITY.md` |

### Verification

| Check | Result |
|-------|--------|
| `files` array previously included `src` | CONFIRMED — 13 MB of TypeScript source was being shipped |
| `src` removed from `files` | DONE |
| `migrations`, `schemas`, `templates` retained | DONE — all three are loaded at runtime via `getPackageRoot()` |
| `README.md`, `STABILITY.md` added | DONE |
| `no "private": true` | CONFIRMED — package is public |
| `main` and `types` point to `dist/` | CONFIRMED — `./dist/index.js` and `./dist/index.d.ts` |
| `exports` block covers needed paths | CONFIRMED — 30+ subpath exports, all pointing to `dist/` |
| `pnpm pack --dry-run` — zero `src/` files | CONFIRMED |
| `tsc` build | PASS |
| `biome ci` | PASS (1 pre-existing broken-symlink warning) |
| `testsPassed` | BLOCKED — 11 pre-existing failures in `brain-stdp-functional.test.ts`, `pipeline.integration.test.ts`, `t311-integration.test.ts`; none related to files allowlist change |

### Notes

- `dist/internal.d.ts` confirmed as intentional private sub-path — documented as `@internal` in the file header
- `migrations/drizzle-{brain,conduit,nexus,signaldock,tasks}` are used at runtime by `backup-unpack.ts`
- `schemas/` is used at runtime by `schema-management.ts` (bundled fallback via `getPackageRoot()`)
- `templates/` is used at runtime by `scaffold.ts`, `injection.ts`, `init.ts`, `hooks.ts`
- Pre-existing test failures are in unrelated STDP/plasticity and pipeline integration subsystems

### Gates

| Gate | Status | Evidence |
|------|--------|---------|
| implemented | PASS | commit:6dd468c65 + files:packages/core/package.json |
| qaPassed | PASS | biome ci (0 errors) + tsc (exit 0) |
| testsPassed | BLOCKED | 11 pre-existing failures unrelated to this change |

---

## T948-D — verify tsc declaration cleanliness for @cleocode/core

**Status**: complete  
**Commit**: `c475dd11f`  
**Date**: 2026-04-26

### Findings

| Check | Result |
|-------|--------|
| Build (`pnpm --filter @cleocode/core run build`) | PASS |
| `tsc --noEmit` | PASS (0 errors) |
| All 11 required public namespaces present in `dist/index.d.ts` | PASS |
| No `./internal/*` path leaks in `dist/index.d.ts` | PASS |
| No `: any` type occurrences in namespace index declarations | PASS |
| Runtime/declaration parity (`index.js` vs `index.d.ts`) | PASS |
| `tsconfig.json` settings adequate | PASS (no changes needed) |

### Public Namespaces Verified

`admin`, `check` (alias→validation), `conduit`, `gc`, `llm`, `nexus`, `pipeline`, `playbook` (alias→playbooks), `sentient`, `sessions`, `tasks`

### Notes

- `dist/internal.d.ts` exists as an intentional sub-path export (`@cleocode/core/internal`) restricted to `@cleocode/cleo` — it is NOT referenced from `dist/index.d.ts`
- No tsconfig changes were required; settings are already tight (`strict: true`, `noUnusedLocals`, `noUnusedParameters`, `composite: true`)
- Full report at `.cleo/agent-outputs/T948-D-tsc-clean-report.md`



## T1487 — further thin tasks/nexus/playbook dispatch handlers

**Status**: complete  
**Commits**: `7888fc85b`, `67685dffc`, `824cc53eb`  
**Date**: 2026-04-27

### Changes

| File | Change |
|------|--------|
| `packages/cleo/src/dispatch/domains/tasks.ts` | Added `wrapCoreResult` import; replaced all 32 op handlers from `lafsError/lafsSuccess` boilerplate to `wrapCoreResult(await fn(...), opName)` |
| `packages/cleo/src/dispatch/domains/nexus.ts` | Added `wrapCoreResult` import; replaced 47 op handlers; annotated `list`/`orphans.list` with `SSoT-EXEMPT:page-envelope-lifting` |
| `packages/cleo/src/dispatch/domains/playbook.ts` | Added `SSoT-EXEMPT` annotations to `list`, `validate`, `run`, `resume` per ADR-057 D1 + ADR-058 |
| `.cleo/agent-outputs/T1487-thin-plan.md` | Phase 1 audit + implementation plan document |

### Reduction Metrics

| Domain | Before LOC (typed handler body) | After LOC | Reduction |
|--------|--------------------------------|-----------|-----------|
| tasks.ts | ~640 | ~250 | 61% |
| nexus.ts | ~770 | ~230 | 70% |
| playbook.ts | ~340 | ~340 | 0% (all SSoT-EXEMPT) |

### SSoT-EXEMPT Handlers (annotated per ADR-058)

| Handler | Reason |
|---------|--------|
| `tasks.list` page lifting | Presentation envelope contract — engine puts page in data |
| `tasks.complete` setImmediate | Fire-and-forget side-effect that must not block the complete flow |
| `tasks.relates.add` alias | Backward-compat alias (T5149) in params type by design |
| `tasks.restore` from-routing | from param routes to different engine fns (T5615/T5671 consolidation) |
| `nexus.list` page lifting | SSoT-EXEMPT:page-envelope-lifting |
| `nexus.orphans.list` page lifting | SSoT-EXEMPT:page-envelope-lifting |
| `playbook.list` | db injection + runtime offset pagination (ADR-057 D1) |
| `playbook.validate` | file load + parsePlaybook returns non-wire PlaybookDefinition (ADR-057 D1) |
| `playbook.run` | db injection + file load + executePlaybook runtime SSoT (ADR-057 D1) |
| `playbook.resume` | db injection + gate state machine + resumePlaybook SSoT (ADR-057 D1) |

### Gates

| Gate | Status | Evidence |
|------|--------|---------|
| implemented | PASS | commits:7888fc85b,67685dffc,824cc53eb + files |
| qaPassed | PASS | tsc -b exit 0; biome check --write (no new errors; schema mismatch pre-existing) |
| testsPassed | PASS | tasks:44/44, nexus+playbook:74/74 domain tests pass; pre-existing failures (sqlite-warning-suppress, brain-stdp) unchanged |

---

# Pipeline Manifest — T1467 Dedupe Wave

## T1482 — dedupe NexusSigilListResult / OrchestrateHandoffParams

**Status**: complete  
**Commit**: `fede85da26c621e751a6a994a37bc9c3d90a1797`  
**Date**: 2026-04-27

### Changes

| File | Change |
|------|--------|
| `packages/cleo/src/dispatch/engines/nexus-engine.ts` | Removed local `export interface NexusSigilListResult` + unused `SigilCard` import; added `import type { NexusSigilListResult } from '@cleocode/contracts'` |
| `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` | Removed local `interface OrchestrateHandoffParams`; added `OrchestrateHandoffParams` to existing `import type { ..., OrchestratePlanResult } from '@cleocode/contracts/operations/orchestrate'` |

### Shape Comparison

Both local definitions were shape-identical to their contracts counterparts — no divergence found.

- `NexusSigilListResult`: `{ sigils: SigilCard[]; count: number }` — exact match with `contracts/operations/nexus.ts:929`
- `OrchestrateHandoffParams`: `{ taskId, protocolType, note?, nextAction?, variant?, tier?, idempotencyKey? }` — exact match with `contracts/operations/orchestrate.ts:622`

### Gates

| Gate | Status | Evidence |
|------|--------|---------|
| implemented | PASS | commit:fede85da2 + files |
| qaPassed | PASS | biome ci (0 errors) + tsc (exit 0) |
| testsPassed | PASS (owner override) | 6 pre-existing failures in sqlite-warning-suppress, agent-install, release-ship — unrelated to changes |

### Return

`Implementation complete.`

---

## T1486 — cleo-os decouple from @cleocode/cleo CLI binary

**Agent**: sonnet-worker (claude-sonnet-4-6)
**Date**: 2026-04-27
**Commit**: `3e7f2b8a4a08f854096fcfca3e802d51810a2115`

### Changes

| File | Change |
|------|--------|
| `packages/cleo-os/package.json` | Removed `bin.cleo`, `bin.ct` entries; removed `@cleocode/cleo` from dependencies |
| `packages/cleo-os/src/cli.ts` | Removed `--cleo-version` flag and associated @cleocode/cleo package.json resolution |
| `pnpm-lock.yaml` | Updated after dep removal |

### Findings

- Zero TypeScript imports from `@cleocode/cleo` existed in src/ — coupling was 100% in package.json and a single runtime flag
- All subprocess calls to `cleo` binary are deliberate CLI boundaries (doctor, verify-migrations, postinstall) — kept unchanged
- `@cleocode/contracts` was not needed (no src files import from it) — only `@cleocode/core` already present was needed

### Gates

| Gate | Status | Evidence |
|------|--------|----------|
| implemented | PASS | commit:3e7f2b8a4 + files |
| testsPassed | PASS | 208/208 cleo-os tests via vitest JSON |
| qaPassed | PASS | biome ci (0 errors) + tsc exit 0 |

### Return

`Implementation complete. Manifest appended to pipeline_manifest.`

---

## T1489 — sole-source `*Params`/`*Result` aliases via `@cleocode/contracts` re-exports

**Agent**: sonnet-worker (claude-sonnet-4-6)
**Date**: 2026-04-27

### Phase 1 — Audit

| Location | Finding |
|----------|---------|
| `packages/core/src/admin/ops.ts:12-17` | Generic helpers `AdminOpName/Params/Result/CoreOperation<Op>` — no contracts equivalent; would require adding to contracts to sole-source. **Flagged: shape divergent / no-op** |
| `packages/core/src/conduit/ops.ts:12-17` | Generic helpers `ConduitOpName/Params/Result/CoreOperation<Op>` — same pattern; no contracts equivalent. **Flagged: shape divergent / no-op** |
| `packages/core/src/nexus/ops.ts:24-33` | Generic helpers `NexusOpParams/Result/CoreOperation<K>` — same pattern; no contracts equivalent. **Flagged: shape divergent / no-op** |
| `packages/cleo/src/dispatch/domains/session.ts:52-82` | 7 local type aliases all shape-identical to contracts `Session*Params` types. **Actionable — implemented** |
| `packages/cleo/src/dispatch/domains/pipeline.ts:99-167` | Contracts `pipeline.ts` was intentionally stripped in T1446 (comment in contracts/operations/pipeline.ts confirms). No contracts source to import from. **Flagged: contracts intentionally empty / no-op** |

### Phase 2 — Implementation (session.ts only)

Replaced 7 local type definitions with `import type` from `@cleocode/contracts`:

| Local alias removed | Contracts import added |
|---------------------|----------------------|
| `type SessionShowOpParams` | `SessionShowParams` |
| `type SessionHandoffShowOpParams` | `SessionHandoffShowParams` |
| `type SessionStartOpParams` | `SessionStartParams` |
| `type SessionEndOpParams` | `SessionEndParams` |
| `type SessionResumeOpParams` | `SessionResumeParams` |
| `type SessionSuspendOpParams` | `SessionSuspendParams` |
| `type SessionGcOpParams` | `SessionGcParams` |

Updated `session-opsfromcore.test.ts` to:
- Retain T1444 assertions (OpsFromCore pattern still in use)
- Add T1489 assertions (contracts import present, no local `Session*OpParams` re-definitions)

### Changes

| File | Change |
|------|--------|
| `packages/cleo/src/dispatch/domains/session.ts` | Removed 7 local type aliases; added `import type { SessionEndParams, SessionGcParams, SessionHandoffShowParams, SessionResumeParams, SessionShowParams, SessionStartParams, SessionSuspendParams } from '@cleocode/contracts'` |
| `packages/cleo/src/dispatch/domains/__tests__/session-opsfromcore.test.ts` | Updated to assert T1489 contracts import pattern; split into two focused tests |

### Non-actionable locations (for orchestrator review)

- **admin/ops.ts, conduit/ops.ts, nexus/ops.ts**: Local generic helpers (`XxxOpParams<Op>`) are structural utilities derived from the `XxxOps` type — they don't exist as concrete named exports in contracts. Adding them to contracts would require contract changes (out of scope per task constraints). Recommend a follow-up contracts-addendum task if sole-sourcing these is desired.
- **pipeline/ops.ts (pipeline.ts dispatch)**: Contracts `operations/pipeline.ts` was intentionally emptied in T1446 per the comment "All pipeline *Params/*Result types were removed in T1446 ... OpsFromCore inference from Core function signatures without requiring per-op type aliases in contracts." The local types in pipeline.ts are the intended implementation.

### Gates

| Gate | Status | Evidence |
|------|--------|---------|
| implemented | PASS | commit pending + files:packages/cleo/src/dispatch/domains/session.ts,packages/cleo/src/dispatch/domains/__tests__/session-opsfromcore.test.ts |
| testsPassed | PASS | 67/67 dispatch tests pass; 2/2 session-opsfromcore tests pass |
| qaPassed | PASS | biome ci (0 errors) + tsc (0 errors in session.ts) |

### Return

`Implementation partial. Manifest appended to pipeline_manifest.`

---

## T1490 — thin `add.ts` CLI pre-dispatch logic: move inference to Core

**Agent**: sonnet-worker (claude-sonnet-4-6)
**Date**: 2026-04-27
**Commit**: `33fbe9bf681d12d9ae15f38f30d15c5a858a7151`

### Phase 1 — Audit (add.ts lines 198-272)

Three inference concerns identified:

| Concern | Lines | Description |
|---------|-------|-------------|
| File inference | 200-211 | `--files-infer` invokes `inferFilesViaGitNexus`; `--files` splits CSV |
| Acceptance parsing | 213-234 | Pipe-sep or JSON-array coercion for `--acceptance` |
| Parent inference | 255-270 | Infers `--parent` from active session's `currentTask` when type ≠ epic |

### Phase 2 — Plan

Written to `.cleo/agent-outputs/T1490-add-thin-plan.md`.

### Phase 3 — Implementation

| File | Change |
|------|--------|
| `packages/core/src/tasks/infer-add-params.ts` | **NEW** — `inferTaskAddParams()` with all three inference steps; `inferFilesViaGitNexus()` moved here from CLI; `parseAcceptanceCriteria()` extracted |
| `packages/core/src/tasks/index.ts` | Export `inferTaskAddParams`, `inferFilesViaGitNexus`, `parseAcceptanceCriteria`, `InferAddParamsInput`, `InferAddParamsResult` |
| `packages/core/src/index.ts` | Re-export the same symbols from Core main index |
| `packages/cleo/src/cli/commands/add.ts` | Replace 73-line inference block with `await inferTaskAddParams(...)` call; remove `inferFilesViaGitNexus` import |
| `packages/cleo/src/cli/infer-files-via-gitnexus.ts` | Converted to re-export shim (`export { inferFilesViaGitNexus } from '@cleocode/core'`) |
| `packages/cleo/src/cli/commands/__tests__/add-files-infer.test.ts` | Updated mocks: `vi.mock('@cleocode/core', importOriginal)` pattern |
| `packages/cleo/src/cli/commands/__tests__/add-parent-inference.test.ts` | Updated mocks: same pattern |
| `packages/cleo/src/cli/__tests__/infer-files-via-gitnexus.test.ts` | Updated to test re-export shim; uses `importOriginal` to avoid breaking other modules |
| `packages/cleo/src/cli/commands/__tests__/tasks-command-aliases.test.ts` | Added `inferTaskAddParams: vi.fn().mockResolvedValue({})` to `@cleocode/core` mock |

### Core Function Design

`inferTaskAddParams(projectRoot, input): Promise<InferAddParamsResult>`

- Never writes to `process.stderr` — stderr stays in the CLI layer
- Three non-fatal inference steps: files (GitNexus), acceptance (parse), parent (session)
- `filesInferWarning: boolean` flag returned so CLI can emit the correct user message

### Smoke Tests

```
cleo add --title "T1490 smoke" --dry-run
→ infers parent from session, returns dryRun task

cleo add --title "smoke with AC" --type epic --acceptance "AC1|AC2|AC3|AC4|AC5" --dry-run
→ parses pipe-separated AC, no parent inference for epic

cleo add --title "smoke json AC" --type epic --acceptance '["AC1","AC2","AC3","AC4","AC5"]' --dry-run
→ parses JSON array AC correctly
```

All three smoke tests passed.

### Gates

| Gate | Status | Evidence |
|------|--------|---------|
| implemented | PASS | commit:33fbe9bf6 + 5 files |
| testsPassed | PASS (owner override) | 2630 tests pass; 2 pre-existing sqlite-warning-suppress failures unrelated to T1490 |
| qaPassed | PASS | biome ci (1 pre-existing warning, 0 errors) + tsc exit 0 |

### Return

`Implementation complete. Manifest appended to pipeline_manifest.`

## T1488 — nexus.ts bypass routing (2026-04-27)
- **Commit**: `ff206dc3d`
- **File**: `packages/cleo/src/cli/commands/nexus.ts` (4084 → 4057 LOC, net -27)
- **Converted**: 13 commands to `dispatchRaw()` (full-context, task-footprint, brain-anchors, why, impact-full, conduit-scan, task-symbols, route-map, shape-check, contracts-sync, contracts-show, contracts-link-tasks)
- **Annotated**: 19 `SSoT-EXEMPT` comments on legitimately CLI-side code (no dispatch op, pipeline callbacks, LOOM wiring, file I/O, interactive stdin)
- **Audit findings addressed**: lines 132-146 (statusCommand) and 1208-1215 (analyzeCommand) annotated as SSoT-EXEMPT per ADR-057/ADR-058
- **Phase 2 needed**: 14 new dispatch ops (clusters, flows, context, diff, projects.list/register/remove/scan/clean, refresh-bridge, hot-paths/nodes/cold-symbols, query-cte) — tracked in `.cleo/agent-outputs/T1488-decomp-plan.md`

---

## T948-E — enable forge-ts @example doctests on public Core fns

**Agent**: claude-sonnet-4-6
**Date**: 2026-04-27

### Changes

| File | Change |
|------|--------|
| `forge-ts.config.ts` | Updated `rootDir` from `.` to `./packages/core`; `tsconfig` from `./tsconfig.json` to `./packages/core/tsconfig.json` so forge-ts scans Core source files |
| `packages/core/tsconfig.json` | Added explicit `"strictNullChecks": true, "noImplicitAny": true` (E009 guard — forge-ts requires explicit flags even when implied by `strict: true`) |
| `packages/core/src/tasks/add.ts` | Added `@example` blocks to `buildDefaultVerification`, `normalizePriority`, `getTaskDepth`, `inferTaskType`, `getNextPosition` |
| `packages/core/src/tasks/find.ts` | Added `@example` blocks to `fuzzyScore`, `extractInlineFilters` |
| `packages/core/src/sessions/index.ts` | Added `@example` block to `parseScope` |
| `packages/core/src/memory/brain-retrieval.ts` | Added `@example` blocks to `searchBrainCompact`, `observeBrain` |

### Verification

| Check | Result |
|-------|--------|
| `forge-ts check` | PASS — 0 errors, 0 warnings |
| `forge-ts test` | 4893/4894 pass (1 pre-existing failure, unrelated to T948-E changes) |
| `pnpm biome ci .` | PASS — 0 errors (1 pre-existing broken-symlink warning) |
| 10 `@example` blocks added | DONE — verified via grep |

### Notes

- The pre-existing 1 forge-ts test failure existed before this task and is not caused by any T948-E change (confirmed via git stash comparison)
- forge-ts requires explicit `strictNullChecks` and `noImplicitAny` flags (E009) even when `strict: true` is set — added to core tsconfig
- `tsdoc.json` was created by `forge-ts doctor --fix` (required for forge-ts to recognize TSDoc extensions)
- Function examples use cast syntax (`as Task[]`) instead of TypeScript type annotations to stay compilable in the doctest sandbox context

### Gates

| Gate | Status | Evidence |
|------|--------|---------|
| implemented | PASS | commit pending + files listed above |
| qaPassed | PASS | forge-ts check (0 errors) + biome ci (0 errors) |
| testsPassed | PASS | forge-ts test: 4893/4894 (pre-existing failure unchanged) |

### Return

`Implementation complete. Manifest appended to pipeline_manifest.`
