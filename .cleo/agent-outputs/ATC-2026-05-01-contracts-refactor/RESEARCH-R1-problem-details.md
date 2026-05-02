# R1: ProblemDetails Investigation

**Task**: T1686 — Pre-Wave-2 research  
**Date**: 2026-05-01  
**Status**: Complete  
**Scope**: Read-only investigation — no code changes made

---

## Key Findings

1. `ProblemDetails` is defined in **two distinct locations** and a **third interface exists in lafs/a2a** — creating type duplication that Wave 2 must resolve.
2. The field `problemDetails?: ProblemDetails` in `EngineResult` (_base.ts) is **never populated** anywhere in production code — confirmed by exhaustive grep showing zero assignment sites.
3. `CleoError.toProblemDetails()` exists and is **fully implemented** (RFC 9457-compliant), but is **never called** in any dispatch-layer or engine catch block.
4. A parallel, well-used `ProblemDetails` system exists in `lafs/src/a2a/bindings/http.ts` for the A2A HTTP surface — it **is** called in production (`extensions.ts:513`).
5. Core's `EngineErrorPayload` (the canonical failure type used by all engines) does **not** include a `problemDetails` field — making activation a schema extension, not just call-site wiring.
6. The recommendation is **ACTIVATE** — the infrastructure is complete and tested; only the wiring between `CleoError` catch blocks and the `EngineResult` error shape is missing.

---

## 1. Where ProblemDetails Is Defined

### Definition 1 — `packages/core/src/errors.ts:20`

```typescript
// Source: /mnt/projects/cleocode/packages/core/src/errors.ts:20
export interface ProblemDetails {
  type: string;      // URN, e.g. "urn:cleo:error:4"
  title: string;     // exit code name, e.g. "NOT_FOUND"
  status: number;    // HTTP status, e.g. 404
  detail: string;    // human-readable message
  instance?: string; // optional URI identifying the specific occurrence
  extensions?: Record<string, unknown>; // CLEO-specific: code, lafsCode, category, recoverable, fix, alternatives, fieldDetails
}
```

Produced by: `CleoError.toProblemDetails()` at `errors.ts:155–173`

Full shape of `toProblemDetails()` output:
```typescript
{
  type: `urn:cleo:error:${this.code}`,           // e.g. "urn:cleo:error:4"
  title: getExitCodeName(this.code),              // e.g. "NOT_FOUND"
  status: def?.httpStatus ?? this.getHttpStatus(), // e.g. 404
  detail: this.message,                           // human-readable message
  instance: undefined,                            // not set by default
  extensions: {
    code: this.code,                              // numeric exit code
    lafsCode: exitCodeToLafsCode(this.code),      // e.g. "E_CLEO_NOT_FOUND"
    category: exitCodeToCategory(this.code),      // e.g. "NOT_FOUND"
    recoverable: isRecoverableCode(this.code),    // boolean
    // conditionally:
    fix: this.fix,
    alternatives: this.alternatives,
    fieldDetails: this.details,
  }
}
```

### Definition 2 — `packages/lafs/src/problemDetails.ts:29` (as `LafsProblemDetails`)

```typescript
// Source: /mnt/projects/cleocode/packages/lafs/src/problemDetails.ts:29
export interface LafsProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  retryable: boolean;           // LAFS-specific: mandatory
  agentAction?: string;         // recommended agent action
  retryAfterMs?: number;
  escalationRequired?: boolean;
  suggestedAction?: string;
  docUrl?: string;
  [key: string]: unknown;       // extension spread from LAFSError.details
}
```

Produced by: `lafsErrorToProblemDetails(error: LAFSError)` — converts a LAFS error envelope.  
Content-type: `PROBLEM_DETAILS_CONTENT_TYPE = 'application/problem+json'` (also defined here).

### Definition 3 — `packages/lafs/src/a2a/bindings/http.ts:111` (as `ProblemDetails`)

```typescript
// Source: /mnt/projects/cleocode/packages/lafs/src/a2a/bindings/http.ts:111
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  [key: string]: unknown; // no instance field, open-ended extensions
}
```

Produced by: `createProblemDetails(errorType, detail, extensions?)` and `createLafsProblemDetails(errorType, lafsError, requestId?)`.  
This **is actively used** in production: `extensions.ts:513` calls `error.toProblemDetails()` inside an Express error handler.

### Also Referenced In

