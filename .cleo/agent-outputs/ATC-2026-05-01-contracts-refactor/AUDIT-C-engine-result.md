# Audit C — EngineResult Reconciliation

**Date**: 2026-05-01
**Auditor**: Audit-C subagent (claude-sonnet-4-6)
**Scope**: Read-only investigation of all `EngineResult` shapes, constructors, conversion paths, and call sites across `packages/core` and `packages/cleo`.

---

## 1. Executive Summary

**Two distinct `EngineResult` type definitions exist** in the codebase. They are structurally overlapping but diverge in three meaningful ways:

| Dimension | Core (`engine-result.ts`) | Dispatch (`_base.ts`) |
|-----------|--------------------------|----------------------|
| Form | Generic discriminated union `EngineResult<T>` | Concrete non-generic interface `EngineResult` |
| Discriminant guarantee | Strict: `success: true` → `data: T`, no `error` field; `success: false` → `error`, no `data` field | Loose: `success: boolean`, both `data?` and `error?` coexist on any value |
| Extra field | None | `error.problemDetails?: ProblemDetails` (present, never populated) |

**Recommendation**: The canonical shape is `EngineResult<T>` in `packages/core/src/engine-result.ts`. The `_base.ts` interface is a local structural approximation used as the `wrapResult` parameter type. It should be replaced with the core type.

**Total distinct definitions found**: 2 (one canonical, one approximation).

---

## 2. Type Lattice

### 2a. Canonical — `packages/core/src/engine-result.ts:50`

```
EngineResult<T = unknown>  (exported from @cleocode/core)
  = EngineSuccess<T> | EngineFailure

EngineSuccess<T>
  { readonly success: true; readonly data: T; readonly page?: LAFSPage; }

EngineFailure
  { readonly success: false; readonly error: EngineErrorPayload; }

EngineErrorPayload
  { code: string; message: string; exitCode?: number;
    details?: unknown; fix?: string;
    alternatives?: Array<{ action: string; command: string }>; }
```

- **Generic**: yes (`T = unknown` default)
- **Discriminated**: yes (strict — mutually exclusive branches)
- **Constructors**: `engineSuccess<T>(data, page?)`, `engineError<T>(code, message, options?)`
- **Consumer count**: 74 source files in `packages/core/src`

### 2b. Approximation — `packages/cleo/src/dispatch/domains/_base.ts:20`

```
EngineResult  (local interface, not exported from @cleocode/core)
  { success: boolean; data?: unknown; page?: LAFSPage;
    error?: { code: string; message: string; details?: unknown;
              exitCode?: number; fix?: string;
              alternatives?: Array<{action, command}>;
              problemDetails?: ProblemDetails; } }
```

- **Generic**: no (all fields typed as `unknown`)
- **Discriminated**: no (both `data?` and `error?` are simultaneously optional on the same object)
- **Consumer**: the `wrapResult(result: EngineResult, ...)` function defined in the same file
- **Callers of `wrapResult`**: 163 call sites across 12 domain handler files

### 2c. Re-export Shims (not new definitions — pass-throughs only)

The following files re-export the canonical core `EngineResult` type under the same name to minimize import churn. They add no new shape:

| File | Re-export target |
|------|-----------------|
| `packages/cleo/src/dispatch/engines/_error.ts:29` | `export type { EngineResult } from '@cleocode/core'` |
| `packages/cleo/src/dispatch/engines/diagnostics-engine.ts:13` | same |
| `packages/cleo/src/dispatch/engines/sticky-engine.ts:13` | same |
| `packages/cleo/src/dispatch/engines/lifecycle-engine.ts:13` | same |
| `packages/cleo/src/dispatch/engines/pipeline-engine.ts:13` | same |
| `packages/cleo/src/dispatch/engines/session-engine.ts:13` | same |
| `packages/cleo/src/dispatch/engines/tools-engine.ts:13` | same |
| `packages/core/src/orchestrate/handoff-ops.ts:21` | `export type { EngineResult }` (re-export from same package) |

---

## 3. Shape Comparison — Delta Table

