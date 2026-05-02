# Architectural Synthesis — Contracts/SDK/LAFS Reset (T-CSL-RESET)

**Date**: 2026-05-01
**Scope**: Synthesis of 5 parallel audits (A inline-types, B LAFS flow, C EngineResult, D contracts structure, E SDK parity)
**Status**: Discovery complete; HITL decisions required before execution

---

## 1. Executive verdict

The current state has **good bones at the dispatch layer** (handlers correctly route to core), but **three foundational defects** that violate the owner's mandate:

1. **Two parallel SDK shapes**: public `@cleocode/core` exports throw-style functions returning domain types (`showTask → TaskDetail`); internal `@cleocode/core/internal` exports EngineResult-style wrappers (`taskShow → EngineResult<{task, view}>`). An SDK consumer cannot get the same envelope as `cleo show --json` without using the warning-flagged internal path.
2. **560 raw stdout writes in 27 CLI commands** bypass the LAFS envelope entirely. nexus.ts (218), memory.ts (96), brain.ts (77) are worst. 29/114 CLI commands bypass dispatch outright; 14 of those also bypass `cliOutput` (the canonical emitter).
3. **Type duplication chaos**: 128 type names duplicated across 667 instances. 88 cases of core re-declaring contracts types. 7 contracts-internal conflicts (worst: `GateStatus` shape mismatch). LAFS error category casing diverged between contracts and the lafs package.

These are not separate problems — they share a root cause: **the contracts/core/cleo boundary was never enforced**. Engine migrations (T1566 epic) consolidated business logic into core, but the SDK/CLI surface and type ownership were not realigned to match.

---

## 2. Cross-cutting themes (5)

### Theme 1: One canonical envelope, one canonical EngineResult

- **Today**: Two LAFS envelope types coexist (full SDK envelope `LAFSEnvelope` and CLI wire `CliEnvelope`). Both legit per ADR-039 but the conversion path is silently lossy: `envelopeToEngineResult` drops `exitCode`, `details`, `fix`, `alternatives`. This conversion is **duplicated across 5 files** (admin, conduit, sentient, session, tasks).
- **Tomorrow**: One canonical `EngineResult<T>` (core's discriminated union). Cleo's `_base.ts` interface deleted. One `engineResultToLafsEnvelope` function in core. Conversion is lossless. Dead `problemDetails` field either removed or properly populated.

### Theme 2: Single SDK shape regardless of consumer

- **Today**: Public SDK (`showTask`) and internal SDK (`taskShow`) return incompatible shapes. CLI consumers and SDK consumers see different data for the same operation.
- **Tomorrow**: Every domain function in `@cleocode/core` returns `EngineResult<T>` consistently. Public `@cleocode/core` exports are the same as the dispatch path — no internal/external split for shape. Throw-style helpers (`showTask` → `TaskDetail`) become **adapters layered on top** for ergonomics, NOT the core surface.

### Theme 3: Every command emits LAFS — no exceptions

- **Today**: 27 CLI commands, 560 raw writes. nexus, memory, brain, transcript, daemon, sentient, gc all emit formatted text directly. Renderers ARE pure (good), but commands skip them.
- **Tomorrow**: Single rule — every command's terminal output goes through `cliOutput(envelope, formatContext)`. The `--human` flag tells `cliOutput` to route the envelope through a renderer; default is JSON serialize. Zero `console.log` outside renderers/. Help renderer migrated to LAFS too.

### Theme 4: Contracts is the type SSoT, organized + comprehensive

- **Today**: 53 `Result = unknown` stubs (tasks, nexus). 5 ops files excluded from barrel. 6 internal conflicts. LAFS types diverged from `@cleocode/lafs`. `task.schema.json` is a broken stub.
- **Tomorrow**: All consumer-facing types in contracts. Internal contracts conflicts resolved (canonical for each name). LAFS types either re-exported from `@cleocode/lafs` or removed from contracts. Schema emission pipeline restored. `zod` declared as dependency. Operations directory has full coverage for all 18 dispatch domains.

### Theme 5: Registry is the dispatch SSoT, no bypasses

- **Today**: `sentient` and `release` have handlers but **zero registry entries**. CLI bypasses dispatch for 29 commands.
- **Tomorrow**: Every CLI subcommand routes through dispatch. Every dispatch op is in the OPERATIONS registry. Every registry op has a typed core function. Handlers do nothing but route.

---

## 3. Recommended epic structure (T-CSL-RESET)

A single parent epic with **5 sequential waves** of children. Each wave has a clear acceptance gate; waves can be partially parallelized within themselves but waves run sequentially.

> **Sequencing rationale**: each wave depends on the prior wave's foundation. Wave 1 (contracts canonicalization) has to land first because Waves 2–5 reference contracts types. Wave 5 (SDK parity) requires Waves 1–4 to be in place.

### Wave 1 — Contracts canonicalization (foundation)

**Goal**: contracts is the SSoT for all shared types. Zero internal conflicts. Schema emission works. LAFS boundary is clear.

| Task | Files | Size |
|---|---|---|
| Reconcile 7 internal contracts conflicts (GateStatus, TaskPriority, ConduitSendResult, AttachmentKind, AttachmentMetadata, SessionStartResult, NexusWikiResult) | `packages/contracts/src/operations/*.ts`, `packages/contracts/src/index.ts` | medium |
| Re-export LAFS types from `@cleocode/lafs` (delete divergent inlines) | `packages/contracts/src/lafs.ts`, `packages/contracts/src/index.ts` | small |
| Add the 5 missing ops barrel exports (admin, dialectic, docs, intelligence, sticky) | `packages/contracts/src/operations/index.ts` | small |
| Declare `zod` in contracts package.json | `packages/contracts/package.json` | small |
| Fix `task.schema.json` emission pipeline | `packages/contracts/scripts/emit-schemas.mjs`, `packages/contracts/schemas/` | small |
| Fill the 53 `Result = unknown` stubs (tasks 20, nexus 22, others 11) | `packages/contracts/src/operations/{tasks,nexus,...}.ts` | large (split) |

**Wave 1 acceptance**: contracts builds clean, zero internal type conflicts, schema files valid, all 18 domains have ops files in the barrel.

### Wave 2 — EngineResult unification

**Goal**: ONE canonical EngineResult shape used everywhere. Conversion paths are lossless.

| Task | Files | Size |
|---|---|---|
| Add `problemDetails?: ProblemDetails` to core's `EngineErrorPayload` (or delete the dead field from cleo's `_base.ts`) | `packages/core/src/engine-result.ts` | small |
| Delete cleo's `EngineResult` interface in `_base.ts`, update `wrapResult` to use core's discriminated union | `packages/cleo/src/dispatch/domains/_base.ts` | small |
| Consolidate 5 duplicate `envelopeToEngineResult` copies into ONE in core | `packages/core/src/internal.ts`, `packages/cleo/src/dispatch/domains/{admin,conduit,sentient,session,tasks}.ts` | medium |
| Fix the field-loss bug in `envelopeToEngineResult` (preserve exitCode/details/fix/alternatives) | `packages/core/src/<conversion>.ts` | small |