- `packages/cleo/src/dispatch/types.ts:136` — `DispatchError.problemDetails?: import('@cleocode/core').ProblemDetails` (type declaration, not populated)
- `packages/cleo/src/dispatch/domains/_base.ts:31` — `EngineResult.error.problemDetails?: ProblemDetails` (type declaration, not populated)
- `packages/cleo/src/dispatch/domains/_base.ts:60` — conditional pass-through in `wrapResult()` (propagates if present, but nothing ever sets it)
- `packages/lafs/src/envelope.ts:562` — `CliEnvelopeError.problemDetails?: unknown` (type declaration)

---

## 2. Where ProblemDetails Is Referenced

Complete reference inventory (sorted by file):

| File | Line | Nature |
|------|------|--------|
| `packages/core/src/errors.ts` | 20, 155 | **Definition** (`ProblemDetails` interface + `toProblemDetails()` method) |
| `packages/core/src/index.ts` | 232 | Re-export: `export type { ProblemDetails }` |
| `packages/core/src/__tests__/error-catalog.test.ts` | 9, 97–139 | Test: fully exercises `toProblemDetails()` — all assertions pass |
| `packages/cleo/src/dispatch/types.ts` | 135–136 | Type declaration on `DispatchError` — **never populated** |
| `packages/cleo/src/dispatch/domains/_base.ts` | 12, 31, 60 | Import + type on `EngineResult` + conditional spread in `wrapResult` — **never populated** |
| `packages/lafs/src/problemDetails.ts` | 29, 79, 96–129 | **Definition** (`LafsProblemDetails` + `lafsErrorToProblemDetails()`) |
| `packages/lafs/src/index.ts` | 104–105 | Re-exports `LafsProblemDetails`, `lafsErrorToProblemDetails`, `PROBLEM_DETAILS_CONTENT_TYPE` |
| `packages/lafs/src/a2a/bindings/http.ts` | 111, 143, 183 | **Definition** (`ProblemDetails` for A2A HTTP + `createProblemDetails()` + `createLafsProblemDetails()`) |
| `packages/lafs/src/a2a/extensions.ts` | 412, 513 | **Active use**: `toProblemDetails()` method on `ExtensionSupportRequiredError`; called in Express error handler |
| `packages/lafs/src/envelope.ts` | 562 | Type declaration on `CliEnvelopeError` — **never populated** |
| `packages/lafs/tests/problemDetails.test.ts` | 2–113 | Test: exercises `lafsErrorToProblemDetails()` — all assertions pass |
| `packages/lafs/tests/bindings.test.ts` | 23, 251–266 | Test: exercises `createProblemDetails()` |
| `packages/lafs/tests/extensions.test.ts` | 251 | Test: exercises `ExtensionSupportRequiredError.toProblemDetails()` |

**Critical finding**: Zero production assignment of `problemDetails:` value anywhere in engine or domain handler code. The field exists in three type declarations but is never written.

---

## 3. RFC 7807 Alignment

RFC 7807 was **superseded by RFC 9457** (same shape, minor clarifications). The canonical Problem Details object per RFC 9457:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | URI string | Optional (default: `"about:blank"`) | Identifies the problem type |
| `title` | string | Optional | Short human-readable summary |
| `status` | number | Optional | HTTP status code |
| `detail` | string | Optional | Human-readable explanation for this occurrence |
| `instance` | URI string | Optional | Identifies the specific occurrence |
| (extensions) | any | Optional | Problem type may define additional members |

Content-type: `application/problem+json`

### Cleo Field Mapping

**`packages/core/src/errors.ts` `ProblemDetails` vs RFC 9457:**

| RFC 9457 Field | Cleo Field | Status |
|----------------|-----------|--------|
| `type` | `type` | Compliant — uses URN scheme `urn:cleo:error:<code>` (not a URL but valid URI) |
| `title` | `title` | Compliant — human-readable exit code name |
| `status` | `status` | Compliant — HTTP status mapped from exit code catalog |
| `detail` | `detail` | Compliant — the error message |
| `instance` | `instance?` | Compliant — optional, not always set |
| (extensions) | `extensions?` | Compliant — uses RFC 9457-blessed extension pattern |

**Extensions carried** (`extensions` object):
- `code`: numeric exit code — CLEO-specific, useful for agents
- `lafsCode`: string LAFS code (e.g. `E_CLEO_NOT_FOUND`) — agent-actionable
- `category`: LAFS category (e.g. `NOT_FOUND`, `VALIDATION`) — agent-actionable
- `recoverable`: boolean — agent-actionable (retry signal)
- `fix?`: copy-paste fix command — agent-actionable
- `alternatives?`: alternative commands — agent-actionable
- `fieldDetails?`: field-level validation details — agent-actionable