| Field | Core `EngineSuccess<T>` | Core `EngineFailure` | `_base.ts EngineResult` | Delta |
|-------|------------------------|---------------------|------------------------|-------|
| `success` | `true` (literal) | `false` (literal) | `boolean` | Weaker discriminant in `_base.ts` |
| `data` | `T` (required on success) | absent | `unknown` (optional always) | `_base.ts` allows `data?` on failure |
| `error` | absent | `EngineErrorPayload` (required) | optional always | `_base.ts` allows `error?` on success |
| `page` | `LAFSPage?` | absent | `LAFSPage?` (always optional) | Same semantics, different position |
| `error.code` | `string` | `string` | `string` | Identical |
| `error.message` | `string` | `string` | `string` | Identical |
| `error.exitCode` | `number?` | `number?` | `number?` | Identical |
| `error.details` | `unknown?` | `unknown?` | `unknown?` | Identical |
| `error.fix` | `string?` | `string?` | `string?` | Identical |
| `error.alternatives` | `Array<{action,command}>?` | same | same | Identical |
| `error.problemDetails` | **absent** | **absent** | `ProblemDetails?` | **Delta**: `_base.ts` only |

**Key finding**: `error.problemDetails` is defined in `_base.ts EngineResult.error` but is **never set** anywhere in the codebase. The `wrapResult` function checks `result.error.problemDetails` (line 60 of `_base.ts`) but no engine function populates this field. It is dead code in the type definition and in the conversion function.

---

## 4. Constructor and Helper Inventory

### 4a. Canonical constructors (in `packages/core/src/engine-result.ts`)

| Function | Signature | Caller count (non-test, non-dist src) |
|----------|-----------|---------------------------------------|
| `engineSuccess<T>` | `(data: T, page?: LAFSPage) => EngineResult<T>` | ~350 call sites in core |
| `engineError<T>` | `(code, message, options?) => EngineResult<T>` | ~234 call sites in core |

### 4b. Dispatch-layer wrapper (in `packages/cleo/src/dispatch/engines/_error.ts`)

| Function | Signature | What it adds vs core |
|----------|-----------|----------------------|
| `engineError<T>` | `(code, message, options?) => EngineResult<T>` | Resolves string code → numeric exit code via `STRING_TO_EXIT`, adds pino logging at correct level, then delegates to `coreEngineError` |
| `engineSuccess` | re-export of `@cleocode/core#engineSuccess` | Nothing — identical |
| `cleoErrorToEngineError<T>` | `(err, fallbackCode, fallbackMessage) => EngineResult<T>` | Converts caught `CleoError` (or unknown) to `EngineResult` |

The dispatch `engineError` is the **preferred entry point** for all domain handlers and engines — it is NOT a separate shape; it returns the same `EngineResult<T>` from core.

### 4c. Conversion helpers

| Function | Location | Purpose |
|----------|----------|---------|
| `wrapResult(result, gateway, domain, op, startTime)` | `_base.ts` | Converts `_base.ts EngineResult` → `DispatchResponse` |
| `wrapCoreResult<T>(result, opName, fallback?)` | `adapters/typed.ts` | Converts core `EngineResult<T>` → `LafsEnvelope<T>` |
| `envelopeToEngineResult(envelope)` | **4 separate copies**: `admin.ts`, `conduit.ts`, `sentient.ts`, `session.ts`, `tasks.ts` | Converts `LafsEnvelope` → minimal `EngineResult`-compatible object for passing to `wrapResult` |
| `lafsSuccess<T>(data, op, extra?)` | `adapters/typed.ts` | Constructs `LafsEnvelope` success |
| `lafsError(code, message, op, fix?)` | `adapters/typed.ts` | Constructs `LafsEnvelope` error |

**Critical finding on `envelopeToEngineResult`**: This function is duplicated 4 times (admin.ts, conduit.ts, sentient.ts, session.ts, tasks.ts — 5 copies total) with minor variation. The tasks.ts version is the only one that preserves `page` metadata. The others silently drop pagination. All 5 are `@internal` local functions that should be a single shared utility.

---

## 5. Conversion Graph

### 5a. Core engine ops → DispatchResponse (OLD path — 163 call sites)