**Wave 2 acceptance**: only one `EngineResult<T>` exists in source. No data loss across `EngineResult ↔ LAFSEnvelope ↔ DispatchResponse`. All tests green.

### Wave 3 — Migrate inline types from cleo to contracts

**Goal**: cleo holds only CLI-internal types (rendering, dispatch plumbing). Consumer-facing types live in contracts.

| Task | Files | Size |
|---|---|---|
| Migrate ~10 cleo dispatch types to contracts (per Audit A migration list) | `packages/cleo/src/dispatch/{domains,lib}/*.ts` → `packages/contracts/src/operations/*.ts` | medium |
| Fill 15+ contracts coverage gaps (HealthReport, BackfillResult, retry types, etc.) | `packages/contracts/src/<new-modules>` | medium |
| Remove the 88 contracts+core type duplicates (core re-exports from contracts) | `packages/core/src/**/*.ts` | medium-large |

**Wave 3 acceptance**: zero cross-package type duplicates. Every consumer-facing type has a single canonical home in contracts.

### Wave 4 — CLI command LAFS compliance

**Goal**: every CLI command emits a LAFS envelope. `--human` routes envelope through renderer. Zero raw writes outside renderers.

| Task | Files | Size |
|---|---|---|
| Migrate 27 bypass commands to use `cliOutput(envelope, formatContext)` (largest first: nexus 218, memory 96, brain 77) | `packages/cleo/src/cli/commands/{nexus,memory,brain,transcript,daemon,sentient,gc,...}.ts` | large (split per-command) |
| Migrate help-renderer to emit LAFS envelope | `packages/cleo/src/cli/help-renderer.ts` | small |
| Migrate `schema.ts` and `audit.ts` to LAFS | `packages/cleo/src/cli/commands/{schema,audit}.ts` | small |
| Lint rule: no `console.log`/`process.stdout.write` outside `renderers/` | `biome.json` or custom lint script | small |

**Wave 4 acceptance**: zero raw stdout writes in cleo source (verified via lint rule). All commands respect `--human`/`--json` via `cliOutput`. Every command emits a valid `CliEnvelope`.

### Wave 5 — SDK surface parity

**Goal**: SDK consumers and CLI consumers get the same shape from the same operation. Public `@cleocode/core` is the canonical SDK; throw-style helpers are layered adapters.

