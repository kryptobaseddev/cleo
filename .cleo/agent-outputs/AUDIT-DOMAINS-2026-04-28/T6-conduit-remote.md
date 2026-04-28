# Audit Report — Teammate 6: Conduit-Remote

**Auditor**: T1526 (CLEO task ID for this assignment)
**Scope**: dispatch/conduit.ts · core/conduit/ · core/remote/ · core/otel/
**Date**: 2026-04-28
**HEAD commit at audit start**: bc8730617ff5f83b0389b484d3edfc3e2c6f4291
**Audit framework**: 10-criteria per area — see /tmp/AUDIT-FRAMEWORK.md

---

## Executive Summary

| Area | Type | Overall verdict | Critical findings |
|------|------|----------------|-------------------|
| `dispatch/domains/conduit.ts` | dispatch | YELLOW | 0 P0, 1 P1, 1 P2 |
| `core/conduit/` | core | GREEN | 0 P0, 0 P1, 1 P2 |
| `core/remote/` | core | YELLOW | 0 P0, 1 P1, 1 P2 |
| `core/otel/` | core | YELLOW | 0 P0, 1 P1, 1 P2 |

**Overall**: 3 areas GREEN-to-YELLOW; 0 blocking P0s; pre-existing biome format issue in one conduit test file. No regressions from the v2026.4.152 campaign — OpsFromCore inference and `declare const` ops.ts pattern are healthy.

---

## Per-area Findings

---

### dispatch/domains/conduit.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/conduit.ts`
**Lines of code**: 768
**Test files**: 2 tests
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/__tests__/conduit.test.ts` (11 tests, all pass)
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/__tests__/registry-parity.test.ts` (covers all 8 conduit ops)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | GREEN | `type ConduitOps = OpsFromCore<typeof conduit.conduitCoreOps>` at line 48. No inline Params/Result types. Clean compile-time derivation from `conduit.conduitCoreOps` (ambient `declare const` in ops.ts). |
| 2. Handler thinness | YELLOW | The `ConduitHandler.query()` and `.mutate()` DomainHandler wrapper methods are ~13 LOC each (lines 150-211) but this is acceptable boilerplate consistent with other typed-dispatch handlers. The concern is the **8 `*Impl` functions** (lines 267–767, ~501 LOC total) containing full HTTP and SQLite imperative logic living directly in the dispatch file. ADR-058 D4 explicitly requires handler bodies to "call through to Core or an engine wrapper (no inline business logic)." The typed inner handler ops themselves are thin (1–3 LOC per op, all delegate to `wrapConduitImpl`), but the `*Impl` functions are inline business logic that should reside in `packages/core/src/conduit/`. |
| 3. Inline type leakage | GREEN | Zero `as any`, `as unknown as`, or `<unknown>`. Comment on line 18 references "Zero `as any`" as a design note. No actual type leakage. |
| 4. Per-op imports | GREEN | No per-op imports from `@cleocode/contracts/operations/<file>`. Only import is `import type { conduit } from '@cleocode/core'` for the `OpsFromCore` source. Wire-format imports go through adapters. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, or `HACK` comments in the file. |
| 6. Test coverage | GREEN | 11 tests in conduit.test.ts (all pass). registry-parity.test.ts covers all 8 ops. `pnpm vitest run packages/cleo/src/dispatch/domains/__tests__/conduit.test.ts` → 11/11 pass. |
| 7. Public surface | N-A | Dispatch domain, not a core namespace. |
| 8. Cross-domain coupling | GREEN | Imports: `@cleocode/core` (type-only), `../adapters/typed.js` (dispatch infra), `../types.js` (dispatch types), `./_base.js` (dispatch helpers). Dynamic imports inside `*Impl` functions: `@cleocode/core/internal` (registry), `@cleocode/core/conduit` (LocalTransport), `@cleocode/runtime` (AgentPoller). These are appropriate for a dispatch file that currently owns the impl. |
| 9. Dead code | GREEN | Zero `SSoT-EXEMPT`, `@deprecated`, or stale `TODO(T...)` annotations. |
| 10. Documentation | YELLOW | No dedicated README. TSDoc present on `ConduitHandler` class and `query()`/`mutate()` methods. Module-level JSDoc comment lists all 8 operations and references task IDs T183, T1252, T1422, T1439. No explicit ADR-058 reference in source (referenced in comments implicitly via task ID cross-links). |

