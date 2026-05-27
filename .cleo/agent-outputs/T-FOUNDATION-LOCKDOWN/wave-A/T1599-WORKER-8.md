# T1599 — Contracts Hygiene Audit (Phase 1 only)

**Worker**: Foundation-Worker-8 · Wave A
**Date**: 2026-04-29
**Mode**: Audit-only — no code edits this round (operator coordination constraint)
**Companion file**: `.cleo/agent-outputs/T1599-contracts-hygiene.md` (canonical audit doc — duplicated below)

---

## 1. Executive headline

| Metric | Value |
|--------|------:|
| Total `^export type / ^export interface` lines, `packages/core/src/` | **1727** |
| Total `^export type / ^export interface` lines, `packages/cleo/src/` | **108** |
| Distinct files exporting types in core | 445 |
| Distinct files exporting types in cleo | 51 |
| Inline type/interface **definitions** in core (excluding barrels & drizzle schemas) | **1267** across **392** files |
| Inline type/interface definitions in cleo (excluding tests) | **81** across 51 files |
| Inline definitions inside drizzle schema files (KEEP IN CORE — db-coupled) | 196 across 13 files |
| `internal.ts` content | **0 inline defs**, 99 re-export blocks (pure barrel — no work) |
| Cleo files importing from `@cleocode/core/internal` | 98 |
| Cleo files importing from `@cleocode/core` (public) | 92 |
| Cleo files importing from `@cleocode/contracts` | **1** (test-only — T1565 invariant HOLDS) |
| Core files importing from `@cleocode/contracts` | 366 |
| `packages/contracts/src/index.ts` re-export blocks | 82 |
| `packages/contracts/src/operations/` modules | 27 |

T1565 layering invariant `cleo /-> contracts` already enforced: only one cleo
file references contracts directly, and it's a comment in a test (`session-opsfromcore.test.ts:28`).

## 2. Core inline-type classification (392 source files)

Bucketed by visibility — does the file's exports already reach `@cleocode/core` consumers?

| Bucket | File count | Action |
|--------|-----------:|--------|
| **A — Public surface** (file or its dir reachable from `core/index.ts` direct or namespace re-export) | **~308** (78%) | **MOVE TO CONTRACTS** — these types are part of the consumer-facing API |
| **B — Internal bridge only** (re-exported through `core/internal.ts` to cleo) | **130** | **MOVE TO CONTRACTS** — cross-package shared, contracts is the rule |
| **C — Truly internal** (not in `index.ts`, not in `internal.ts`, not in any namespace barrel) | **~84** | **KEEP IN CORE** — local to feature, no external consumer |