```
Core engine function
  → EngineResult<T>  (discriminated union)
  → passed to wrapResult(result, ...) in domain handler
  → _base.ts EngineResult accepted via structural subtyping
  → DispatchResponse
```

**Domain handlers on this path (OLD, wrapResult only)**:
- `diagnostics.ts` (6 calls)
- `intelligence.ts` (7 calls)
- `memory.ts` (49 calls)
- `orchestrate.ts` (23 calls)
- `release.ts` (8 calls)
- `tools.ts` (34 calls)

### 5b. Typed handler → LAFS envelope → DispatchResponse (NEW path)

```
TypedDomainHandler op function
  → core engine op  →  EngineResult<T>
  → wrapCoreResult(result, opName)  OR  lafsSuccess/lafsError
  → LafsEnvelope<T>
  → typedDispatch returns LafsEnvelope<T>
  → envelopeToEngineResult(envelope)  [conversion: LafsEnvelope → minimal EngineResult shape]
  → wrapResult(result, ...)
  → DispatchResponse
```

**Domain handlers on this path (NEW, typed only)**:
- `check.ts` (80 typed calls)
- `docs.ts` (22 typed calls)
- `ivtr.ts` (23 typed calls)
- `pipeline.ts` (72 typed calls)
- `playbook.ts` (34 typed calls)
- `sticky.ts` (35 typed calls)

### 5c. Mixed handlers (BOTH paths coexist)

- `admin.ts` (6 wrapResult + 115 typed)
- `conduit.ts` (5 wrapResult + 3 typed)
- `nexus.ts` (9 wrapResult + 103 typed)
- `sentient.ts` (4 wrapResult + 26 typed)
- `session.ts` (5 wrapResult + 37 typed)
- `tasks.ts` (5 wrapResult + 50 typed)

### 5d. EngineResult → LafsEnvelope → DispatchResponse (indirect path — NEW path detail)

The NEW typed-handler path is a **round-trip through an extra hop**:
```
EngineResult<T>  →  wrapCoreResult  →  LafsEnvelope<T>  →  envelopeToEngineResult  →  EngineResult-like  →  wrapResult  →  DispatchResponse
```

This is architecturally wasteful: `wrapCoreResult` converts `EngineResult<T>` to `LafsEnvelope<T>`, then `envelopeToEngineResult` converts `LafsEnvelope<T>` back to a simplified `EngineResult`-like shape. The round-trip loses `exitCode`, `details`, `fix`, and `alternatives` fields (they are dropped inside `envelopeToEngineResult` which only captures `code` and `message`).

---

## 6. Discriminated Union Correctness

**Core `EngineResult<T>`**: Correct. TypeScript's type narrowing guarantees:
- If `result.success === true` → TypeScript knows `result` is `EngineSuccess<T>` → `result.data: T` is present, `result.error` does not exist on the type.
- If `result.success === false` → TypeScript knows `result` is `EngineFailure` → `result.error: EngineErrorPayload` is present, `result.data` does not exist on the type.

**`_base.ts EngineResult`**: Incorrect. This is a plain interface with `success: boolean`, `data?: unknown`, `error?: {...}`. There is no discrimination. TypeScript cannot narrow `success: true` to exclude `error?`. The `wrapResult` implementation manually gates on `result.success` at runtime (`...(result.success ? { data: result.data } : {})`) to compensate, but the type system offers no compile-time guarantee.

**Shape leak test**: In practice, no shape leak occurs at runtime. The `engineSuccess` constructor never sets `error`, and `engineError` never sets `data`. But the `_base.ts` interface permits constructing an object with `{ success: true, data: X, error: Y }` without TypeScript objecting, which is a latent footgun.

---

## 7. LAFS Bridge Analysis

The final output of all dispatch paths is `DispatchResponse` (not `LafsEnvelope`). The `wrapResult` function performs the `EngineResult → DispatchResponse` transformation. A separate CLI output layer (`cliOutput` / `cliError` in `cli.ts`) renders `DispatchResponse` as JSON.

