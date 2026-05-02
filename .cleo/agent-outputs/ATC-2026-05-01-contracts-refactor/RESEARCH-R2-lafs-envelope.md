# R2: LAFS Envelope Use-Case Analysis

**Task**: T1687
**Date**: 2026-05-02
**Stage**: Research (Wave 1 prep — T-CSL-RESET / T1685)
**Status**: Complete

---

## Key Findings

1. **Three distinct `LAFSEnvelope`-named types exist** across four files, with divergent field sets. This is not merely a dual-shape situation — it is an accidental three-way split.
2. **`CliEnvelope` (from `@cleocode/lafs/src/envelope.ts`) is the canonical wire format** per ADR-039 and is the shape all CLI commands emit. It uses `{success, data?, error?, meta, page?}`.
3. **`LAFSEnvelope` (from `@cleocode/lafs/src/types.ts`) is the LAFS protocol-SDK shape** used exclusively inside `@cleocode/lafs` internals (budget, MVI, field filtering, A2A bridge, conformance). It has never been consumed outside the lafs package by CLEO's own CLI pipeline.
4. **`LAFSEnvelope` in `packages/contracts/src/lafs.ts` is a third, *different* shape** — a contracts-internal inlining that differs from both the SDK shape and the CLI wire shape. It is exported from `@cleocode/contracts` and confuses downstream consumers.
5. **`LafsEnvelope<T>` in contracts is a fourth distinct union type** (alias for `LafsSuccess<T> | LafsError`) that predates the ADR-039 unification and is still in active use in dispatch domain handlers via `envelopeToEngineResult()`.
6. **`EngineResult<T>` is the true internal protocol shape** — the discriminated union all core operations produce. It never hits the wire. A `DispatchResponse` is the dispatch-layer view, and `CliEnvelope` is the serialized wire view.
7. **ADR-039 has no dedicated file** in `docs/adr/`. Its mandate lives only in CHANGELOG entries (commit `74bb8b12`) and inline code comments. The canonical shape it mandates is `CliEnvelope`.

---

## Section 1: Exact Shapes Side-by-Side

### 1.1 `LAFSEnvelope` (SDK protocol shape) — `packages/lafs/src/types.ts`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `$schema` | `'https://lafs.dev/schemas/v1/envelope.schema.json'` | Yes | Literal URL, schema discriminant |
| `_meta` | `LAFSMeta` | Yes | Full protocol metadata (see §1.3) |
| `success` | `boolean` | Yes | True=success, false=failure |
| `result` | `Record<string,unknown> \| Record<string,unknown>[] \| null` | Yes | Payload key is `result` |
| `error` | `LAFSError \| null` | Optional | Structured error (see §1.5) |
| `page` | `LAFSPage \| null` | Optional | Pagination |
| `_extensions` | `Record<string,unknown>` | Optional | Vendor extensions |

Used by: `mviProjection.ts`, `fieldExtraction.ts`, `budgetEnforcement.ts`, `compliance.ts`, `deprecationRegistry.ts`, `validateEnvelope.ts`, `a2a/bridge.ts`, `a2a/task-lifecycle.ts` — all internal to `@cleocode/lafs`.

### 1.2 `CliEnvelope<T>` (canonical wire format) — `packages/lafs/src/envelope.ts`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `success` | `boolean` | Yes | True=success, false=failure |
| `data` | `T` | When success=true | Payload key is `data` (not `result`) |
| `error` | `CliEnvelopeError` | When success=false | See §1.6 |
| `meta` | `CliMeta` | Always | Renamed from `_meta` per ADR-039 |
| `page` | `LAFSPage` | Optional | Re-uses LAFS page types |

No `$schema`. No `_extensions`. No `result` field.

Used by: `packages/core/src/output.ts` (`formatSuccess`, `formatError`), `packages/cleo/src/cli/renderers/index.ts`.

