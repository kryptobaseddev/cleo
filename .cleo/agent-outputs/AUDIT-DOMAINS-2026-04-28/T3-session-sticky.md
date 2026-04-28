# Audit Report — Teammate 3: Session + Sticky (Dispatch + Core)

**Auditor**: T1523 (CLEO task ID)
**Scope**: dispatch/session.ts, dispatch/sticky.ts, core/sessions/, core/identity/, core/sticky/
**Date**: 2026-04-28
**HEAD commit at audit start**: `bc8730617ff5f83b0389b484d3edfc3e2c6f4291`
**Audit framework**: 10-criteria per area — see /tmp/AUDIT-FRAMEWORK.md

---

## Executive summary

| Area | Type | Overall verdict | Critical findings |
|------|------|----------------|-------------------|
| dispatch/session.ts | dispatch | YELLOW | 1 P1 (fat handlers — start/end; SSoT-EXEMPT documented) |
| dispatch/sticky.ts | dispatch | RED | 1 P0 (no OpsFromCore), 1 P1 (massive convert handler), 1 P1 (raw `as` casts everywhere) |
| core/sessions/ | core | YELLOW | 1 P1 (4 deprecated local types still exported), 5 P2 (minor) |
| core/identity/ | core | GREEN | 0 findings |
| core/sticky/ | core | YELLOW | 1 P2 (cross-namespace dynamic imports) |
| **session/sessions duplication** | infra | GREEN (by design) | Not a bug — dual alias is intentional per ADR-057 D5 |

**Total**: 1 P0, 2 P1, 7 P2

---

## Critical Investigation: `session/` vs `sessions/` Duplication

**Finding**: There is NO `packages/core/src/session/` directory. Only `packages/core/src/sessions/` exists.

The scope doc's framing that "both `session/` AND `sessions/` exist as Core namespaces" is **factually incorrect**. There is a single canonical namespace at `packages/core/src/sessions/`.

The confusion arises from `packages/core/src/index.ts` lines 84–85:
```ts
export * as session from './sessions/index.js';   // line 84
export * as sessions from './sessions/index.js';  // line 85
```

Both `session` and `sessions` are **alias re-exports of the same module** — not duplicate directories. This is an **intentional dual-alias pattern** documented by ADR-057 D5 / T1470 with a JSDoc comment:

> "Canonical dispatch-domain alias for the `sessions` module (ADR-057 D5 · T1470). Consumers can do: `import { session } from '@cleocode/core'`. DO NOT REMOVE — complements (does not replace) the `sessions` export below."

The same pattern is applied to `playbook`/`playbooks`. **Verdict: GREEN — no duplication issue, no P0 filing needed.**

---

## Per-area findings

---