There is **no direct `EngineResult → LafsEnvelope` canonical bridge function**. Instead:
- `wrapCoreResult` converts `EngineResult<T>` → `LafsEnvelope<T>` inside typed handlers.
- `envelopeToEngineResult` converts `LafsEnvelope` → minimal EngineResult-like → then passes to `wrapResult`.

**Count of conversion sites**:
- `EngineResult → DispatchResponse` via `wrapResult`: **163 call sites**
- `EngineResult → LafsEnvelope` via `wrapCoreResult`: **141 call sites**
- `LafsEnvelope → EngineResult-like → DispatchResponse` via `envelopeToEngineResult + wrapResult`: **10 call sites** (across 5 duplicated local functions)

**Field loss in the LafsEnvelope round-trip**: `envelopeToEngineResult` in admin.ts, conduit.ts, sentient.ts, session.ts drops `exitCode`, `details`, `fix`, and `alternatives` from the error object. Only `code` and `message` survive. The tasks.ts version additionally preserves `page`. This means error richness is silently downgraded in the NEW typed-handler path through the conversion round-trip.

---

## 8. Why Does `_base.ts` Use a Non-Generic Interface?

The `wrapResult` function signature is:
```ts
function wrapResult(result: EngineResult, gateway, domain, operation, startTime): DispatchResponse
```

It accepts `result: EngineResult` (the non-generic local interface). The reason: domain handlers call `wrapResult` with heterogeneous engine results (tasks, sessions, nexus ops all have different data shapes). Using `EngineResult` (non-generic, `data?: unknown`) makes the call site accept any engine result without explicit generic instantiation.

This is a practical convenience, not a principled design choice. The core `EngineResult<T>` with `T = unknown` default would serve the same purpose:
```ts
function wrapResult(result: EngineResult<unknown>, ...): DispatchResponse
```

Since `EngineResult<unknown>` is `EngineSuccess<unknown> | EngineFailure`, and `EngineSuccess<unknown>` has `data: unknown`, this is structurally compatible with passing any typed `EngineResult<T>` (TypeScript allows `EngineResult<SomeType>` to be assigned to `EngineResult<unknown>` because `SomeType` is assignable to `unknown`).

**Answer**: The non-generic interface exists for convenience (avoid explicit generic at call sites), not because generics are fundamentally incompatible with the pattern. It can be replaced.

---

## 9. Reconciliation Plan

### Step 1: Add `problemDetails?` to `EngineErrorPayload` in core (or accept it is unused)

The `_base.ts` interface defines `error.problemDetails?: ProblemDetails` and `wrapResult` checks for it. Since no code ever sets `problemDetails` on an `EngineResult`, this field is currently dead. Two options:

- **Option A** (recommended): Remove `problemDetails` from `_base.ts` EngineResult. The dead code path in `wrapResult` (line 60) is also removed. If `ProblemDetails` support is needed in the future, add it to `EngineErrorPayload` in core and `engineError()`.
- **Option B**: Add `problemDetails?: ProblemDetails` to `EngineErrorPayload` in `packages/core/src/engine-result.ts` to make the field available through the canonical path.

### Step 2: Replace `_base.ts EngineResult` with core's `EngineResult<unknown>`

Change `_base.ts`:
```ts
// REMOVE:
export interface EngineResult { ... }

// ADD:
export type { EngineResult } from '@cleocode/core';
// or import and use directly:
import type { EngineResult } from '@cleocode/core';

export function wrapResult(
  result: EngineResult<unknown>,  // was: EngineResult (local interface)
  ...
): DispatchResponse { ... }
```

**Blast radius**: All 12 domain handler files that import `wrapResult` from `_base.ts`. Zero call-site changes are required at domain handlers — they pass core `EngineResult<T>` which is assignable to `EngineResult<unknown>`. This is a pure type-level change.

### Step 3: Eliminate `envelopeToEngineResult` duplication

There are 5 copies of essentially the same `envelopeToEngineResult` local function (admin.ts, conduit.ts, sentient.ts, session.ts, tasks.ts). Extract to a shared utility in `_base.ts` or a new `_converters.ts`. Standardize the tasks.ts variant (which is the most correct because it preserves `page`).

**Blast radius**: 5 domain files, 10 call sites. No external API changes.