### 1.3 `LAFSMeta` (SDK protocol metadata) — `packages/lafs/src/types.ts`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `specVersion` | `string` | Yes | e.g. `"1.0.0"` |
| `schemaVersion` | `string` | Yes | e.g. `"1.0.0"` |
| `timestamp` | `string` | Yes | ISO 8601 |
| `operation` | `string` | Yes | e.g. `"tasks.list"` |
| `requestId` | `string` | Yes | UUID |
| `transport` | `LAFSTransport` | Yes | `'cli' \| 'http' \| 'grpc' \| 'sdk'` |
| `strict` | `boolean` | Yes | Schema validation mode |
| `mvi` | `MVILevel` | Yes | `'minimal' \| 'standard' \| 'full' \| 'custom'` |
| `contextVersion` | `number` | Yes | Ledger version |
| `sessionId` | `string` | Optional | |
| `warnings` | `Warning[]` | Optional | |

### 1.4 `CliMeta` (wire metadata) — `packages/lafs/src/envelope.ts`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `operation` | `string` | Yes | e.g. `"tasks.add"` |
| `requestId` | `string` | Yes | UUID |
| `duration_ms` | `number` | Yes | Wall-clock duration |
| `timestamp` | `string` | Yes | ISO 8601 |
| `sessionId` | `string` | Optional | |
| `[key: string]` | `unknown` | — | Index signature for extensibility |

**Dropped from `LAFSMeta`**: `specVersion`, `schemaVersion`, `transport`, `strict`, `mvi`, `contextVersion`. Added: `duration_ms`.

### 1.5 `LAFSError` (SDK error) — `packages/lafs/src/types.ts`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `code` | `string` | Yes | Stable machine-readable code |
| `message` | `string` | Yes | Human description |
| `category` | `LAFSErrorCategory` | Yes | One of 10 error categories |
| `retryable` | `boolean` | Yes | |
| `retryAfterMs` | `number \| null` | Yes | |
| `details` | `Record<string,unknown>` | Yes | |
| `agentAction` | `LAFSAgentAction` | Optional | 7-value agent guidance enum |
| `escalationRequired` | `boolean` | Optional | |
| `suggestedAction` | `string` | Optional | |
| `docUrl` | `string` | Optional | |

### 1.6 `CliEnvelopeError` (wire error) — `packages/lafs/src/envelope.ts`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `code` | `number \| string` | Yes | Numeric or string code |
| `codeName` | `string` | Optional | Symbolic name e.g. `"E_NOT_FOUND"` |
| `message` | `string` | Yes | Human description |
| `fix` | `unknown` | Optional | Copy-paste hint |
| `alternatives` | `Array<{action,command}>` | Optional | |
| `details` | `unknown` | Optional | |
| `problemDetails` | `unknown` | Optional | RFC 9457 |
| `[key: string]` | `unknown` | — | Index signature |

**Dropped from `LAFSError`**: `category`, `retryable`, `retryAfterMs` (though `category`, `retryable`, `agentAction` are written to the index-signature in `formatError` in practice). Added: `codeName`, `fix`, `alternatives`, `problemDetails`.

### 1.7 Contracts-Internal `LAFSEnvelope` — `packages/contracts/src/lafs.ts`

This is a THIRD shape, independent of both above. It has `{success, data?, error?, _meta?}` — a hybrid that borrows `data` from `CliEnvelope` but `_meta` from the SDK shape. Its `LAFSError` is also different (uses `fix` and lacks `retryable`/`retryAfterMs`/`agentAction`). This shape is exported from `@cleocode/contracts` and consumed downstream.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `success` | `boolean` | Yes | |
| `data` | `T` | Optional | Uses `data` like `CliEnvelope` |
| `error` | `LAFSError` (contracts version) | Optional | Different shape from SDK |
| `_meta` | `LAFSMeta` (contracts version) | Optional | Subset: `transport`, `mvi`, `page?`, `warnings?`, `durationMs?` |

### 1.8 Contracts `LafsEnvelope<T>` Union — `packages/contracts/src/lafs.ts`

```
type LafsEnvelope<T> = LafsSuccess<T> | LafsError
```
where `LafsSuccess<T>` = `{ success: true, data: T, message?, noChange? }` and `LafsError` = `{ success: false, error: LafsErrorDetail }`.

This is consumed by dispatch domain handlers via `envelopeToEngineResult()` in `tasks.ts`, `session.ts`, `admin.ts`, `conduit.ts`, `sentient.ts`.

---

## Section 2: Conversion Paths

### 2.1 `EngineResult<T>` → `DispatchResponse` via `wrapResult`