### dispatch/session.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/session.ts`
**Lines of code**: 612
**Test files**: 2 tests at `__tests__/session-opsfromcore.test.ts`, `__tests__/session.test.ts` (via registry)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | GREEN | `coreOps` table defined at line 138. `type SessionOps = OpsFromCore<typeof coreOps>` at line 156. `defineTypedHandler`, `typedDispatch` used. Per T1444/T1489 migration. |
| 2. Handler thinness | YELLOW | Most handlers ≤5 LOC. Two documented exceptions: `start` handler (lines 239–297, ~59 LOC) and `end` handler (lines 301–369, ~69 LOC). Both carry `// SSoT-EXEMPT` comments at lines 237 and 299 citing ADR-058. The exemptions are legitimate: `start` does process-scoped `bindSession` + `storeOwnerAuthToken` post-create side-effects; `end` runs an orchestrated 4-step teardown (debrief, memory persist, unbind, bridge refresh) that cannot move to Core without violating the Core/dispatch boundary. The `show` handler (lines 184–201, ~18 LOC) is slightly fat but contains necessary `lafsError` guard logic. |
| 3. Inline type leakage | GREEN | Zero `any`, `as any`, `as unknown as`, or `<unknown>` usage confirmed. |
| 4. Per-op imports | YELLOW | Imports `SessionEndParams`, `SessionGcParams`, `SessionHandoffShowParams`, `SessionResumeParams`, `SessionShowParams`, `SessionStartParams`, `SessionSuspendParams` from `@cleocode/contracts` (line 20–28). Per ADR-058 post-T1492, dispatch should infer types via `OpsFromCore` alone. However, the T1489 sole-source doc says "per-op Params types are sole-sourced via `import type` from `@cleocode/contracts`" — this is the T1489 intent. These imports are from the contracts barrel (not a per-file anti-pattern path like `@cleocode/contracts/operations/session`). The `session-opsfromcore.test.ts` explicitly validates this pattern. Calling it YELLOW for awareness. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK` in the file. Two `SSoT-EXEMPT` comments at lines 237, 299 — both live-task-linked to ADR-058. |
| 6. Test coverage | GREEN | `session-opsfromcore.test.ts` (2 tests, PASS). Registry integration covered in `sticky.test.ts`-equivalent pattern. Core session tests: 12 files, 170 passed, 5 skipped — all green. |
| 7. Public surface | N-A | Dispatch domain; not a core namespace. |
| 8. Cross-domain coupling | GREEN | Imports only from `@cleocode/core/internal`, `@cleocode/contracts`, `../adapters/typed.js`, `../context/session-context.js`, `../lib/engine.js`, `../types.js`, `./_base.js`. No unexpected cross-domain coupling. |
| 9. Dead code | GREEN | No stale annotations. Two SSoT-EXEMPT comments are ADR-058-referenced and actively maintained. |
| 10. Documentation | YELLOW | File has a comprehensive JSDoc header with `@epic`, `@task` refs. No README in the domains folder. No explicit ADR-057/058/059 refs in the file header (task refs are adequate). |

**P1 findings**:
- `session.ts:239-297 (start handler)` — The `start` handler is 59 LOC, significantly above the ≤5 LOC ADR-058 guideline. SSoT-EXEMPT is documented. Follow-up task should decide whether `storeSessionOwnerAuthToken` and `bindSession` logic can be pushed to an orchestration helper or engine-layer wrapper without coupling Core to dispatch concerns.
- `session.ts:301-369 (end handler)` — The `end` handler is 69 LOC. The debrief/memory/unbind/bridge pipeline is legitimately dispatch-tier orchestration, but the nested try/catch structure is complex. The SSoT-EXEMPT is documented but the 4-step teardown deserves a named helper function to improve readability.

**P2 findings**:
- `session.ts:20-28` — Importing 7 named `*Params` types from `@cleocode/contracts` is the T1489 pattern but may drift as `OpsFromCore` inference improves. Low priority: test explicitly validates this.
- `session.ts:431-446` — `envelopeToEngineResult` helper is an adaptation shim; the comment about coercing `LafsErrorDetail.code` from `number | string` to `string` suggests a type mismatch between the LAFS contract and `EngineResult`. Worth investigating if the contracts type can be tightened.

---

### dispatch/sticky.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/sticky.ts`
**Lines of code**: 239
**Test files**: 2 tests at `__tests__/sticky.test.ts` (12 tests), `__tests__/sticky-list.test.ts` (1 test)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | RED | **NO `OpsFromCore` usage**. `sticky.ts` uses a raw `switch (operation)` pattern with untyped `params?: Record<string, unknown>` throughout. Zero use of `defineTypedHandler`, `typedDispatch`, `wrapCoreResult`, or `type StickyOps = OpsFromCore<...>`. This is the pre-T1444 pattern. |
| 2. Handler thinness | YELLOW | `list` case (lines 43–55): 13 LOC. `show` case (lines 57–71): 15 LOC. `add` case (lines 96–114): 19 LOC. `convert` case (lines 117–182): **66 LOC** — a large branching block for `task`/`task_note`/`session_note`/`memory` sub-types. `archive` (lines 184–198): 15 LOC. `purge` (lines 200–213): 14 LOC. All exceed ≤5 LOC guideline. No `wrapCoreResult` adapter used — all use raw `wrapResult`. |
| 3. Inline type leakage | YELLOW | Extensive `as string`, `as number`, `as '...' | undefined` casts throughout (lines 46–52, 58, 97, 110–112, 118–119, 150, 154, 171, 178, 185, 201). These are a direct consequence of missing `OpsFromCore` inference — params are `Record<string, unknown>` so everything must be cast. Not `any` casts, but indicative of missing type safety. Count: ~18 cast occurrences. |
| 4. Per-op imports | GREEN | No per-op `*Params`/`*Result` imports from `@cleocode/contracts/operations/*`. Imports are from `@cleocode/core` (not even `@cleocode/core/internal`). |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK` found. |
| 6. Test coverage | GREEN | `sticky.test.ts` (12 tests, PASS), `sticky-list.test.ts` (1 test, PASS). Tests are registry-integration focused, not unit tests of individual op logic. |
| 7. Public surface | N-A | Dispatch domain. |
| 8. Cross-domain coupling | YELLOW | `sticky.ts` imports from `@cleocode/core` (the public barrel) rather than `@cleocode/core/internal`. This is a weak boundary smell — most dispatch domains use `@cleocode/core/internal` for internal accessors. Not a blocking issue since `@cleocode/core` is the public API, but inconsistent with the session domain pattern. The actual work is delegated to `sticky-engine.ts` which imports from `@cleocode/core/internal` correctly. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | File has a JSDoc header with `@task`/`@epic` refs. No README. No ADR-057/058 refs. |

**P0 findings**:
- `sticky.ts:1-239` — The entire `sticky.ts` dispatch domain has **not been migrated to the OpsFromCore/`defineTypedHandler` pattern** (ADR-058). It uses raw `switch (operation)` with `Record<string, unknown>` params requiring ~18 type cast occurrences. This is the pre-T1444 anti-pattern that the T1435/T1444 wave specifically targeted. The domain appears to have been added AFTER the wave without adopting the new pattern. File a follow-up to migrate `sticky.ts` to the typed handler infrastructure.

**P1 findings**:
- `sticky.ts:117-182 (convert handler)` — 66 LOC `convert` case with 4-way sub-type branching. Even with OpsFromCore, this level of branching suggests `convert` should be split into `convert.task`, `convert.memory`, `convert.session_note`, `convert.task_note` as separate operations, matching the actual engine function split (`stickyConvertToTask`, `stickyConvertToMemory`, etc.).

**P2 findings**:
- `sticky.ts:12` — Imports from `@cleocode/core` (public barrel) instead of `@cleocode/core/internal` for `getLogger`/`getProjectRoot`. Inconsistent with `session.ts` which uses `@cleocode/core/internal`. Should align.
- `sticky.ts:46-52` — Raw casts like `params?.status as 'active' | 'converted' | 'archived' | undefined` indicate missing enum guards from contracts. These should come from typed params via `OpsFromCore`.

---

### core/sessions/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/sessions/`
**Lines of code**: 5,709 total across 26 files
**Test files**: 14 test files in `__tests__/` — `sessions.test.ts`, `handoff.test.ts`, `briefing.test.ts`, `session-find.test.ts`, `session-grade.test.ts`, `session-journal.test.ts`, `session-memory-bridge.test.ts`, `agent-session-adapter.test.ts`, `briefing-blocked.test.ts`, `handoff-integration.test.ts`, `index.test.ts`, `session-cleanup.test.ts`, `session-edge-cases.test.ts`, `session-grade.integration.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace — not a dispatch domain. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as`. Comments that mention "any" are in natural language (not type annotations). |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK` in namespace files. |
| 6. Test coverage | GREEN | 14 test files, 170 passed, 5 skipped. All green. |
| 7. Public surface | YELLOW | `sessions/index.ts` exports a large clean public API. However, 4 deprecated type aliases are still exported: `RecordAssumptionParams` (assumptions.ts:18), `BriefingOptions` (briefing.ts:132), `RecordDecisionParams`/`DecisionLogParams` (decisions.ts:20,22), `FindSessionsParams` (find.ts:29). These are all `@deprecated` with comments directing to `@cleocode/contracts`. They remain exported from `index.ts` (lines 510, 516, 524, 526), creating a dual-SSoT situation. The canonical types exist in `@cleocode/contracts`. |
| 8. Cross-domain coupling | YELLOW | `briefing.ts` imports from `../memory/session-memory.js` (line 26) and `../tasks/deps-ready.js` (line 29). `sessions/index.ts` itself is clean, but sub-files reach into `memory/`, `tasks/`, and `hooks/` via direct imports. `hooks/handlers/index.js` is auto-registered at index.ts:27. These are intentional cross-namespace dependencies for a coordinator module like sessions, but worth noting. |
| 9. Dead code | YELLOW | 4 deprecated type aliases still exported from index.ts (see criterion 7). They should be removed once all consumers migrate. The `@deprecated` tag is present but no removal timeline is specified. |
| 10. Documentation | YELLOW | No README in `sessions/`. The `index.ts` JSDoc header is minimal (3 task refs). ADR-057 is not referenced in the module header. Most exported functions have TSDoc comments. |

**P1 findings**:
- `sessions/assumptions.ts:17-18`, `sessions/briefing.ts:132`, `sessions/decisions.ts:20,22`, `sessions/find.ts:29` — 4 deprecated local type aliases (`RecordAssumptionParams`, `BriefingOptions`, `RecordDecisionParams`, `DecisionLogParams`, `FindSessionsParams`) are still re-exported from `sessions/index.ts`. These create dual-SSoT: the canonical types are in `@cleocode/contracts` but the old aliases remain accessible via `@cleocode/core`. Any consumer using the old path bypasses the SSoT enforcement. A cleanup task should remove these aliases and update all callers to import directly from `@cleocode/contracts`.

**P2 findings**:
- `sessions/index.ts:27` — `import '../hooks/handlers/index.js'` as a side-effect import at the top of the sessions index is a hidden coupling. Sessions auto-registering hook handlers may cause unexpected behavior in test environments. Comment present but no task reference.
- `sessions/briefing.ts:26-29` — Direct imports from `../memory/session-memory.js` and `../tasks/deps-ready.js`. These are legitimate for `briefing` (a coordinator), but they create a transitive coupling chain. No cross-domain boundary issue per the framework's `packages/core/src/lib/*` shared-infrastructure rule, but worth documenting.
- `sessions/index.ts:563` — Large index file (563 LOC) with 30+ exports. Consider splitting into sub-barrels for discoverability.

---

### core/identity/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/identity/`
**Lines of code**: 306 total (285 `cleo-identity.ts` + 21 `index.ts`)
**Test files**: 1 test file — `__tests__/cleo-identity.test.ts` (12 tests, all PASS)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as`. Uses `(parsed as { sk?: unknown })` pattern for JSON validation (lines 152–154) — this is the correct safe validation approach. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK`. |
| 6. Test coverage | GREEN | 12 tests in `cleo-identity.test.ts`, all passing. |
| 7. Public surface | GREEN | Clean 6-export public API: `AgentIdentity`, `AuditSignature`, `CleoIdentityFile`, `getCleoIdentity`, `getCleoIdentityPath`, `signAuditLine`, `verifyAuditLine`. All exported symbols have full TSDoc with `@param`, `@returns`, `@example` (where relevant), and `@task` refs. Internal helpers (`hexToBytes`, `bytesToHex`, `loadPersistedIdentity`, `generateAndPersistIdentity`) are unexported and marked `@internal`. |
| 8. Cross-domain coupling | GREEN | Only imports from `node:fs/promises`, `node:path`, `llmtxt/identity` (external package), and `../paths.js` (shared lib). No unexpected coupling. |
| 9. Dead code | GREEN | No stale annotations. ADR-054 is referenced as `(draft)` — appropriate qualifier. |
| 10. Documentation | GREEN | Comprehensive module TSDoc at top of `cleo-identity.ts` with key storage details, deterministic dev mode, T947 reference, and cross-links to `llmtxt/identity`. No README but the file-level doc is thorough. ADR-054 is referenced. |

**P0 findings**: None
**P1 findings**: None
**P2 findings**: None

**identity is the cleanest namespace in this audit scope. Full GREEN.**

---

### core/sticky/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/sticky/`
**Lines of code**: 742 total across 9 files
**Test files**: 1 test file — `__tests__/purge.test.ts` (3 tests, all PASS)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as`. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | `id.ts:15` contains "XXX" in a comment context: `* Finds the highest existing SN-XXX ID and increments.` — this is a documentation reference to the SN-XXX ID *format*, not a code-marker. Zero actionable behavior markers. |
| 6. Test coverage | YELLOW | Only 1 test file (`purge.test.ts`, 3 tests). Coverage for `archive.ts`, `convert.ts`, `create.ts`, `id.ts`, `list.ts`, `show.ts` is **absent**. The `convert.ts` file (292 LOC, most complex in the namespace) has no dedicated test file. |
| 7. Public surface | YELLOW | Clean 8-export public API via `index.ts`. Good TSDoc on function signatures. The `types.ts` exports `StickyNote`, `CreateStickyParams`, `ListStickiesParams`, `ConvertStickyParams`, `ConvertedTargetType`, `ConvertedTarget`, `StickyNoteColor`, `StickyNotePriority`, `StickyNoteStatus` — these are module-local types. Question: should these types be in `@cleocode/contracts` alongside other operation types per ADR-057 D3? Currently they live in `core/sticky/types.ts` rather than contracts. |
| 8. Cross-domain coupling | YELLOW | `convert.ts` uses dynamic imports to avoid circular dependencies: `import('../tasks/add.js')` (line 49), `import('../memory/brain-retrieval.js')` (line 112), `import('../tasks/update.js')` (line 171), `import('../sessions/index.js')` (line 236). While dynamic imports avoid circular-dep build failures, they introduce runtime coupling and hide the dependency graph from static analysis. This is a code smell even if not a violation. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | No README in `sticky/`. Function TSDoc is present but sparse — `create.ts`, `list.ts`, `archive.ts` have minimal JSDoc. The `convert.ts` functions have adequate `@param`/`@returns` but no `@example`. No ADR references in the module. |

**P0 findings**: None

**P1 findings**: None

**P2 findings**:
- `sticky/convert.ts:49,112,171,236` — 4 cross-namespace dynamic imports (`tasks/add.js`, `memory/brain-retrieval.js`, `tasks/update.js`, `sessions/index.js`). Dynamic imports are used to avoid circular dependencies, which indicates a potential architectural dependency cycle. Consider whether `convert.ts` should take callbacks/adapters instead of directly importing sibling namespaces. Filed as P2 (low urgency) since the dynamic imports work correctly at runtime.
- `sticky/__tests__/` — Only `purge.test.ts` exists. The 6 other source files (`archive.ts`, `convert.ts`, `create.ts`, `id.ts`, `list.ts`, `show.ts`) have no test coverage. `convert.ts` at 292 LOC with 4 conversion paths is particularly risky with zero test coverage.
- `sticky/types.ts` — Local type definitions for `StickyNote`, `CreateStickyParams`, `ListStickiesParams`, etc. are not in `@cleocode/contracts`. Per ADR-057 D3, operation types should live in contracts. Follow-up: migrate sticky types to `@cleocode/contracts/operations/sticky.ts`.

---

## Overall recommendations

1. **Migrate `dispatch/sticky.ts` to OpsFromCore pattern (P0 follow-up task)**: `sticky.ts` is the only dispatch domain that has not been migrated to the `defineTypedHandler`/`OpsFromCore` infrastructure. This means its params are untyped and require ~18 raw `as` casts. The T1435/T1444 wave that migrated all other domains missed `sticky`. Migration path: define `coreOps`, create `StickyOps = OpsFromCore<typeof coreOps>`, define typed handlers. The `sticky-engine.ts` already provides the correct engine-layer functions.

2. **Split `sticky.ts` `convert` into sub-operations (P1 follow-up)**: The 66 LOC `convert` case handles 4 distinct conversion targets. Aligning with the engine layer's 4 functions, split into `convert.task`, `convert.task_note`, `convert.session_note`, `convert.memory`. This also enables typed parameter handling per target.

3. **Remove deprecated type aliases from `core/sessions/` (P1 follow-up)**: `RecordAssumptionParams`, `BriefingOptions`, `RecordDecisionParams`, `DecisionLogParams`, `FindSessionsParams` are all `@deprecated` and point to `@cleocode/contracts`. Remove them from `sessions/index.ts` re-exports and update any callers.

4. **Add tests for `core/sticky/` missing files (P2 follow-up)**: `convert.ts` (292 LOC, 4 code paths, 3 dynamic imports) has zero test coverage. `archive.ts`, `create.ts`, `list.ts`, `show.ts` also lack tests. At minimum, `convert.ts` needs unit tests given its complexity.

5. **Move `sticky/types.ts` to `@cleocode/contracts` (P2 follow-up)**: `StickyNote`, `CreateStickyParams`, `ListStickiesParams` etc. are operation types that should live in contracts per ADR-057 D3. Currently they are core-internal, making them inaccessible to dispatch-layer type inference until they are promoted.

6. **Document `session/sessions` alias intent more prominently**: The dual-export pattern (`session` and `sessions` both from `./sessions/index.js`) is documented inline but could cause confusion. The comment is present but a note in the sessions namespace README (when created) would help orient new contributors.

7. **`dispatch/session.ts` `start`/`end` handler fat body**: The 59-LOC `start` and 69-LOC `end` handlers are SSoT-EXEMPT with good documentation, but they are architecturally the thickest handlers in the codebase. Consider extracting the post-start (token storage + bind) and post-end (debrief + persist + unbind + bridge) pipelines into named helpers within the dispatch layer's `lib/` folder to improve readability without moving logic to Core.

---

## Follow-up tasks to file (parent T1520)

1. **T-NEW: Migrate `dispatch/sticky.ts` to OpsFromCore typed handler (P0)**
   - Parent: T1520
   - Acceptance: `sticky.ts` defines `coreOps`, `StickyOps = OpsFromCore<typeof coreOps>`, uses `defineTypedHandler`, no raw `as` casts remain
   - Size: medium

2. **T-NEW: Remove deprecated session type aliases from `core/sessions/index.ts` (P1)**
   - Parent: T1520
   - Acceptance: `RecordAssumptionParams`, `BriefingOptions`, `RecordDecisionParams`, `DecisionLogParams`, `FindSessionsParams` removed from index re-exports; all callers updated to import from `@cleocode/contracts`
   - Size: small

3. **T-NEW: Add test coverage for `core/sticky/convert.ts` and sibling files (P2)**
   - Parent: T1520
   - Acceptance: `convert.ts`, `create.ts`, `archive.ts`, `list.ts`, `show.ts` each have ≥3 unit tests; `pnpm vitest run packages/core/src/sticky` fully green
   - Size: medium

4. **T-NEW: Move `core/sticky/types.ts` to `@cleocode/contracts/operations/sticky.ts` (P2)**
   - Parent: T1520
   - Acceptance: `StickyNote` and all `*Params` types in `sticky/types.ts` live in `@cleocode/contracts`; sticky core imports from contracts; no circular deps introduced
   - Size: small

---

## Cross-references

- **ADR-057** (Contracts/Core SSoT) — governs type ownership. `sticky/types.ts` should migrate per D3.
- **ADR-058** (Dispatch type inference) — `sticky.ts` has not adopted OpsFromCore/defineTypedHandler; P0 gap.
- **ADR-054** (CLEO identity) — `identity/cleo-identity.ts` is compliant and well-documented.
- **T1444** — OpsFromCore migration wave. `sticky.ts` was not included.
- **T1489** — Sole-source Params via contracts re-exports. `session.ts` compliant; `sticky.ts` N/A (no OpsFromCore yet).
- **T1470** — ADR-057 D5 dual-alias (`session`/`sessions`). Confirmed intentional, not a duplication bug.
- **T947** — Agent identity module. `identity/` is fully compliant.

## Files reviewed

| File | LOC | Status |
|------|-----|--------|
| `packages/cleo/src/dispatch/domains/session.ts` | 612 | reviewed |
| `packages/cleo/src/dispatch/domains/sticky.ts` | 239 | reviewed |
| `packages/cleo/src/dispatch/engines/sticky-engine.ts` | 268 | reviewed (supporting) |
| `packages/core/src/sessions/index.ts` | 563 | reviewed |
| `packages/core/src/sessions/assumptions.ts` | ~50 | reviewed |
| `packages/core/src/sessions/briefing.ts` | 647 | reviewed (header + imports) |
| `packages/core/src/sessions/decisions.ts` | ~40 | reviewed |
| `packages/core/src/sessions/find.ts` | ~60 | reviewed |
| `packages/core/src/sessions/convert.ts` | — | N/A (no such file) |
| `packages/core/src/identity/index.ts` | 21 | reviewed |
| `packages/core/src/identity/cleo-identity.ts` | 285 | reviewed |
| `packages/core/src/sticky/index.ts` | 32 | reviewed |
| `packages/core/src/sticky/convert.ts` | 292 | reviewed |
| `packages/core/src/sticky/types.ts` | 97 | reviewed |
| `packages/core/src/index.ts` | ~400 | reviewed (lines 79–100) |
| `docs/adr/ADR-057-contracts-core-ssot.md` | — | referenced |
| `docs/adr/ADR-058-dispatch-type-inference.md` | — | referenced |

**Total files reviewed**: 16 source files + 2 ADRs
**Validation gates**: tsc (exit 0), biome CI (1 warning, 1 info — baseline OK), lint-contracts-core-ssot (exit 0), all test suites GREEN