### Step 4: Fix field-loss in the NEW typed-handler round-trip

`envelopeToEngineResult` drops `exitCode`, `details`, `fix`, and `alternatives` from errors. This occurs because `LafsEnvelope` error (`LafsErrorDetail`) only carries `code`, `message`, `fix`, `alternatives`, `details` — but NOT `exitCode`. The fix:
- Either propagate `exitCode` from `LafsErrorDetail` (requires adding it to `LafsError`'s shape)
- Or avoid the `LafsEnvelope → EngineResult` round-trip entirely: have typed handlers call `wrapResult` directly with a core `EngineResult<T>` rather than going through `envelopeToEngineResult`

**Recommended approach**: Eliminate `envelopeToEngineResult` entirely. Have `typedDispatch` return `EngineResult<T>` instead of `LafsEnvelope<T>`. This collapses the round-trip. Estimated impact: 6 MIXED domain files + 6 NEW domain files.

### Step 5: Migrate OLD-path domains to typed handlers

6 domain handlers remain on the OLD wrapResult-only path (diagnostics, intelligence, memory, orchestrate, release, tools). Migrating them to the TypedDomainHandler pattern is independent of the type reconciliation above but should follow to achieve full uniformity.

---

## 10. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| `_base.ts EngineResult.error.problemDetails` removal breaks caller | Low | Field is never populated; grep confirms zero production code sets it; wrapResult check is dead code |
| Changing `wrapResult` parameter from local `EngineResult` to `EngineResult<unknown>` causes TypeScript errors | Low | Core `EngineResult<T>` is a subtype of `EngineResult<unknown>` — all existing call sites pass typed results; structural compatibility is guaranteed |
| `envelopeToEngineResult` consolidation silently changes page/error behavior | Medium | tasks.ts variant (with `page` support) should be the canonical implementation; other variants drop `page` today — consolidation would be a fix, not a regression |
| Eliminating LafsEnvelope round-trip changes `exitCode` behavior | High | Today, the NEW typed-handler path always loses `exitCode` in conversion. Eliminating the round-trip would RESTORE `exitCode` to DispatchResponse for these operations. This is a fix, but CLI adapter behavior changes (correct exit codes for previously broken paths). Needs test coverage before landing. |
| `cleoErrorToEngineError` in `_error.ts` uses structural duck-typing for CleoError | Low | Already catches generic errors; compatible with any EngineResult<T> shape |

---

## 11. Appendix: File-Level Summary

### EngineResult definition sites (source only, no dist)

| File | Type | Form | Generic | Discriminated |
|------|------|------|---------|---------------|
| `packages/core/src/engine-result.ts:50` | Canonical | `type` alias (union) | Yes (`T = unknown`) | Yes |
| `packages/cleo/src/dispatch/domains/_base.ts:20` | Approximation | `interface` | No | No |

### Key constructor/helper locations

| Symbol | Location | Notes |
|--------|----------|-------|
| `engineSuccess` | `core/src/engine-result.ts:71` | Canonical constructor |
| `engineError` | `core/src/engine-result.ts:88` | Canonical constructor |
| `engineError` (dispatch) | `cleo/src/dispatch/engines/_error.ts:227` | Wraps core; adds exitCode + logging |
| `engineSuccess` (dispatch) | `cleo/src/dispatch/engines/_error.ts:269` | Re-export of core |
| `cleoErrorToEngineError` | `cleo/src/dispatch/engines/_error.ts:318` | Catch-block helper |
| `wrapResult` | `cleo/src/dispatch/domains/_base.ts:39` | EngineResult → DispatchResponse |
| `wrapCoreResult` | `cleo/src/dispatch/adapters/typed.ts:409` | EngineResult<T> → LafsEnvelope<T> |
| `lafsSuccess` | `cleo/src/dispatch/adapters/typed.ts:334` | LafsEnvelope success constructor |
| `lafsError` | `cleo/src/dispatch/adapters/typed.ts:368` | LafsEnvelope error constructor |
| `envelopeToEngineResult` | admin.ts:1214, conduit.ts:231, sentient.ts:218, session.ts:431, tasks.ts:487 | **5 duplicate copies** |