**File**: `packages/cleo/src/dispatch/domains/_base.ts:39`

```
EngineResult<T> → DispatchResponse
  success branch: { success, data, page?, meta }
  failure branch: { success:false, error:{code,message,details?,exitCode?,fix?,alternatives?,problemDetails?}, meta }
```

**Fields preserved**: `data`, `page`, `error.code` (must be `string`), `error.message`, optional error details.
**Fields added**: `meta` (from `dispatchMeta()`).
**No data loss** on the happy path.

### 2.2 `DispatchResponse` → `CliEnvelope<T>` via `formatSuccess`/`formatError`

**File**: `packages/core/src/output.ts:132,167`

`DispatchResponse` is conceptually mapped to `CliEnvelope` by `formatSuccess`/`formatError`, which directly construct `CliEnvelope` from the data. The CLI renderer in `packages/cleo/src/cli/renderers/index.ts` calls `formatSuccess(dispatchResponse.data, ...)`.

**Fields dropped**: `meta.gateway`, `meta.domain`, `meta.source`, `meta.rateLimit`, `meta.version`, `meta.sessionId` (only partially re-added via `getCurrentSessionId()`).
**Fields added to `CliMeta`**: `duration_ms` (computed from `startTime`), `requestId` (new UUID), `timestamp` (new ISO timestamp). Note: a *new* `requestId` is generated at output time rather than passed through — this breaks request correlation across `DispatchResponse→CliEnvelope`.

### 2.3 `LafsEnvelope<T>` (contracts) → `EngineResult` via `envelopeToEngineResult`

**Files**: `packages/cleo/src/dispatch/domains/tasks.ts:493`, `session.ts:431`, `admin.ts:1214`, `conduit.ts:231`, `sentient.ts:218`

Each file has its own copy (5 duplicate implementations — a DRY violation):

```
LafsEnvelope<T> → { success, data?, error?: {code:string, message:string} }
  - error.code coerced to string (LafsErrorDetail.code is number|string)
  - all other LafsError fields (fix, alternatives, details) DROPPED
```

**Fields dropped**: `error.fix`, `error.alternatives`, `error.details`, `error.name`.

### 2.4 `DispatchResponse` → `_ProtoEnvelopeStub` → SDK budget/field-filter → back to `DispatchResponse`

**Files**: `packages/cleo/src/dispatch/lib/budget.ts`, `packages/cleo/src/dispatch/middleware/field-filter.ts`

The dispatch layer bridges from the CLI canonical shape to the SDK shape for SDK utility functions:

```
DispatchResponse.data → _ProtoEnvelopeStub.result   (data renamed to result)
DispatchResponse.meta → _ProtoEnvelopeStub._meta    (meta renamed to _meta, fields padded)
```

After SDK call, `_ProtoEnvelopeStub.result` is mapped back to `DispatchResponse.data`. This is the only bidirectional conversion in the codebase. Fields fabricated for `_meta`: `specVersion:'1.2.3'`, `schemaVersion:'2026.2.1'`, `strict:true`, `mvi:'standard'`, `contextVersion:1` — none of these are propagated back.

### 2.5 `LAFSEnvelope` (SDK) → `EngineResult` in `caamp/src/core/lafs.ts`

CAAMP uses its own `LAFSEnvelope<T>` interface (a fourth variant, defined locally in `caamp/src/core/lafs.ts`) that mirrors the SDK proto-shape `{$schema, _meta, result, error, page, success}`. It builds this shape via `buildEnvelope()` and outputs it directly to `console.log`. This shape is **not** `CliEnvelope` — CAAMP commands emit the SDK proto-shape, not the ADR-039 canonical shape.

### 2.6 `studio/src/lib/server/spawn-cli.ts` — fifth local `CliEnvelope` definition

Studio defines its own local `CliEnvelope` interface inline (a fifth independent type definition):
```ts
export interface CliEnvelope {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { message: string; code?: string };
  meta?: Record<string, unknown>;
}
```

This is used to parse CLI stdout. It does not import from `@cleocode/lafs`.

---

## Section 3: Consumer Map

### `LAFSEnvelope` (SDK proto-shape — `@cleocode/lafs/src/types.ts`)