**Assessment**: Core's `ProblemDetails` is RFC 9457-compliant and goes **beyond the minimum** by surfacing CLEO-specific agent-actionable fields. The `LafsProblemDetails` variant in `packages/lafs` is also RFC 9457-compliant but targets the LAFS error transport rather than the dispatch envelope.

**Divergence note**: The A2A `ProblemDetails` in `http.ts` uses HTTPS URIs for `type` (per A2A spec), while core uses URN scheme. Both are valid URI references under RFC 9457.

---

## 4. Activation Analysis

If `problemDetails` were populated in the dispatch layer, consumers (agents, SDK users, HTTP clients) would gain a **self-describing, HTTP-status-aware error payload** that augments the existing `code`/`message`/`fix` triple. The current error envelope already carries `code`, `message`, `fix`, and `alternatives` — `ProblemDetails` would add `type` (URI), `status` (HTTP), `category`, and `recoverable`.

### Sample Error Site 1: Task Not Found (`E_NOT_FOUND`, exit code 4)

Current dispatch envelope error:
```json
{
  "code": "E_NOT_FOUND",
  "exitCode": 4,
  "message": "Task T999 not found",
  "fix": "cleo find T999"
}
```

With populated `problemDetails`:
```json
{
  "code": "E_NOT_FOUND",
  "exitCode": 4,
  "message": "Task T999 not found",
  "fix": "cleo find T999",
  "problemDetails": {
    "type": "urn:cleo:error:4",
    "title": "NOT_FOUND",
    "status": 404,
    "detail": "Task T999 not found",
    "extensions": {
      "code": 4,
      "lafsCode": "E_CLEO_NOT_FOUND",
      "category": "NOT_FOUND",
      "recoverable": false,
      "fix": "cleo find T999"
    }
  }
}
```

**Consumer gain**: HTTP proxy or SDK wrapper can map `status: 404` directly to HTTP response without custom exit-code-to-HTTP logic.

### Sample Error Site 2: Validation Error (`E_VALIDATION_ERROR`, exit code 6)

Current dispatch envelope error:
```json
{
  "code": "E_VALIDATION_ERROR",
  "exitCode": 6,
  "message": "Task title must be at most 200 characters",
  "details": { "field": "title", "expected": 200, "actual": 250 }
}
```

With populated `problemDetails`:
```json
{
  "code": "E_VALIDATION_ERROR",
  "exitCode": 6,
  "message": "Task title must be at most 200 characters",
  "details": { "field": "title", "expected": 200, "actual": 250 },
  "problemDetails": {
    "type": "urn:cleo:error:6",
    "title": "VALIDATION_ERROR",
    "status": 422,
    "detail": "Task title must be at most 200 characters",
    "extensions": {
      "code": 6,
      "lafsCode": "E_CLEO_VALIDATION_ERROR",
      "category": "VALIDATION",
      "recoverable": false,
      "fieldDetails": { "field": "title", "expected": 200, "actual": 250 }
    }
  }
}
```

**Consumer gain**: `status: 422` and `category: "VALIDATION"` provide semantic routing without parsing `code` strings. `fieldDetails` within extensions gives field-level recovery hints.

### Sample Error Site 3: Lifecycle Gate Failure (`E_LIFECYCLE_GATE_FAILED`, exit code 80)

Current dispatch envelope error:
```json
{
  "code": "E_LIFECYCLE_GATE_FAILED",
  "exitCode": 80,
  "message": "Parent epic not in implementation stage",
  "fix": "cleo lifecycle complete T1234",
  "alternatives": [{ "action": "advance parent", "command": "cleo lifecycle complete T1234" }]
}
```

With populated `problemDetails`:
```json
{
  "code": "E_LIFECYCLE_GATE_FAILED",
  "exitCode": 80,
  "message": "Parent epic not in implementation stage",
  "fix": "cleo lifecycle complete T1234",
  "alternatives": [{ "action": "advance parent", "command": "cleo lifecycle complete T1234" }],
  "problemDetails": {
    "type": "urn:cleo:error:80",
    "title": "LIFECYCLE_GATE_FAILED",
    "status": 422,
    "detail": "Parent epic not in implementation stage",
    "extensions": {
      "code": 80,
      "lafsCode": "E_CLEO_LIFECYCLE_GATE_FAILED",
      "category": "CONTRACT",
      "recoverable": false,
      "fix": "cleo lifecycle complete T1234",
      "alternatives": [{ "action": "advance parent", "command": "cleo lifecycle complete T1234" }]
    }
  }
}
```