| Task | Files | Size |
|---|---|---|
| Define the public SDK surface contract (which exports are public vs internal) | `packages/core/src/index.ts`, ADR-NEW | small |
| Make all dispatch ops accessible via public `@cleocode/core` (with EngineResult-returning canonical functions) | `packages/core/src/index.ts` | medium |
| Register `sentient` and `release` ops in OPERATIONS registry (currently 0) | `packages/cleo/src/dispatch/registry.ts`, domain handlers | medium |
| Migrate the 29 dispatch-bypass commands to route through dispatch | `packages/cleo/src/cli/commands/*.ts` | large (split) |
| Add `engine-ops.ts` for tasks and memory domains (currently inconsistent) | `packages/core/src/{tasks,memory}/engine-ops.ts` | medium |
| Remove side effects from `release/engine-ops.ts` (console.log step logging routes through structured logger) | `packages/core/src/release/engine-ops.ts` | small |

**Wave 5 acceptance**: 100% CLI ↔ dispatch ↔ core trace parity. Public `@cleocode/core` returns same envelope shape as `cleo --json`. Zero side effects in core domain ops.

---

## 4. HITL decisions required before execution

Before I file the epic and spawn workers, I need your call on these:

1. **Scope**: Approve the 5-wave structure as scoped, or trim/expand? My honest read: this is a 1–2 week multi-session effort, NOT a single overnight push. Should I file it as a multi-session epic with explicit session boundaries?

2. **EngineResult problemDetails decision**: 
   - (a) **DELETE** the dead `problemDetails` field from cleo's `_base.ts` (recommended — never populated anywhere)
   - (b) **MIGRATE UP** — add it to core's `EngineErrorPayload` and start populating it
   - I lean (a). Your call.

3. **Public SDK contract**: 
   - (a) **Keep two surfaces**: throw-style `index.ts` for ergonomic consumers, `EngineResult` `internal.ts` for parity with CLI. Document the distinction and remove the warning flag from `internal.ts`.
   - (b) **Single surface**: deprecate throw-style; everything goes through `EngineResult`. Provide ONE optional `unwrap()` helper for ergonomic consumers who don't want to pattern-match.
   - I lean (b) for parity. Your call.

4. **LAFS envelope reconciliation**:
   - (a) Keep two envelope types (`LAFSEnvelope` full SDK, `CliEnvelope` wire). Document each clearly.
   - (b) Collapse to one (probably `CliEnvelope` since it's what hits the wire).
   - I lean (a) — both serve real purposes; the conversion was the bug, not the duality.

5. **Wave parallelism**: Can workers run inside a wave in parallel (they touch different files), or strict-sequential? I lean parallel within waves. Your call.

6. **Release cadence**: Ship a release at the end of each wave (5 minor releases) or one big release at the end? I lean per-wave shipping for incremental verification.

7. **Lint rule for raw writes (Wave 4)**: hard-block via biome rule, or warning + manual cleanup? I lean hard-block once Wave 4 is complete to prevent regression.

---

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Wave 1 contracts changes break downstream consumers | Medium | High | Each contracts type change ships with a migration note in CHANGELOG; major shape changes get a deprecation cycle |
| Wave 4 (560 raw writes migration) introduces regressions in command output | High | Medium | Migrate per-command; each gets a snapshot test of `cleo <cmd> --json` AND `cleo <cmd> --human` before/after |
| Wave 5 SDK consolidation breaks third-party SDK consumers | Medium | High | Survey npm consumers of `@cleocode/core` first; provide a 1-release deprecation cycle for any throw-style functions being removed |
| Field-loss bug fix exposes existing handlers that depended on missing fields | Low | Medium | Run full test suite after Wave 2; any new failures are real bugs surfaced |
| Migration touches release.ship which is critical infra | Medium | High | Wave 5 release-domain ops register LAST; ensure release pipeline is exercised end-to-end before tagging |
| Tests pass but human renderer regresses | Medium | Medium | Add visual snapshot tests for `--human` output during Wave 4 |

---

## 6. What I will do next

If you approve the plan as-is or with edits, I will:

1. Create a single CLEO epic `T-CSL-RESET` (Contracts/SDK/LAFS Reset)
2. File 5 wave child tasks (W1–W5), each with formal acceptance criteria, dependency on prior wave
3. File atomic implementation tasks under each wave (≤3 files per task per ORC-006)
4. Spawn workers per wave, dependency-ordered, with progress reporting
5. Each wave shipped as a minor CalVer release (2026.5.1, 2026.5.2, ...) before next wave starts

I will NOT spawn any workers until you sign off.

---

## 7. Pointers to underlying audits

- `AUDIT-A-inline-types.md` — 128 type duplicates, 88 contracts+core overlaps, 6-wave migration list
- `AUDIT-B-lafs-flow.md` — 560 raw writes in 27 commands; renderer purity verified
- `AUDIT-C-engine-result.md` — 5 duplicate `envelopeToEngineResult`; field-loss bug; safe migration path
- `AUDIT-D-contracts-structure.md` — health 5.5/10; 53 `Result=unknown` stubs; LAFS divergence
- `AUDIT-E-sdk-parity.md` — public/internal SDK shape mismatch; 29 dispatch-bypass commands; 2 domains without registry entries