(Bucket-A and Bucket-B partially overlap because some directory namespace exports re-export only a subset of their dir's symbols. The conservative read: ≥438 file-instances of inline types are surfaced; about 84 are private.)

### Top files by inline-def density (non-schema)

```
35  packages/core/src/hooks/types.ts
26  packages/core/src/skills/types.ts
23  packages/core/src/sentient/events.ts
18  packages/core/src/memory/brain-retrieval.ts
17  packages/core/src/system/archive-analytics.ts
16  packages/core/src/intelligence/types.ts
13  packages/core/src/metrics/token-service.ts
12  packages/core/src/lifecycle/resume.ts
10  packages/core/src/system/health.ts
10  packages/core/src/sentient/tick.ts
10  packages/core/src/orchestration/protocol-validators.ts
10  packages/core/src/nexus/transfer-types.ts
10  packages/core/src/memory/brain-maintenance.ts
10  packages/core/src/docs/docs-ops.ts
```

### Pure type-barrel files (highest-priority MOVE candidates)

These are dedicated `*types.ts` modules — moving them is the highest-yield, lowest-risk action because they have no runtime symbols mixed in:

| Source | Suggested target |
|--------|------------------|
| `core/src/adrs/types.ts` | `contracts/src/adrs/types.ts` |
| `core/src/compliance/protocol-types.ts` | `contracts/src/compliance/protocol-types.ts` |
| `core/src/sessions/types.ts` | `contracts/src/sessions/types.ts` (already partial in contracts) |
| `core/src/skills/types.ts` | `contracts/src/skills/types.ts` (`skills.ts` exists) |
| `core/src/skills/precedence-types.ts` | `contracts/src/skills/precedence-types.ts` |
| `core/src/sticky/types.ts` | `contracts/src/sticky/types.ts` (`sticky.ts` exists) |
| `core/src/intelligence/types.ts` | `contracts/src/intelligence/types.ts` (intelligence ops exist) |
| `core/src/llm/types.ts` | `contracts/src/llm/types.ts` |
| `core/src/memory/brain-row-types.ts` | `contracts/src/brain/row-types.ts` |
| `core/src/memory/edge-types.ts` | `contracts/src/brain/edge-types.ts` |
| `core/src/nexus/transfer-types.ts` | `contracts/src/nexus/transfer-types.ts` |
| `core/src/observability/types.ts` | `contracts/src/observability/types.ts` |
| `core/src/harness/types.ts` | `contracts/src/harness/types.ts` |
| `core/src/hooks/types.ts` | `contracts/src/hooks/types.ts` (`hooks.ts` exists, may need split or merge) |

**14 type-barrel files account for ~228 inline definitions.** A single Phase-2 commit per file would migrate ~14% of all inline core types to contracts.

## 3. KEEP IN CORE (DO NOT MOVE)

| File pattern | Why |
|--------------|-----|
| `core/src/store/*-schema.ts` (tasks-schema, memory-schema, nexus-schema, signaldock-schema, conduit-schema, chain-schema, etc.) | Drizzle schema declarations — the `export type Foo = typeof tableFoo.$inferInsert` patterns are runtime-coupled to drizzle imports. Moving them inverts the dependency graph. **196 inline defs across 13 files KEEP**. |
| `core/src/store/validation-schemas.ts`, `nexus-validation-schemas.ts` | Co-located with drizzle schemas. KEEP. |
| `core/src/internal.ts` | Pure barrel, 0 inline defs, only re-exports. Already correct. |
| `core/src/{deriver,gc,sentient/*-walker,reconciliation,...}` private utility types | Bucket-C local types not surfaced. KEEP. ~84 files. |

## 4. Cleo inline-type classification (81 inline defs across 51 files)

| Sub-bucket | Examples | Action |
|------------|----------|--------|
| **MOVE TO CONTRACTS — Dispatch envelope** (CRITICAL, used by every domain handler) | `dispatch/types.ts`: `DispatchRequest`, `DispatchResponse`, `DispatchError`, `DomainHandler`, `Middleware`, `DispatchNext`, `RateLimitMeta`, `Gateway`, `Source`, `Tier`, `CanonicalDomain` (12 types) | New module: `contracts/src/dispatch/envelope.ts` + `dispatch/index.ts` barrel |
| **MOVE TO CONTRACTS — Engine result shapes** (already partly aliased) | `dispatch/domains/_base.ts`: `EngineResult`; multiple engines re-export it | Should resolve via `@cleocode/contracts/engines/result.ts` (currently from `@cleocode/core`) |
| **MOVE TO CONTRACTS — Dispatch config** | `dispatch/lib/defaults.ts`: `DispatchConfig`, `LifecycleEnforcementConfig`, `ProtocolValidationConfig`; `dispatch/middleware/rate-limiter.ts`: `RateLimitConfig`, `RateLimitingConfig` | `contracts/src/dispatch/config.ts` |
| **MOVE TO CONTRACTS — Operation registry** | `dispatch/registry.ts`: `OperationDef`, `Resolution` | `contracts/src/dispatch/registry.ts` |
| **MOVE TO CONTRACTS — Engine result data shapes** | `dispatch/engines/system-engine.ts`: `DashboardData`, `StatsData`, `LogQueryData`, `ContextData`, `SequenceData`, `RoadmapData`, `ComplianceData`, `HelpData`, `SyncData`, `PathsData`, `ScaffoldHubData`, `SmokeProbe`, `SmokeResult`, `RuntimeData`, `RuntimeDiagnostics` (15 types) | These are LAFS response payloads — `contracts/src/system/responses.ts` |
| **MOVE TO CONTRACTS — Plan/Worker data** | `orchestrate-engine.ts`: `OrchestratePlanInput`, `PlanWorkerEntry`, `PlanWave`, `PlanWarning` | `contracts/src/orchestrate/plan.ts` (operations/orchestrate.ts already exists) |
| **MOVE TO CONTRACTS — Domain-specific result types** | `task-engine.ts`: `LifecycleStageEntry`, `IvtrHistoryEntry`; `domains/check/canon.ts`: `CanonViolation`, `CanonDocAssertion`, `CanonCheckResult`, `CanonCheckParams`; `domains/playbook.ts`: `PlaybookRuntimeOverrides`; `domains/nexus.ts`: `NexusImpactAffectedSymbol`; `engines/hooks-engine.ts`: `ProviderMatrixEntry`, `HookMatrixResult`; `cli/renderers/index.ts`: `CliOutputOptions`, `CliErrorDetails`; `cli/renderers/system.ts`: `RenderWavesOptions`, `RenderWavesMode` | Per-domain contracts modules |
| **KEEP IN CLEO — generated `OpsFromCore<T>` aliases** (5 files: `pipeline.ts`, `ivtr.ts`, `orchestrate.ts`, `release.ts`, `sticky.ts`) | These are derived types over local const records (`typeof coreOps`). Moving them moves nothing — definition lives where ops record lives. | KEEP |
| **KEEP IN CLEO — generic dispatch utilities** | `dispatch/adapters/typed.ts`: `OpsFromCore<C>`, `TypedOpRecord`, `TypedDomainHandler` | Generic type-only utilities — but if cleo can't import from contracts (T1565), and these are useful broadly, **MOVE**: `contracts/src/dispatch/typed.ts` |
| **KEEP IN CLEO — internal one-shots** | `backfill/audit-columns.ts`: 3 backfill-only types; `migrations/2026-04-25-...`: 3 migration-only types; `_ProtoEnvelopeStub`; `cli/lib/registry-args.ts` re-exports of `CittyArgDef`/`ParamDef` (already in contracts via core) | KEEP |

**Of 81 cleo inline defs: ~55 are MOVE candidates, ~26 KEEP.**

## 5. Recommended phased relocation map

**Phase 2A — Pure type barrels (LOW RISK, HIGH YIELD).** 14 files × ~228 types.
Source: `core/src/{adrs,compliance,sessions,skills,sticky,intelligence,llm,memory,nexus,observability,harness,hooks}/types.ts` → `contracts/src/<dir>/types.ts`. Each is a single mechanical cut/paste + barrel update.

**Phase 2B — Cleo dispatch envelope (CRITICAL CHAIN).** 1 file × 12 types: `cleo/dispatch/types.ts` → `contracts/src/dispatch/envelope.ts`. Cleo `dispatch/types.ts` becomes a re-export shim for back-compat. **This unblocks T1565 from being a coincidence to a structurally-enforceable invariant.**

**Phase 2C — System/orchestrate engine data shapes.** Cleo `system-engine.ts` (15 types) + `orchestrate-engine.ts` (4 types) → `contracts/src/system/responses.ts` and `contracts/src/orchestrate/plan.ts`.

**Phase 2D — Tail (per-domain types).** `task-engine.ts`, `check/canon.ts`, `hooks-engine.ts`, `cli/renderers/*.ts` etc. — touch many files but small per file.

**Phase 2E — Surfaced inline types in core feature dirs.** ~308 files × hundreds of types. Aggregate into `contracts/src/<feature>/<file>.ts` mirroring the source layout. **Multi-week effort. Defer past Wave A.**

## 6. High-risk moves / blockers

| Risk | Description | Mitigation |
|------|-------------|------------|
| **R1** | Drizzle schema files — types like `export type Task = typeof tasks.$inferSelect` are inseparable from runtime drizzle imports. | DO NOT MOVE. Already excluded. |
| **R2** | 17 unpushed commits + concurrent foundation-workers (T1587/T1589/T1590/T1592/T1593/T1596/T1597) likely touch many of the same files. Phase 2 NOW would conflict-storm. | **DEFER all code edits to a follow-up wave.** This audit explicitly recommends Phase 1 only this round. |
| **R3** | `OpsFromCore<typeof coreOps>` aliases reference local const records — moving the alias requires moving the const record (which is impl, not contract). | KEEP these aliases in cleo. They're correctly placed. |
| **R4** | Some core files mix runtime symbols + types. Splitting requires creating a new contracts-side type module + leaving impl in core that imports its own types from contracts. Not a blocker, but doubles the file count. | Plan: introduce `core/src/<area>/impl.ts` for runtime, keep `core/src/<area>/types.ts` as re-export from contracts. |
| **R5** | `contracts` package currently has flat layout (`src/<file>.ts`). Adding `src/dispatch/`, `src/system/`, `src/skills/` subdirs is fine but requires `index.ts` updates and consumers may have `@cleocode/contracts/<file>` imports. | Audit-only; check during Phase 2. Default: **add subdirs** for the new modules but keep flat re-exports from `index.ts` for back-compat. |
| **R6** | A handful of types use `import('@cleocode/lafs')` and `import('@cleocode/core')` inline (e.g. `MVILevel`, `LAFSPage`, `ProblemDetails` in cleo `dispatch/types.ts`). Moving these to contracts adds `@cleocode/lafs` as a contracts dep. | `lafs` is already a leaf package. Adding it to contracts is acceptable. `@cleocode/core` import in dispatch types would be a CYCLE — must be reversed (move `ProblemDetails` to contracts first). |

## 7. Verification queries (Phase 3)

For when Phase 2 actually runs:

```bash
# Inline def count should drop substantially after Phase 2A+2B
grep -rn "^export interface\|^export type [A-Z][A-Za-z0-9_]* =\|^export type [A-Z][A-Za-z0-9_]*<" \
  packages/core/src/ packages/cleo/src/ \
  | grep -v __tests__ | grep -v internal.ts | wc -l
# Expected post-2A+2B: ~1090 (drop of ~258 from 1348)

# Build clean
pnpm tsc --noEmit -p packages/contracts/tsconfig.json
pnpm tsc --noEmit -p packages/core/tsconfig.json
pnpm tsc --noEmit -p packages/cleo/tsconfig.json

# T1565 layering invariant
grep -rE "from '@cleocode/contracts'" packages/cleo/src/ | grep -v __tests__ | wc -l   # MUST == 0
```

## 8. Recommendation

**SHIP PHASE 1 (this audit) ONLY. DEFER PHASE 2/3 TO A LATER WAVE** because:

1. The operator-mandated coordination constraint explicitly forbids file edits while T1587/T1589/T1590/T1592/T1593/T1596/T1597 are concurrent.
2. The 17 unpushed commits include broad refactors (EngineResult union, LAFSPage alignment, T1541 thin-handler) that already touch dispatch types — moving them now would re-conflict that work.
3. Phase 2A alone is mechanically easy but risks 14 simultaneous merge conflicts with workers in `core/<feature>/types.ts` files.
4. The cleo dispatch-envelope move (Phase 2B) is the highest-leverage single commit — owner should sequence it as a dedicated, non-parallel wave after the lockdown completes.
5. The full ambition (~1463 inline defs in core → contracts) is multi-week and should be tracked as its own epic with per-area subtasks (one task per `core/src/<dir>` namespace).

**Proposed sequence**:

- T1599 (this task): land Phase 1 audit, no code → can be marked `cleo complete` when other workers settle.
- T1599-2A: type-barrel migrations (14 mechanical commits).
- T1599-2B: cleo dispatch-envelope migration (1 critical commit, must be alone).
- T1599-2C+2D: engine + per-domain data shapes.
- T1599-2E: per-feature-dir core inline types (epic; spawn one task per `core/src/<dir>`).

---

## Appendix — Raw export counts for reference

```
$ grep -rn "^export type\|^export interface" packages/core/src/ | wc -l
1727

$ grep -rn "^export type\|^export interface" packages/cleo/src/ | wc -l
108

$ grep -rn "^export interface\|^export type [A-Z][A-Za-z0-9_]* =\|^export type [A-Z][A-Za-z0-9_]*<" \
    packages/core/src/ | grep -v __tests__ | grep -v internal.ts | wc -l
1463   # all inline defs in core, excluding tests + barrel

$ grep -rn "^export interface\|^export type [A-Z][A-Za-z0-9_]* =\|^export type [A-Z][A-Za-z0-9_]*<" \
    packages/core/src/ | grep -v __tests__ | grep -v internal.ts \
    | grep -vE "(schema\.ts:|validation-schemas\.ts:|chain-schema\.ts:)" | wc -l
1267   # excluding drizzle schemas

$ grep -rn "^export interface\|^export type [A-Z][A-Za-z0-9_]* =\|^export type [A-Z][A-Za-z0-9_]*<" \
    packages/cleo/src/ | grep -v __tests__ | wc -l
81     # cleo inline defs

$ grep -rn "from '@cleocode/contracts'" packages/cleo/src/ | wc -l
1   # only a comment in test — T1565 invariant enforced
```