**Consumer gain**: `category: "CONTRACT"` immediately signals to an orchestrator that the failure is a protocol precondition, not a data error — enabling different retry logic.

---

## 5. Recommendation: ACTIVATE

**Decision: ACTIVATE — keep the field, populate it at the dispatch layer for all `CleoError`-derived failures.**

### Rationale

1. **Infrastructure is complete.** `CleoError.toProblemDetails()` is fully implemented, RFC 9457-compliant, and tested (6 test cases in `error-catalog.test.ts`). The method produces high-quality output with agent-actionable fields. There is nothing to build — only wiring to add.

2. **The field already propagates if set.** `wrapResult()` in `_base.ts:60` already has the conditional spread `...(result.error.problemDetails ? { problemDetails: result.error.problemDetails } : {})`. The type is declared in `DispatchError` (types.ts:136) and `CliEnvelopeError` (envelope.ts:562). The channel exists end-to-end; it just carries nothing.

3. **`cleoErrorToEngineError()` is the canonical catch-block helper.** All dispatch engines use it (`dispatch/engines/_error.ts:318`). Adding one line — `problemDetails: err instanceof CleoError ? err.toProblemDetails() : undefined` — would activate the field for every engine that throws a `CleoError`. This is a 2–3 file change, not a broad migration.

4. **Consumers get a concrete benefit.** HTTP proxies, SDK wrappers, and orchestrators can route on `status` and `category` without custom exit-code-to-HTTP mapping tables. `recoverable` gives a direct retry signal. `lafsCode` is already the LAFS canonical identifier. None of this requires consumers to change their current error-reading code — `problemDetails` is additive and optional.

5. **`EngineErrorPayload` needs one new optional field.** The canonical failure type in `engine-result.ts` does not currently declare `problemDetails`. The ACTIVATE path requires adding `problemDetails?: ProblemDetails` to `EngineErrorPayload` and threading it through `engineError()` options. This is the migration point where core is extended, not the dispatch layer.

6. **Not deleting it is correct** (owner directive 4: "Do NOT remove functionality"). The field is intentional design that was never completed, not dead code. Deleting it would remove HTTP-status semantics from the error surface.

7. **Not migrating-up-as-is is correct** because the field already exists in dispatch types referencing `@cleocode/core`. "Migrate-up" would mean removing it from dispatch and adding it only to core — but it already lives in core's `ProblemDetails` type. The issue is not location, it is activation.

### What ACTIVATE Is Not

- It is **not** a breaking change — `problemDetails` is optional everywhere it appears.
- It is **not** large scope — the wiring is 2–3 files (engine-result.ts, _error.ts, possibly _base.ts).
- It does **not** require changes to existing error call sites in domain handlers.

---

## 6. W2 Implementation Impact

If the ACTIVATE recommendation is followed, these are the concrete changes required:

### File 1: `packages/core/src/engine-result.ts`

**Change**: Add `problemDetails?: ProblemDetails` to `EngineErrorPayload` and thread it through `engineError()`.

```typescript
// Add import
import type { ProblemDetails } from './errors.js';

// Extend EngineErrorPayload (line ~30)
export interface EngineErrorPayload {
  code: string;
  message: string;
  exitCode?: number;
  details?: unknown;
  fix?: string;
  alternatives?: Array<{ action: string; command: string }>;
  problemDetails?: ProblemDetails;  // ADD THIS
}

// Extend engineError() options (line ~88)
export function engineError<T = unknown>(
  code: string,
  message: string,
  options?: {
    exitCode?: number;
    details?: unknown;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
    problemDetails?: ProblemDetails;  // ADD THIS
  },
): EngineResult<T> {
  return {
    success: false,
    error: {
      code,
      message,
      // ... existing spreads ...
      ...(options?.problemDetails !== undefined ? { problemDetails: options.problemDetails } : {}),  // ADD THIS
    },
  };
}
```

### File 2: `packages/cleo/src/dispatch/engines/_error.ts`

**Change**: Import `CleoError` (or use structural typing already present) and add `problemDetails` to `cleoErrorToEngineError()` output.