**P1 findings**:
- `conduit.ts:267-767` — 501 lines of `*Impl` business logic (HTTP fetch, SQLite operations, polling lifecycle) live in the dispatch layer rather than in `packages/core/src/conduit/`. ADR-058 D3 classifies conduit as **Tier A** ("thin wrapper") and D4 forbids "inline business logic" in handler bodies. The `getStatusImpl`, `peekImpl`, `startPollingImpl`, `stopPollingImpl`, `subscribeTopicImpl`, `publishToTopicImpl`, `listenTopicImpl`, and `sendMessageImpl` functions should be migrated to `packages/core/src/conduit/` as Core operations callable via `conduitCoreOps`. This is a structural debt item — it does not break anything today but prevents `conduitCoreOps` from being a real runtime object (it is currently a type-only `declare const`).

**P2 findings**:
- `conduit.ts:48` — `conduitCoreOps` is an ambient `declare const` (type-only). The `OpsFromCore` inference works correctly at compile time, but there is no runtime value to call. The `*Impl` functions in the dispatch file ARE the conduit Core. Per the note in the ops.ts file, this is a "behavior-preserving" design from T1439 — acceptable short-term, but the migration to real Core functions (P1 above) is needed to fully satisfy ADR-058 D3 Tier A.

---

### core/conduit/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/conduit/`
**Files**: `conduit-client.ts` (214 LOC), `factory.ts` (69 LOC), `http-transport.ts` (202 LOC), `local-transport.ts` (644 LOC), `ops.ts` (39 LOC), `sse-transport.ts` (382 LOC), `index.ts` (16 LOC)
**Total**: ~1,566 LOC
**Test files**: 8 test files in `__tests__/`:
- `a2a-topic.test.ts`, `conduit-client.test.ts`, `factory.test.ts`, `http-transport.test.ts`, `local-credential-flow.test.ts`, `local-transport.test.ts`, `messaging-e2e.test.ts`, `sse-transport.test.ts`
- `pnpm vitest run packages/core/src/conduit` → 7 test files, 121 tests passed, 32 todo. All pass.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace, not dispatch. |
| 2. Handler thinness | N-A | Core namespace, not dispatch. |
| 3. Inline type leakage | GREEN | Zero `as any`, `as unknown as`. One `as ConduitMessage['kind']` cast in `local-transport.ts:518` is a safe narrowing of a validated string from SQLite. One `as unknown as` was claimed "zero" by the file header comment and confirmed by search — no occurrences. |
| 4. Per-op imports | N-A | Core namespace, not dispatch. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK` in any conduit core file. |
| 6. Test coverage | GREEN | 8 test files, 121 tests all passing. Coverage includes: `ConduitClient`, `HttpTransport`, `SseTransport`, `LocalTransport`, `factory.ts` transport resolution, `LocalTransport` credential flow, A2A topic pub-sub, and messaging E2E. Strong coverage of the Transport abstraction and both transport implementations. |
| 7. Public surface | GREEN | `index.ts` exports: `ConduitClient`, `createConduit`, `resolveTransport`, `HttpTransport`, `LocalTransport`, `SseTransport`, and `export type { conduitCoreOps }`. All exported symbols have TSDoc. `ops.ts` exports the ambient `conduitCoreOps` type correctly. No internal implementation details leaked. |
| 8. Cross-domain coupling | GREEN | `conduit-client.ts`, `http-transport.ts`, `sse-transport.ts`, `factory.ts`, `ops.ts` all import exclusively from `@cleocode/contracts` (acceptable). `local-transport.ts` imports `getConduitDbPath` from `../store/conduit-sqlite.js` — this is a sibling `store` module within core, not a cross-package boundary violation. All coupling is within expected boundaries. |
| 9. Dead code | GREEN | Zero `SSoT-EXEMPT`, `@deprecated`, or stale task ID annotations. Task references (T177, T213, T310, T356, T1252) are architectural context annotations, not stale TODOs. |
| 10. Documentation | YELLOW | No `README.md` in `packages/core/src/conduit/`. Module-level JSDoc present on all files. `local-transport.ts` references ADR-037 in a comment. No explicit ADR-058 or ADR-057 references. `conduit-client.ts` and `factory.ts` reference `docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md`. |

**P2 findings**:
- `packages/core/src/conduit/` — No README.md. Given the conduit namespace is the CLEO messaging substrate and has 8 test files and 6 source files, a README covering the transport hierarchy (LocalTransport > SseTransport > HttpTransport priority) would reduce onboarding friction. Filed as P2 documentation gap.

**Additional note on v2026.4.152 regression check**: The `declare const conduitCoreOps` pattern in `ops.ts` (lines 30-39) is healthy — no regression. The pattern uses structural type inference correctly: `ConduitOpParams<Op>` and `ConduitOpResult<Op>` are derived from `ConduitOps` imported from `@cleocode/contracts`. No `declare const` crash from the type-only guard.

**Additional note on biome format issue**: `packages/core/src/conduit/__tests__/messaging-e2e.test.ts` has a pre-existing biome formatting violation (join() call at lines 39-42 needs to be on one line per biome's `join()` rule). This is a pre-existing issue — it does not affect tests (7 files, 121 tests all pass). The biome error is: `Found 1 error` in the `format` check on this file.

---

### core/remote/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/remote/index.ts`
**Lines of code**: 338 LOC
**Test files**: 0 — no `__tests__/` directory, no `.test.ts` file

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace, not dispatch. |
| 2. Handler thinness | N-A | Core namespace, not dispatch. |
| 3. Inline type leakage | GREEN | Zero `as any`, `as unknown as`. Interfaces `RemoteConfig`, `PushResult`, `PullResult`, `RemoteInfo` are all properly defined inline in the module (acceptable for a self-contained utility module with no Contracts counterpart). |
| 4. Per-op imports | N-A | Core namespace, not dispatch. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK`. |
| 6. Test coverage | RED | No test files whatsoever. `core/remote/index.ts` exposes `addRemote`, `removeRemote`, `listRemotes`, `push`, `pull`, `getSyncStatus`, `getCurrentBranch` — all functions that invoke `git` subprocesses. These have meaningful failure modes (non-fast-forward push, merge conflicts, missing remotes) with no automated test coverage. |
| 7. Public surface | YELLOW | `packages/core/src/index.ts:72` exports `export * as remote from './remote/index.js'`. All exported functions have `@task T4884` TSDoc annotations and JSDoc parameter docs. However, `RemoteConfig` interface is defined but never used (exported types `PushResult`, `PullResult`, `RemoteInfo` are used). The `cleoGitExec` helper function is not exported (correct — it is internal). Minor doc gap: `@task T4884` references a task ID that does not exist in the CLEO task database (E_NOT_FOUND), suggesting it was created in a planning context or the task was in a different CLEO project instance. |
| 8. Cross-domain coupling | GREEN | Imports from `../paths.js` (core utility) and `../store/git-checkpoint.js` (core store). Both are within the core package boundary. No cross-package imports beyond core's own infrastructure. |
| 9. Dead code | YELLOW | `RemoteConfig` interface (lines 21-24) is exported but not used by any function signature. `addRemote` takes `url: string, name: string` rather than `RemoteConfig`. This is dead exported surface. Additionally, `@task T4884` is not found in the CLEO task database — could be stale or from a different project context. |
| 10. Documentation | YELLOW | No README.md. No explicit ADR references (ADR-013 and ADR-015 are referenced in the module JSDoc comment at lines 4-8, but only informally). `export * as remote` in core index is confirmed. |

**P1 findings**:
- `packages/core/src/remote/index.ts` (all functions) — **Zero test coverage** for a module that shells out to `git` with network operations (`fetch`, `push`, `pull`). Failure modes include force-push rejection, merge conflicts, and missing remote branch — all tested paths that are currently unverified. This is especially concerning given the `.cleo/.git` repository is the state backup mechanism (ADR-013).

**P2 findings**:
- `core/remote/index.ts:21-24` — `RemoteConfig` interface is exported but unused; all functions use `url: string, name: string` parameters directly. Either the interface should be adopted into function signatures or removed to clean up the public surface.
- `core/remote/index.ts` — `@task T4884` appears in all function TSDoc annotations but does not exist in CLEO task database. Stale or cross-project task reference.

---

### core/otel/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/otel/index.ts`
**Lines of code**: 193 LOC
**Test files**: 0 — no `__tests__/` directory, no `.test.ts` file

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace, not dispatch. |
| 2. Handler thinness | N-A | Core namespace, not dispatch. |
| 3. Inline type leakage | YELLOW | All 7 exported functions return `Promise<Record<string, unknown>>` rather than typed result interfaces. This is a relaxed type that passes biome's no-explicit-any rule but loses caller-side type safety. Additionally, `readJsonlFile` (line 23) returns `Record<string, unknown>[]` — a wide type. Internal casts like `(e.estimated_tokens as number)` (line 34) and `(e.context ?? {}) as Record<string, unknown>` (lines 101, 152) are workarounds for the untyped JSONL data. These are not `as any` violations but represent a type-quality gap. |
| 4. Per-op imports | N-A | Core namespace, not dispatch. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK`. |
| 6. Test coverage | RED | No test files. The `getProjectRoot()` traversal, JSONL parsing, file backup, and all filter logic are untested. `clearOtelData()` modifies the filesystem without any test coverage. |
| 7. Public surface | YELLOW | `packages/core/src/index.ts:60` exports `export * as otel from './otel/index.js'`. All 6 exported functions (`getOtelStatus`, `getOtelSummary`, `getOtelSessions`, `getOtelSpawns`, `getRealTokenUsage`, `clearOtelData`) have JSDoc. However, `readJsonlFile` (internal helper, line 23) and `getTokenFilePath` (line 19), `getProjectRoot` (line 10) are not exported (correct). The return type `Promise<Record<string, unknown>>` for all exported functions means callers get no type safety. |
| 8. Cross-domain coupling | GREEN | Imports only from `node:fs`, `node:path` (Node builtins). No cross-domain or cross-package coupling. Fully standalone. |
| 9. Dead code | GREEN | Zero `SSoT-EXEMPT` or `@deprecated`. `@task T4535` and `@epic T4454` references in the module header do not exist in CLEO task database (E_NOT_FOUND) but this is a documentation annotation, not dead code. |
| 10. Documentation | YELLOW | No README.md. Module header has `@task T4535` and `@epic T4454` references that cannot be verified. No ADR references. The module is exported as `otel` from core's main index but is not listed in the package.json `exports` field as a dedicated subpath (unlike `./conduit`, `./memory`, etc.) — it is accessible only via the root `"."` export. |

**P1 findings**:
- `packages/core/src/otel/index.ts` (all functions) — **Zero test coverage**. `clearOtelData()` performs destructive filesystem operations (overwrite + backup) with no test. `readJsonlFile()` has no error handling for malformed JSON lines (a `JSON.parse()` failure crashes the whole call). This is a data-reliability gap.

**P2 findings**:
- `core/otel/index.ts` — All exported functions return `Promise<Record<string, unknown>>` rather than typed result interfaces. This prevents callers from using the otel API safely without additional narrowing. A typed result union (e.g., `OtelStatusResult`, `OtelSummaryResult`) should be added to `@cleocode/contracts` and used here, per ADR-057.
- `core/otel/index.ts:23` — `readJsonlFile` silently returns `[]` for a missing file (correct) but does not guard against malformed JSONL (individual line `JSON.parse` failures will throw and propagate). Each line parse should be wrapped in try-catch with a warning log.

---

## Overall Recommendations

### Architecture

1. **Migrate `*Impl` functions out of dispatch/conduit.ts into core/conduit/** (P1). The 8 `*Impl` functions (501 LOC) violate ADR-058 D3/D4 Tier A requirements. The migration path: create real Core functions in `packages/core/src/conduit/` (e.g., `conduitStatus`, `conduitPeek`, etc.), update `conduitCoreOps` from `declare const` to a real exported object, update dispatch handlers to call through. This completes the full ADR-058 Tier A model for conduit.

2. **Add tests for core/remote/** (P1). The `.cleo/.git` remote operations are untested. A vitest suite mocking `execFile` (or using a temp git repo) should cover: `addRemote` success/duplicate, `push` fast-forward/rejected, `pull` up-to-date/conflict, `getSyncStatus` ahead/behind counts.

3. **Add tests for core/otel/** (P1). `clearOtelData` filesystem mutation, `readJsonlFile` parsing, and the filter logic in `getOtelSessions`/`getOtelSpawns` need unit coverage. Add malformed-JSON line handling.

4. **Fix pre-existing biome format violation** in `packages/core/src/conduit/__tests__/messaging-e2e.test.ts` (lines 39-42). Run `pnpm biome format --write packages/core/src/conduit/__tests__/messaging-e2e.test.ts`. This is blocking `pnpm biome ci .` from returning exit 0.

### Documentation

5. Add `README.md` to `packages/core/src/conduit/`, `packages/core/src/remote/`, and `packages/core/src/otel/`.

6. Add `core/otel/` as a named subpath in `packages/core/package.json` exports (alongside `./conduit`, `./memory`, etc.) to make its surface discoverable via package introspection.

### Type Quality

7. Define typed result interfaces for `core/otel/` exported functions in `@cleocode/contracts` and replace `Promise<Record<string, unknown>>` returns (ADR-057 compliance).

8. Remove or adopt the unused `RemoteConfig` interface in `core/remote/index.ts`.

### Follow-up Tasks to File

| Title | Parent | Acceptance |
|-------|--------|------------|
| Migrate conduit `*Impl` functions from dispatch to core/conduit/ | T1520 | All 8 `*Impl` functions in core; `conduitCoreOps` is a real exported object; dispatch handlers are ≤5 LOC calling core; tests pass |
| Add vitest coverage for core/remote/ (addRemote, push, pull, getSyncStatus) | T1520 | ≥1 test per exported function; mock `execFile`; conflict and rejection paths covered |
| Add vitest coverage for core/otel/ (clearOtelData, readJsonlFile error handling) | T1520 | `clearOtelData` backup+clear tested; malformed JSONL line handled gracefully; filter logic tested |
| Fix biome format violation in messaging-e2e.test.ts | T1520 | `pnpm biome ci .` exits 0 with ≤1 warning baseline |
| Define typed OtelResult interfaces in @cleocode/contracts for otel module returns | T1520 | All otel exported fns use typed interfaces; no `Promise<Record<string, unknown>>` return types |

---

## Cross-References

- **ADR-057** (Contracts/Core SSoT layering): conduit/ops.ts correctly imports `ConduitOps` from `@cleocode/contracts`. SSoT lint gate passes (`Exit: 0`). core/otel/ has no contracts types — gap identified (P2).
- **ADR-058** (Dispatch type inference): dispatch/conduit.ts correctly uses `OpsFromCore<typeof conduit.conduitCoreOps>`. No per-op imports. The `declare const` ops.ts pattern is healthy (v2026.4.152 regression verified clean). Handler thinness YELLOW due to `*Impl` inline logic.
- **ADR-059** (Override pumps): not directly relevant to this scope.
- **T1439** (OpsFromCore inference, T1435 Wave 1): implemented and verified clean.
- **T1252** (A2A topic operations): implemented across dispatch conduit, local-transport, conduit-client; 7 A2A test cases in `a2a-topic.test.ts`.
- **T1422** (Typed-dispatch migration Wave D): conduit handler fully migrated, 11/11 tests pass.

## Files Reviewed

| File | LOC | Status |
|------|-----|--------|
| `packages/cleo/src/dispatch/domains/conduit.ts` | 768 | YELLOW |
| `packages/core/src/conduit/conduit-client.ts` | 214 | GREEN |
| `packages/core/src/conduit/factory.ts` | 69 | GREEN |
| `packages/core/src/conduit/http-transport.ts` | 202 | GREEN |
| `packages/core/src/conduit/local-transport.ts` | 644 | GREEN |
| `packages/core/src/conduit/ops.ts` | 39 | GREEN |
| `packages/core/src/conduit/sse-transport.ts` | 382 | GREEN |
| `packages/core/src/conduit/index.ts` | 16 | GREEN |
| `packages/core/src/remote/index.ts` | 338 | YELLOW |
| `packages/core/src/otel/index.ts` | 193 | YELLOW |
| **Total** | **2,865** | — |

Test files reviewed: 10 (8 conduit, 1 conduit dispatch, 1 registry-parity)