| Consumer | Package | Purpose |
|----------|---------|---------|
| `mviProjection.ts` | `@cleocode/lafs` | MVI stripping |
| `fieldExtraction.ts` | `@cleocode/lafs` | `--fields` resolution |
| `budgetEnforcement.ts` | `@cleocode/lafs` | Token budget middleware |
| `compliance.ts` | `@cleocode/lafs` | Schema conformance pipeline |
| `deprecationRegistry.ts` | `@cleocode/lafs` | Deprecation detection |
| `validateEnvelope.ts` | `@cleocode/lafs` | AJV/Rust schema validation |
| `a2a/bridge.ts` | `@cleocode/lafs` | A2A protocol bridge |
| `a2a/task-lifecycle.ts` | `@cleocode/lafs` | Task state machine attachment |
| `lafs/*.test.ts` (4 files) | `@cleocode/lafs` | Tests |

**All `LAFSEnvelope` (SDK) consumers are inside `@cleocode/lafs`. Zero cross-package consumers.**

### `CliEnvelope` (`@cleocode/lafs/src/envelope.ts`)

| Consumer | Package | Purpose |
|----------|---------|---------|
| `core/src/output.ts` | `@cleocode/core` | `formatSuccess`/`formatError` — wire serialization |
| `cleo/src/cli/renderers/index.ts` | `@cleocode/cleo` | Renderer output |
| `lafs/src/envelope.ts` | `@cleocode/lafs` | Type definition site |

**`CliEnvelope` is the shared wire contract between `core` and `cleo`.** It crosses the `core→cleo` package boundary.

### `LAFSEnvelope` (contracts variant — `@cleocode/contracts/src/lafs.ts`)

| Consumer | Package | Purpose |
|----------|---------|---------|
| `contracts/src/index.ts` | `@cleocode/contracts` | Re-exported |
| Any package importing `@cleocode/contracts` | (all packages) | May use this type |

This type is exported but distinct from the SDK `LAFSEnvelope`. It is a contracts-internal definition with `{success, data?, error?, _meta?}`. It has a different `LAFSError` shape and different `LAFSMeta` fields. **This is a boundary leak**: the contracts package re-exports two types both named `LAFSEnvelope` — one is the contracts-inlined version, one is imported from `@cleocode/lafs`.

### `LafsEnvelope<T>` (contracts union — `@cleocode/contracts/src/lafs.ts`)

| Consumer | Package | Purpose |
|----------|---------|---------|
| Dispatch domain handlers (5 files) | `@cleocode/cleo` | `envelopeToEngineResult()` input |
| `core/src/output.ts` | `@cleocode/core` | Re-exports to downstream |

### `EngineResult<T>` (`@cleocode/core/src/engine-result.ts`)

| Consumer | Package | Purpose |
|----------|---------|---------|
| All core engine-ops files | `@cleocode/core` | Returned by all operations |
| `caamp/adapter.ts` | `@cleocode/core` | CAAMP adapter results |
| `_base.ts` `wrapResult` | `@cleocode/cleo` | Dispatch response wrapper |
| 5 domain files | `@cleocode/cleo` | Passed to `wrapResult` |

### Leaky Cross-Package Patterns

1. **`@cleocode/contracts` exports two different `LAFSEnvelope`s**: `LAFSEnvelope` (contracts-inlined) and the re-exported `LAFSEnvelope` from `@cleocode/lafs`. Both exist in the same barrel. This is a direct name collision waiting to cause confusing import shadowing.
2. **`@cleocode/caamp` defines its own `LAFSEnvelope<T>` locally** in `src/core/lafs.ts`, duplicating the SDK shape. CAAMP outputs the SDK proto-shape to stdout rather than the ADR-039 canonical wire shape.
3. **`@cleocode/studio` defines its own `CliEnvelope` locally** in `spawn-cli.ts` rather than importing from `@cleocode/lafs`.
4. **`envelopeToEngineResult` duplicated 5 times** across dispatch domain files — identical logic, no shared implementation.

---

## Section 4: ADR-039 Mandate

### What ADR-039 Says

ADR-039 has no dedicated file in `docs/adr/` (the directory starts at ADR-051). Its mandate lives in:

- **CHANGELOG.md line 6779**: `"ADR-039 — Wave 4 envelope unification. Records the decision to unify request/response envelopes across transport layers (commit 74bb8b12)."`
- **CHANGELOG.md line 6581–6592**: `"ADR-039 (2026-04-08) replaced the legacy {$schema, _meta, success, result} LAFS shape..."`
- **Multiple inline code comments** citing `ADR-039` as authority for the `{success, data?, error?, meta, page?}` shape.

### ADR-039 Canonical Mandates (reconstructed from code + CHANGELOG)

1. **Single canonical CLI wire shape**: `{success, data?, error?, meta, page?}` — the `CliEnvelope` type in `@cleocode/lafs/src/envelope.ts`.
2. **`meta` always present** (not `_meta`) on every CLI envelope, success and failure.
3. **`data` replaces `result`** — the legacy `result` / `r` keys are invalid.
4. **Three legacy shapes replaced**: `{ok,r,_m}` (minimal MVI), `{$schema,_meta,success,result}` (full LAFS proto), `{success,result}` (observe command).
5. **`@cleocode/lafs` SDK shape (`LAFSEnvelope`) remains valid** for internal SDK use (protocol-level envelopes in A2A, conformance, MVI projection) — it was not abolished, just not exposed on the wire.

### What ADR-039 Does NOT Say

- No guidance on whether the SDK `LAFSEnvelope` and `CliEnvelope` should eventually converge.
- No guidance on how `@cleocode/contracts` should relate to `@cleocode/lafs` envelope types.
- No guidance on CAAMP's output format.
- No single-file authoritative text — the ADR is distributed across commit messages and inline comments.

### Dual-Shape Rationale (from code evidence)

The dual shape is intentional per ADR-039:
- `LAFSEnvelope` (SDK proto-shape with `$schema`, `_meta`, `result`) is the **LAFS protocol spec shape** — necessary for JSON Schema validation, A2A interoperability, conformance testing, and MVI projection which all depend on the `$schema` + `_meta` structure.
- `CliEnvelope` (wire shape with `meta`, `data`) is the **CLEO CLI wire format** — optimized for agent consumption (no schema URL overhead, `data` is more intuitive than `result`, `meta` not prefixed with `_`).

The bridge (`_ProtoEnvelopeStub`) exists to call SDK utilities (budget/field-filter) from the CLI pipeline without re-implementing them.

---

## Section 5: Recommendation

### Choice: HYBRID

**LAFSEnvelope (SDK) is the LAFS protocol shape. CliEnvelope is the public CLEO CLI wire format. DispatchResponse is the internal pipeline shape. EngineResult is the core domain result. These are four distinct layers with legitimate purposes.**

**Rationale:**

The four shapes map cleanly to four layers:

```
Core Domain Layer:    EngineResult<T>         (@cleocode/core — typed, discriminated)
Dispatch Layer:       DispatchResponse         (@cleocode/cleo dispatch — adds meta, gateway, domain)
CLI Wire Layer:       CliEnvelope<T>           (@cleocode/lafs — serialized to stdout)
LAFS Protocol Layer:  LAFSEnvelope             (@cleocode/lafs — SDK-internal, A2A, conformance)
```

Collapsing `LAFSEnvelope` into `CliEnvelope` would break A2A conformance testing, MVI projection, schema validation, and the `@cleocode/lafs` API contract. These subsystems require `$schema` and the `result` key per the LAFS spec.

Collapsing `CliEnvelope` into `LAFSEnvelope` would regress the CLI wire format back to the three-legacy-shape problem ADR-039 solved — agents would parse `result` instead of `data` and `_meta` instead of `meta`.

**What IS broken and MUST be fixed (the real problems):**

1. **`@cleocode/contracts` inlines its own `LAFSEnvelope` and `LAFSMeta` with divergent field shapes.** This creates a fourth variant that diverges silently from both the SDK shape and the wire shape. The contracts-internal `LAFSEnvelope` should be deleted and replaced with `CliEnvelope` for the wire contract, or simply removed if unused in a meaningful way.

2. **`@cleocode/contracts` exports both `LAFSEnvelope` (contracts-inlined)** and re-exports the SDK `LAFSEnvelope` from `@cleocode/lafs`. Two types with the same name in the same barrel = import confusion. One must be renamed or removed.