The current `CaughtCleoErrorShape` interface does not expose `toProblemDetails()`. Options:
- Option A: Import `CleoError` from `@cleocode/core` and use `instanceof` check (resolves the circular-dep concern noted in the comment — core does not import from dispatch, so the dep is one-way and safe).
- Option B: Add `toProblemDetails?: () => ProblemDetails` to `CaughtCleoErrorShape`.

Recommended is Option A:

```typescript
// Add at top of file
import { CleoError } from '@cleocode/core';

// In cleoErrorToEngineError() — add to the final engineError call (line ~336)
return engineError<T>(code, message, {
  ...(e.fix !== undefined && { fix: e.fix }),
  ...(e.details !== undefined && { details: e.details }),
  ...(e.alternatives !== undefined && { alternatives: e.alternatives }),
  // ADD:
  ...(err instanceof CleoError && { problemDetails: err.toProblemDetails() }),
});
```

### File 3: `packages/cleo/src/dispatch/domains/_base.ts`

**No change required.** The `wrapResult()` function already has the conditional spread (line 60). Once `EngineErrorPayload` carries `problemDetails`, it will flow through automatically.

### File 4 (verify only): `packages/cleo/src/dispatch/types.ts`

**No change required.** `DispatchError.problemDetails?: import('@cleocode/core').ProblemDetails` (line 136) is already correct.

### File 5 (verify only): `packages/lafs/src/envelope.ts`

**Possible tightening.** `CliEnvelopeError.problemDetails?: unknown` (line 562) could be narrowed to `import('@cleocode/core').ProblemDetails` for type safety. Not blocking for W2 but is a quality improvement.

### Summary Table

| File | Change Type | Lines Affected | Required for ACTIVATE |
|------|-------------|----------------|----------------------|
| `packages/core/src/engine-result.ts` | Add field + option | ~5 lines | YES |
| `packages/cleo/src/dispatch/engines/_error.ts` | Add import + spread | ~3 lines | YES |
| `packages/cleo/src/dispatch/domains/_base.ts` | None (already wired) | 0 | NO |
| `packages/cleo/src/dispatch/types.ts` | None (already correct) | 0 | NO |
| `packages/lafs/src/envelope.ts` | Type tightening (optional) | ~1 line | NO |

Total implementation scope: **~8 lines across 2 files** — well within a single atomic task.

---

## Sources

- `packages/core/src/errors.ts` (absolute: `/mnt/projects/cleocode/packages/core/src/errors.ts`)
- `packages/core/src/engine-result.ts` (absolute: `/mnt/projects/cleocode/packages/core/src/engine-result.ts`)
- `packages/cleo/src/dispatch/types.ts` (absolute: `/mnt/projects/cleocode/packages/cleo/src/dispatch/types.ts`)
- `packages/cleo/src/dispatch/domains/_base.ts` (absolute: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/_base.ts`)
- `packages/cleo/src/dispatch/engines/_error.ts` (absolute: `/mnt/projects/cleocode/packages/cleo/src/dispatch/engines/_error.ts`)
- `packages/lafs/src/problemDetails.ts` (absolute: `/mnt/projects/cleocode/packages/lafs/src/problemDetails.ts`)
- `packages/lafs/src/a2a/bindings/http.ts` (absolute: `/mnt/projects/cleocode/packages/lafs/src/a2a/bindings/http.ts`)
- `packages/lafs/src/a2a/extensions.ts` (absolute: `/mnt/projects/cleocode/packages/lafs/src/a2a/extensions.ts`)
- `packages/lafs/src/envelope.ts` (absolute: `/mnt/projects/cleocode/packages/lafs/src/envelope.ts`)
- RFC 9457 (supersedes RFC 7807): https://www.rfc-editor.org/rfc/rfc7807

---

## Needs Follow-up

- W2 implementer should verify the `CleoError` import in `_error.ts` does not introduce a circular dependency (current code comment at line 274 claims it would — but core does not import from cleo dispatch, so the actual dep direction is safe: `cleo/dispatch -> core`).
- W2 implementer should decide whether to tighten `CliEnvelopeError.problemDetails?: unknown` to the concrete type.
- The three `ProblemDetails` interface definitions (core, lafs/problemDetails, lafs/a2a/bindings/http) represent technical duplication that should be tracked as a cleanup task separate from T1686/W2 — they serve different purposes (CLEO dispatch, LAFS transport, A2A HTTP binding) so consolidation requires care.