3. **CAAMP emits SDK proto-shape to stdout** instead of `CliEnvelope`. This violates ADR-039's wire format mandate. CAAMP commands are CLI commands and should emit `CliEnvelope`.

4. **`envelopeToEngineResult` duplicated 5 times** across dispatch domains. Should be a single function in `_base.ts`.

5. **`studio/src/lib/server/spawn-cli.ts` defines its own `CliEnvelope` inline.** Should import from `@cleocode/lafs`.

6. **`@cleocode/lafs/src/envelope.ts` comment block says CliEnvelope replaces three legacy shapes** — but the `LAFSEnvelope` from the same file's `types.ts` is still the primary export. The module-level comment should clarify the two-shape coexistence.

**The boundary, once clean, should be:**
- `CliEnvelope` = the public wire contract. Consumed by anything parsing stdout.
- `LAFSEnvelope` = the LAFS protocol contract. Used internally by `@cleocode/lafs` only.
- Nothing in `@cleocode/contracts` should re-define envelope shapes.

---

## Section 6: W1 Implementation Impact

If the HYBRID recommendation is adopted (clean boundary, fix the real problems):

### Delete

| Symbol | File | Replacement |
|--------|------|-------------|
| `LAFSEnvelope` (contracts-internal) | `packages/contracts/src/lafs.ts:149` | Remove from contracts; consumers should import `CliEnvelope` from `@cleocode/lafs` |
| `LAFSMeta` (contracts-internal) | `packages/contracts/src/lafs.ts:123` | Remove; consumers use `CliMeta` from `@cleocode/lafs` |
| `LAFSErrorCategory` (contracts — uses lowercase strings, incompatible with SDK) | `packages/contracts/src/lafs.ts:17` | Consolidate with `LAFSErrorCategory` from `@cleocode/lafs` (uses uppercase) |
| `LAFSTransport` (contracts — missing `grpc`) | `packages/contracts/src/lafs.ts:58` | Use `LAFSTransport` from `@cleocode/lafs` |
| `GatewayEnvelope`, `GatewaySuccess`, `GatewayError`, `GatewayMeta`, `CleoResponse` | `packages/contracts/src/lafs.ts:279–313` | Evaluate — may be unused or superseded |

### Re-export (not redefine)

| Symbol | Change |
|--------|--------|
| `contracts/src/index.ts` re-export of LAFS types | Replace contracts-inlined definitions with re-exports from `@cleocode/lafs` where compatible |

### Migrate

| File | Change |
|------|--------|
| `packages/cleo/src/dispatch/domains/tasks.ts:493` | Extract `envelopeToEngineResult` to `_base.ts`, remove local definition |
| `packages/cleo/src/dispatch/domains/session.ts:431` | Same |
| `packages/cleo/src/dispatch/domains/admin.ts:1214` | Same |
| `packages/cleo/src/dispatch/domains/conduit.ts:231` | Same |
| `packages/cleo/src/dispatch/domains/sentient.ts:218` | Same |
| `packages/caamp/src/core/lafs.ts` | Replace `buildEnvelope`/`outputSuccess` with `CliEnvelope`-based output (use `formatSuccess`/`formatError` from `@cleocode/core`) |
| `packages/studio/src/lib/server/spawn-cli.ts` | Import `CliEnvelope` from `@cleocode/lafs` instead of local definition |

### No change

| Symbol | Reason |
|--------|--------|
| `LAFSEnvelope` in `@cleocode/lafs/src/types.ts` | Stable SDK protocol shape — do not touch |
| `CliEnvelope` in `@cleocode/lafs/src/envelope.ts` | Canonical wire format — do not touch |
| `EngineResult<T>` in `@cleocode/core/src/engine-result.ts` | Canonical domain result — do not touch |
| `DispatchResponse` in `@cleocode/cleo/src/dispatch/types.ts` | Canonical dispatch-layer shape — do not touch |
| `_ProtoEnvelopeStub` in `packages/cleo/src/dispatch/lib/proto-envelope.ts` | Necessary bridge shim — keep but document better |
| `LafsEnvelope<T>` union in contracts | May be needed for backward compat of `envelopeToEngineResult` input type; review after DRY fix |

### `engineResultToLafsEnvelope` family

There is no function of this exact name in the codebase. The actual conversion functions are:
- `envelopeToEngineResult` (×5, converts `LafsEnvelope→EngineResult`) — DRY target
- `wrapResult` (converts `EngineResult→DispatchResponse`) — in `_base.ts`, single canonical implementation

The W1 implementation should: (1) consolidate `envelopeToEngineResult` into `_base.ts`, (2) remove the contracts-inlined duplicate envelope shapes, (3) document the four-layer model in `docs/adr/ADR-039-lafs-envelope-spec.md` (create the missing file).

---

## Sources

| File | Role |
|------|------|
| `/mnt/projects/cleocode/packages/lafs/src/types.ts` | SDK `LAFSEnvelope`, `LAFSMeta`, `LAFSError` |
| `/mnt/projects/cleocode/packages/lafs/src/envelope.ts` | `CliEnvelope`, `CliMeta`, `CliEnvelopeError`, `createEnvelope` |
| `/mnt/projects/cleocode/packages/contracts/src/lafs.ts` | Contracts-internal envelope types |
| `/mnt/projects/cleocode/packages/contracts/src/index.ts` | Contracts barrel export |
| `/mnt/projects/cleocode/packages/core/src/engine-result.ts` | `EngineResult`, `engineSuccess`, `engineError` |
| `/mnt/projects/cleocode/packages/core/src/output.ts` | `formatSuccess`, `formatError`, `CliEnvelope` usage |
| `/mnt/projects/cleocode/packages/cleo/src/dispatch/types.ts` | `DispatchResponse` |
| `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/_base.ts` | `wrapResult` |
| `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/tasks.ts:493` | `envelopeToEngineResult` (duplicate 1) |
| `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/session.ts:431` | `envelopeToEngineResult` (duplicate 2) |
| `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/admin.ts:1214` | `envelopeToEngineResult` (duplicate 3) |
| `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/conduit.ts:231` | `envelopeToEngineResult` (duplicate 4) |
| `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/sentient.ts:218` | `envelopeToEngineResult` (duplicate 5) |
| `/mnt/projects/cleocode/packages/cleo/src/dispatch/lib/proto-envelope.ts` | `_ProtoEnvelopeStub` bridge |
| `/mnt/projects/cleocode/packages/cleo/src/dispatch/lib/budget.ts` | `CliEnvelope→LAFSEnvelope` bridge for SDK budget |
| `/mnt/projects/cleocode/packages/cleo/src/dispatch/middleware/field-filter.ts` | `CliEnvelope→LAFSEnvelope` bridge for SDK field filter |
| `/mnt/projects/cleocode/packages/cleo/src/cli/renderers/lafs-validator.ts` | ADR-039 invariant validation |
| `/mnt/projects/cleocode/packages/caamp/src/core/lafs.ts` | CAAMP's local `LAFSEnvelope` definition + `buildEnvelope` |
| `/mnt/projects/cleocode/packages/studio/src/lib/server/spawn-cli.ts` | Studio's local `CliEnvelope` definition |
| `/mnt/projects/cleocode/CHANGELOG.md` (lines 6779, 6581, 3368) | ADR-039 primary source |
| `/mnt/projects/cleocode/docs/adr/ADR-057-contracts-core-ssot.md` | References ADR-039 |
| `packages/cleo/src/cli/renderers/index.ts` | `CliEnvelope` import + usage |

## Open Questions (Needs Follow-up)

- Is `GatewayEnvelope`/`GatewayMeta`/`CleoResponse` (in contracts) actively used anywhere, or is it dead code from a pre-ADR-039 gateway experiment?
- Should `@cleocode/lafs` export `CliEnvelope` at all, or should it live in `@cleocode/core` alongside `formatSuccess`/`formatError`? Currently `CliEnvelope` and `LAFSEnvelope` coexist in the same package — this is what causes confusion.
- CAAMP output format: CAAMP commands emit SDK proto-shape. Should CAAMP be brought into ADR-039 compliance in W1, or is that a separate task?
- Should ADR-039 be documented in `docs/adr/ADR-039-lafs-envelope-spec.md` as part of W1? It currently has no canonical file.
