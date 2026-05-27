# RFC: LAFS Error Response Optimization

**Status:** HISTORICAL (implemented, see code for current state)
**Author:** System Architect
**Date:** 2026-03-15
**Spec Version Impact:** v1.7.0 (additive), v2.0.0 (breaking changes deferred)

> **Note:** This RFC describes the design as proposed in March 2026. The implementation
> has since evolved. Notable post-RFC changes:
> - `src/mcpAdapter.ts` was removed when MCP support was eliminated.
> - `src/validateEnvelope.ts` now uses a native Rust validator (`lafs-napi`) with
>   AJV as a fallback. Schema is embedded at compile time, not loaded from disk.
> - See `PLAN-LAFS-RUST.md` for the napi-rs migration plan and current architecture.

---

## 1. Executive Summary

LAFS error envelopes currently waste approximately 74% of tokens on information that is either static, echo-backed, derivable from the error code, or structurally mandatory but semantically null. This RFC proposes a backward-compatible optimization path that extends MVI semantics to error and `_meta` payloads, introduces a transport-agnostic RFC 9457-inspired compact error format, and adds agent-actionable extension fields inspired by Cloudflare's structured error approach.

**Target:** Reduce error envelope token cost from ~162 tokens to ~28-42 tokens (74-83% reduction) at MVI `minimal`, while maintaining full backward compatibility at MVI `standard` and `full`.

---

## 2. Current State Analysis

### 2.1 Token Budget of a Current Error Envelope

Using the fixture at `fixtures/valid-error-envelope.json`:

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-11T00:00:00Z",
    "operation": "example.create",
    "requestId": "req_03",
    "transport": "cli",
    "strict": true,
    "mvi": "minimal",
    "contextVersion": 0
  },
  "success": false,
  "result": null,
  "error": {
    "code": "E_VALIDATION_SCHEMA",
    "message": "Input failed schema validation: 'title' is required",
    "category": "VALIDATION",
    "retryable": false,
    "retryAfterMs": null,
    "details": { "field": "title", "rule": "required" }
  }
}
```

**Token breakdown** (using 1 token ~ 4 chars heuristic from `src/tokenEstimator.ts`):

| Component | Chars | ~Tokens | Agent Needs It? |
|-----------|-------|---------|-----------------|
| `$schema` key + URL | 62 | 16 | NO - static constant, identical every response |
| `_meta.specVersion` | 24 | 6 | NO - agent sent this in the request |
| `_meta.schemaVersion` | 25 | 6 | NO - agent sent this in the request |
| `_meta.timestamp` | 38 | 10 | RARELY - only for logging |
| `_meta.operation` | 28 | 7 | NO - agent already knows what it called |
| `_meta.requestId` | 22 | 6 | YES - for correlation |
| `_meta.transport` | 18 | 5 | NO - agent knows its own transport |
| `_meta.strict` | 13 | 3 | NO - agent set this flag |
| `_meta.mvi` | 16 | 4 | NO - agent requested this level |
| `_meta.contextVersion` | 18 | 5 | YES - for state tracking |
| `"success": false` | 16 | 4 | YES - but derivable from error presence |
| `"result": null` | 14 | 4 | NO - mandated null, zero information |
| `error.code` | 30 | 8 | YES - primary signal |
| `error.message` (prose) | 58 | 15 | NO - LLM can reconstruct from code |
| `error.category` | 24 | 6 | NO - derivable from error code via registry |
| `error.retryable` | 17 | 4 | YES - but derivable from registry |
| `error.retryAfterMs` | 19 | 5 | YES when non-null, waste when null |
| `error.details` | 38 | 10 | YES - actionable context |
| JSON structural chars | ~80 | 20 | Overhead |
| **TOTAL** | **~560** | **~142** | |
| **Actionable tokens** | | **~38** | code + requestId + contextVersion + details |

**Waste ratio:** ~104 tokens wasted / ~142 total = **73% waste**

### 2.2 Waste Categories

| Category | Tokens Wasted | Root Cause |
|----------|---------------|------------|
| Echo-back of request params | ~29 | `_meta` echoes transport, strict, mvi, specVersion, schemaVersion, operation |
| Static constants | ~16 | `$schema` URL repeated in every response |
| Mandatory nulls | ~4 | `result: null` required on errors |
| Human prose in machine protocol | ~15 | `error.message` is narrative the LLM reconstructs |
| Derivable fields | ~10 | `category` and `retryable` derivable from error code + registry |
| Structural overhead of unused fields | ~20 | JSON keys for zero-information values |

### 2.3 Cross-Transport Redundancy

The same error concept (`E_VALIDATION_SCHEMA`) is currently expressed through:
- LAFS `error.code` + `error.category` + `error.message` + `error.retryable` (4 representations)
- HTTP: `ProblemDetails.type` + `ProblemDetails.title` + `ProblemDetails.status` + `ProblemDetails.detail` (4 representations)
- gRPC: `GrpcStatus.code` + `GrpcErrorInfo.reason` + `GrpcErrorInfo.domain` (3 representations)
- JSON-RPC: `JSONRPC_A2A_ERROR_CODES` numeric code + `error.message` (2 representations)
- Error Registry: `httpStatus` + `grpcStatus` + `cliExit` + `description` (4 representations)

**Total: ~17 representations of one error concept.** The agent receives the LAFS envelope plus transport-level error information, creating redundancy.

---

## 3. Design Principles

1. **MVI controls everything.** MVI levels MUST govern error and `_meta` verbosity, not just `result` payload. An agent requesting `minimal` should get minimal everything.

2. **Error codes are the canonical signal.** The error code plus the registry is a lookup table the agent already has. Do not repeat what the registry contains.

3. **Derivable = omittable.** If a field can be computed from the error code via the registry, it SHOULD be omitted at `minimal` MVI.

4. **RFC 9457 is a pattern, not an HTTP-only feature.** The Problem Details structure (type URI, machine-actionable extensions) should be available as a core protocol concept, not locked to the HTTP binding.

5. **Backward compatibility via additive schema evolution.** New compact formats are opt-in. The existing full envelope remains the default at MVI `standard`.

---

## 4. Proposed Architecture

### 4.1 MVI-Governed Error Verbosity (v1.7.0 -- additive)

Extend MVI semantics so they control `_meta` and `error` field inclusion. This is the highest-impact, lowest-risk change.

#### 4.1.1 MVI Error Field Matrix

| Field | `minimal` | `standard` | `full` |
|-------|-----------|------------|--------|
| `error.code` | REQUIRED | REQUIRED | REQUIRED |
| `error.details` | REQUIRED (when non-empty) | REQUIRED | REQUIRED |
| `error.message` | OMITTED | REQUIRED | REQUIRED |
| `error.category` | OMITTED (derivable) | REQUIRED | REQUIRED |
| `error.retryable` | OMITTED (derivable) | REQUIRED | REQUIRED |
| `error.retryAfterMs` | REQUIRED (when non-null) | REQUIRED | REQUIRED |

#### 4.1.2 MVI Meta Field Matrix

| Field | `minimal` | `standard` | `full` |
|-------|-----------|------------|--------|
| `_meta.requestId` | REQUIRED | REQUIRED | REQUIRED |
| `_meta.contextVersion` | REQUIRED | REQUIRED | REQUIRED |
| `_meta.timestamp` | OMITTED | REQUIRED | REQUIRED |
| `_meta.operation` | OMITTED (echo-back) | REQUIRED | REQUIRED |
| `_meta.transport` | OMITTED (echo-back) | OMITTED | REQUIRED |
| `_meta.strict` | OMITTED (echo-back) | OMITTED | REQUIRED |
| `_meta.mvi` | OMITTED (echo-back) | REQUIRED | REQUIRED |
| `_meta.specVersion` | OMITTED (echo-back) | OMITTED | REQUIRED |
| `_meta.schemaVersion` | OMITTED (echo-back) | OMITTED | REQUIRED |
| `_meta.sessionId` | REQUIRED (when present) | REQUIRED (when present) | REQUIRED (when present) |
| `_meta.warnings` | REQUIRED (when present) | REQUIRED (when present) | REQUIRED (when present) |

#### 4.1.3 Envelope Structural Field Matrix

| Field | `minimal` | `standard` | `full` |
|-------|-----------|------------|--------|
| `$schema` | OMITTED | REQUIRED | REQUIRED |
| `success` | REQUIRED | REQUIRED | REQUIRED |
| `result` | OMITTED when null | REQUIRED | REQUIRED |
| `error` | REQUIRED when error | REQUIRED | REQUIRED |
| `page` | OMITTED when null | OMITTED when null | REQUIRED |
| `_extensions` | REQUIRED (when present) | REQUIRED (when present) | REQUIRED (when present) |

#### 4.1.4 Token Impact

**Minimal error envelope AFTER this change:**

```json
{
  "success": false,
  "_meta": {
    "requestId": "req_03",
    "contextVersion": 0
  },
  "error": {
    "code": "E_VALIDATION_SCHEMA",
    "details": { "field": "title", "rule": "required" }
  }
}
```

| Component | Chars | ~Tokens |
|-----------|-------|---------|
| `success` | 16 | 4 |
| `_meta` (2 fields) | 42 | 11 |
| `error.code` | 30 | 8 |
| `error.details` | 38 | 10 |
| Structural JSON | 20 | 5 |
| **TOTAL** | **~146** | **~38** |

**Savings: ~104 tokens per error response (73% reduction)**

### 4.2 Agent-Actionable Error Extensions (v1.7.0 -- additive)

Inspired by Cloudflare's structured error extensions, add machine-actionable fields to `error.details` that map directly to agent control flow decisions.

#### 4.2.1 Standardized Action Fields

These fields are OPTIONAL within `error.details` but when present MUST conform to these types:

```typescript
/** Agent-actionable error detail fields (all optional) */
interface AgentActionableDetails {
  /** What the agent should do next */
  action?: ErrorAction;

  /** Specific field(s) that caused the error */
  field?: string;
  fields?: string[];

  /** Constraint that was violated */
  constraint?: string;

  /** Valid alternatives the agent can choose from */
  validOptions?: string[];

  /** Minimum wait before retry (seconds). Supersedes retryAfterMs for simplicity. */
  retryAfterSec?: number;

  /** Whether the owner/operator must intervene (not the agent) */
  ownerActionRequired?: boolean;

  /** Suggested corrective action in machine-parseable form */
  fix?: ErrorFix;

  /** Resource identifier that triggered the error */
  resourceId?: string;

  /** Current version vs required version for conflicts */
  currentVersion?: number;
  expectedVersion?: number;

  /** Rate limit context */
  limitRemaining?: number;
  limitResetAt?: string; // ISO 8601
}

/** What the agent should do */
type ErrorAction =
  | "retry"           // Retry the same request (possibly after delay)
  | "retry_modified"  // Retry with modified parameters
  | "abort"           // Stop this workflow branch
  | "escalate"        // Requires human/operator intervention
  | "refresh_context" // Fetch fresh context, then retry
  | "switch_version"  // Use a different protocol/schema version
  | "authenticate";   // Obtain/refresh credentials

/** Machine-parseable fix suggestion */
interface ErrorFix {
  /** Type of fix */
  type: "set_field" | "remove_field" | "change_value" | "add_header" | "wait";
  /** Target of the fix */
  target?: string;
  /** Suggested value */
  value?: unknown;
}
```

#### 4.2.2 Example: Enriched Error with Action Fields

At MVI `minimal`:
```json
{
  "success": false,
  "_meta": { "requestId": "req_03", "contextVersion": 0 },
  "error": {
    "code": "E_VALIDATION_SCHEMA",
    "details": {
      "field": "title",
      "constraint": "required",
      "action": "retry_modified",
      "fix": { "type": "set_field", "target": "title", "value": null }
    }
  }
}
```

At MVI `minimal` with rate limit:
```json
{
  "success": false,
  "_meta": { "requestId": "req_44", "contextVersion": 3 },
  "error": {
    "code": "E_RATE_LIMITED",
    "details": {
      "action": "retry",
      "retryAfterSec": 30,
      "limitRemaining": 0,
      "limitResetAt": "2026-03-15T12:05:00Z"
    }
  }
}
```

#### 4.2.3 Token Impact

Adding actionable fields costs 5-15 tokens but **eliminates the need for the agent to:**
1. Look up the error code in the registry (saves an extra tool call or context lookup)
2. Guess at the correct remediation (saves a reasoning cycle)
3. Parse prose `message` for embedded field names (eliminates regex/heuristic parsing)

Net impact: +10 tokens per error, but -1 LLM reasoning turn (typically 200-500 tokens of chain-of-thought). **Net savings: ~200-500 tokens per error handling cycle.**

### 4.3 Transport-Agnostic Problem Details (v1.7.0 -- additive)

Promote the RFC 9457 Problem Details pattern from the A2A HTTP binding to a core protocol feature available on all transports.

#### 4.3.1 Core Problem Type

```typescript
/**
 * Transport-agnostic Problem Details, inspired by RFC 9457.
 * Available on all transports via _extensions["x-lafs-problem"].
 */
interface LafsProblemDetails {
  /** Stable URI identifying the error type (from error registry) */
  type: string;

  /**
   * Instance URI identifying this specific occurrence.
   * Maps from _meta.requestId for correlation.
   */
  instance?: string;

  /** Agent-actionable extension members */
  action?: ErrorAction;
  retryAfterSec?: number;
  ownerActionRequired?: boolean;
}
```

#### 4.3.2 Error Type URI Registry

Extend `schemas/v1/error-registry.json` with a `typeUri` field for each error code:

```json
{
  "code": "E_VALIDATION_SCHEMA",
  "category": "VALIDATION",
  "description": "Input failed schema validation",
  "retryable": false,
  "httpStatus": 400,
  "grpcStatus": "INVALID_ARGUMENT",
  "cliExit": 2,
  "typeUri": "https://lafs.dev/errors/v1/validation-schema"
}
```

#### 4.3.3 Integration with Existing HTTP Binding

The existing `ProblemDetails` in `src/a2a/bindings/http.ts` maps A2A error types to HTTP Problem Details. The new core `LafsProblemDetails` is complementary:

- `ProblemDetails` (HTTP binding): Transport-specific, uses A2A error type URIs
- `LafsProblemDetails` (core protocol): Transport-agnostic, uses LAFS error type URIs, carried in `_extensions`

When both are present (HTTP transport), they do not conflict: the HTTP response uses `Content-Type: application/problem+json` with the A2A type URI, while the LAFS envelope's `_extensions["x-lafs-problem"]` carries the LAFS type URI. Agents can use either.

#### 4.3.4 Token Impact

Adding `x-lafs-problem` to `_extensions` costs ~15 tokens at `standard`/`full` MVI. At `minimal` MVI, the `action` field from Problem Details is already inlined into `error.details` (Section 4.2), so no extension is needed.

### 4.4 Compact Error Codec (v2.0.0 -- breaking, deferred)

For v2.0.0, introduce an alternative compact error representation that eliminates structural overhead entirely.

#### 4.4.1 Compact Wire Format

```typescript
/**
 * v2 compact error format.
 * Entire error response fits in ~20-30 tokens.
 */
interface LAFSCompactError {
  /** Version marker for format detection */
  _v: 2;

  /** Request correlation */
  rid: string;

  /** Context version for state tracking */
  cv: number;

  /** Error code (primary signal) */
  e: string;

  /** Action-oriented details (only non-null values) */
  d?: Record<string, unknown>;

  /** Retry delay in seconds (only when retryable) */
  r?: number;

  /** Action hint */
  a?: ErrorAction;
}
```

Example:
```json
{"_v":2,"rid":"req_03","cv":0,"e":"E_VALIDATION_SCHEMA","d":{"field":"title"},"a":"retry_modified"}
```

**Token cost: ~22 tokens.** This is an 85% reduction from the current 142 tokens.

#### 4.4.2 Negotiation

Compact format is negotiated via:
- HTTP: `Accept: application/vnd.lafs.compact+json`
- CLI: `--compact` flag or `LAFS_COMPACT=1` environment variable
- SDK: `{ format: "compact" }` option
- gRPC: `lafs-format: compact` metadata key

This is a v2.0.0 feature because it changes the top-level response shape (no longer an envelope with `$schema`, `_meta`, `success`, `result`, `error`).

---

## 5. Type Definitions for v1.7.0 Changes

### 5.1 Extended Types (`src/types.ts` additions)

```typescript
// --- MVI-governed field presence ---

/** Fields that are always present regardless of MVI level */
type MetaAlwaysPresent = 'requestId' | 'contextVersion';

/** Fields present at standard+ MVI */
type MetaStandardFields = MetaAlwaysPresent | 'timestamp' | 'operation' | 'mvi';

/** Fields present at full MVI only */
type MetaFullFields = MetaStandardFields | 'specVersion' | 'schemaVersion' | 'transport' | 'strict';

/** Minimal _meta: only correlation and state fields */
interface LAFSMetaMinimal {
  requestId: string;
  contextVersion: number;
  sessionId?: string;
  warnings?: Warning[];
  _tokenEstimate?: TokenEstimate;
}

/** Standard _meta: adds operational context */
interface LAFSMetaStandard extends LAFSMetaMinimal {
  timestamp: string;
  operation: string;
  mvi: MVILevel;
}

/** Full _meta: complete echo-back for debugging */
interface LAFSMetaFull extends LAFSMetaStandard {
  specVersion: string;
  schemaVersion: string;
  transport: LAFSTransport;
  strict: boolean;
}

// --- MVI-governed error fields ---

/** Minimal error: code + actionable details only */
interface LAFSErrorMinimal {
  code: string;
  details?: Record<string, unknown>;
  retryAfterMs?: number; // only when non-null
}

/** Standard error: adds human-readable context */
interface LAFSErrorStandard extends LAFSErrorMinimal {
  message: string;
  category: LAFSErrorCategory;
  retryable: boolean;
  retryAfterMs: number | null;
  details: Record<string, unknown>;
}

/** Full error: same as standard (no additional fields currently) */
type LAFSErrorFull = LAFSErrorStandard;

// --- Agent-actionable error details ---

type ErrorAction =
  | 'retry'
  | 'retry_modified'
  | 'abort'
  | 'escalate'
  | 'refresh_context'
  | 'switch_version'
  | 'authenticate';

interface ErrorFix {
  type: 'set_field' | 'remove_field' | 'change_value' | 'add_header' | 'wait';
  target?: string;
  value?: unknown;
}

interface AgentActionableDetails {
  action?: ErrorAction;
  field?: string;
  fields?: string[];
  constraint?: string;
  validOptions?: string[];
  retryAfterSec?: number;
  ownerActionRequired?: boolean;
  fix?: ErrorFix;
  resourceId?: string;
  currentVersion?: number;
  expectedVersion?: number;
  limitRemaining?: number;
  limitResetAt?: string;
}

// --- Problem Details (core, transport-agnostic) ---

interface LafsProblemDetails {
  type: string;
  instance?: string;
  action?: ErrorAction;
  retryAfterSec?: number;
  ownerActionRequired?: boolean;
}
```

### 5.2 MVI-Aware Envelope Projection (`src/mviProjection.ts` -- new file)

```typescript
/**
 * Project an envelope according to MVI level.
 * Strips fields that are omittable at the given MVI level.
 */
export function projectEnvelope(
  envelope: LAFSEnvelope,
  mviLevel: MVILevel
): Record<string, unknown> {
  switch (mviLevel) {
    case 'minimal':
      return projectMinimal(envelope);
    case 'standard':
      return projectStandard(envelope);
    case 'full':
      return envelope; // No stripping
    case 'custom':
      return envelope; // Custom uses _fields, not MVI projection
  }
}

function projectMinimal(env: LAFSEnvelope): Record<string, unknown> {
  const result: Record<string, unknown> = {
    success: env.success,
    _meta: {
      requestId: env._meta.requestId,
      contextVersion: env._meta.contextVersion,
      ...(env._meta.sessionId ? { sessionId: env._meta.sessionId } : {}),
      ...(env._meta.warnings?.length ? { warnings: env._meta.warnings } : {}),
    },
  };

  if (env.success) {
    result.result = env.result;
  } else if (env.error) {
    result.error = projectErrorMinimal(env.error);
  }

  if (env._extensions && Object.keys(env._extensions).length > 0) {
    result._extensions = env._extensions;
  }

  return result;
}

function projectErrorMinimal(error: LAFSError): Record<string, unknown> {
  const projected: Record<string, unknown> = { code: error.code };

  if (error.details && Object.keys(error.details).length > 0) {
    projected.details = error.details;
  }

  if (error.retryAfterMs !== null && error.retryAfterMs !== undefined) {
    projected.retryAfterMs = error.retryAfterMs;
  }

  return projected;
}

function projectStandard(env: LAFSEnvelope): Record<string, unknown> {
  const result: Record<string, unknown> = {
    $schema: env.$schema,
    success: env.success,
    _meta: {
      requestId: env._meta.requestId,
      contextVersion: env._meta.contextVersion,
      timestamp: env._meta.timestamp,
      operation: env._meta.operation,
      mvi: env._meta.mvi,
      ...(env._meta.sessionId ? { sessionId: env._meta.sessionId } : {}),
      ...(env._meta.warnings?.length ? { warnings: env._meta.warnings } : {}),
    },
  };

  if (env.success) {
    result.result = env.result;
  } else {
    result.result = null;
    if (env.error) {
      result.error = env.error; // Full error object at standard
    }
  }

  if (env.page && env.page.mode !== 'none') {
    result.page = env.page;
  }

  if (env._extensions && Object.keys(env._extensions).length > 0) {
    result._extensions = env._extensions;
  }

  return result;
}
```

### 5.3 Error Registry Extension (`schemas/v1/error-registry.json` additions)

Each error code entry gains a `typeUri` field and an optional `defaultAction` field:

```json
{
  "code": "E_VALIDATION_SCHEMA",
  "category": "VALIDATION",
  "description": "Input failed schema validation",
  "retryable": false,
  "httpStatus": 400,
  "grpcStatus": "INVALID_ARGUMENT",
  "cliExit": 2,
  "typeUri": "https://lafs.dev/errors/v1/validation-schema",
  "defaultAction": "retry_modified"
}
```

Full registry additions:

| Code | typeUri | defaultAction |
|------|---------|---------------|
| `E_FORMAT_CONFLICT` | `.../format-conflict` | `abort` |
| `E_VALIDATION_SCHEMA` | `.../validation-schema` | `retry_modified` |
| `E_NOT_FOUND_RESOURCE` | `.../not-found-resource` | `abort` |
| `E_CONFLICT_VERSION` | `.../conflict-version` | `refresh_context` |
| `E_RATE_LIMITED` | `.../rate-limited` | `retry` |
| `E_TRANSIENT_UPSTREAM` | `.../transient-upstream` | `retry` |
| `E_INTERNAL_UNEXPECTED` | `.../internal-unexpected` | `escalate` |
| `E_CONTEXT_MISSING` | `.../context-missing` | `retry_modified` |
| `E_CONTEXT_STALE` | `.../context-stale` | `refresh_context` |
| `E_MIGRATION_UNSUPPORTED_VERSION` | `.../migration-unsupported-version` | `switch_version` |
| `E_DISCLOSURE_UNKNOWN_FIELD` | `.../disclosure-unknown-field` | `retry_modified` |
| `E_MVI_BUDGET_EXCEEDED` | `.../mvi-budget-exceeded` | `retry_modified` |
| `E_FIELD_CONFLICT` | `.../field-conflict` | `abort` |

---

## 6. Migration Strategy

### 6.1 Phase 1: MVI Error Projection (v1.7.0)

**Risk: LOW.** Additive change. No existing behavior changes unless agent explicitly requests `minimal` MVI.

1. Add `projectEnvelope()` function in new `src/mviProjection.ts`
2. Update `createEnvelope()` in `src/envelope.ts` to optionally apply projection
3. Update `src/budgetEnforcement.ts` to project before estimating tokens
4. Add `typeUri` and `defaultAction` to `schemas/v1/error-registry.json`
5. Update `src/errorRegistry.ts` to expose new fields
6. Update spec section 9.1 in `lafs.md` to document MVI behavior for `_meta` and `error`
7. Add fixtures: `fixtures/valid-error-minimal.json`, `fixtures/valid-error-standard.json`
8. Update JSON Schema with conditional MVI-based required fields (using `if/then`)

**Backward compatibility:** Agents that do not set `mvi: "minimal"` see zero change. The `standard` projection is a strict superset of `minimal`. The `full` projection is the current behavior.

### 6.2 Phase 2: Agent-Actionable Details (v1.7.0)

**Risk: LOW.** These are optional fields within the existing `error.details` object, which already accepts `Record<string, unknown>`.

1. Add `AgentActionableDetails`, `ErrorAction`, `ErrorFix` types to `src/types.ts`
2. Add helper `enrichErrorDetails()` to `src/envelope.ts` that merges registry defaults with instance-specific details
3. Update `createBudgetExceededError()` in `src/budgetEnforcement.ts` to include `action: "retry_modified"`
4. Document standardized detail field names in spec section 7
5. Add conformance check: if `error.details.action` is present, it MUST be a valid `ErrorAction`

### 6.3 Phase 3: Core Problem Details (v1.7.0)

**Risk: LOW.** Uses existing `_extensions` mechanism.

1. Add `LafsProblemDetails` type to `src/types.ts`
2. Add `buildLafsProblemExtension()` helper
3. Update `createProblemDetails()` in `src/a2a/bindings/http.ts` to also populate `_extensions["x-lafs-problem"]`
4. Add `Content-Type: application/problem+json` guidance to spec section 7
5. Map `_meta.requestId` to Problem Details `instance` field

### 6.4 Phase 4: Schema Evolution (v1.7.0 schema update)

**Risk: MEDIUM.** Schema changes require careful conditional logic.

Update `schemas/v1/envelope.schema.json`:

1. Make `$schema` non-required (SHOULD be present, not MUST)
2. Make `result` non-required when `success: false` (already supported by `allOf` conditionals)
3. Add MVI-conditional required fields for `_meta` and `error`
4. Bump schema version to `1.7.0`

**Key constraint:** The schema MUST validate both old (full) envelopes and new (minimal) envelopes. This is achieved via `if/then` conditionals on the `_meta.mvi` value.

### 6.5 Phase 5: Compact Error Codec (v2.0.0, deferred)

**Risk: HIGH.** Breaking change to envelope shape.

1. Define `LAFSCompactError` type
2. Add format negotiation mechanism
3. New JSON Schema for compact format
4. Migration tooling: `compactToEnvelope()` and `envelopeToCompact()`
5. Update all transports with negotiation support

This is deferred to v2.0.0 because it changes the fundamental response contract.

---

## 7. Token Budget Analysis: Before and After

### 7.1 Error Envelope Comparison

| Scenario | Current | After v1.7.0 (minimal) | After v1.7.0 (standard) | v2.0.0 compact |
|----------|---------|------------------------|-------------------------|----------------|
| Validation error | ~142 tokens | ~38 tokens | ~120 tokens | ~22 tokens |
| Rate limit error | ~148 tokens | ~45 tokens | ~125 tokens | ~28 tokens |
| Not found error | ~135 tokens | ~30 tokens | ~115 tokens | ~18 tokens |
| Internal error | ~130 tokens | ~25 tokens | ~110 tokens | ~16 tokens |
| Context stale error | ~140 tokens | ~42 tokens | ~118 tokens | ~24 tokens |

### 7.2 Per-Change Token Savings

| Change | Tokens Saved (minimal) | Mechanism |
|--------|------------------------|-----------|
| Omit `$schema` | 16 | Static constant removal |
| Omit echo-back `_meta` fields | 29 | Remove specVersion, schemaVersion, transport, strict, operation, mvi |
| Omit `result: null` | 4 | Omit null structural fields |
| Omit `error.message` | 15 | Derivable from error code |
| Omit `error.category` | 6 | Derivable from error code via registry |
| Omit `error.retryable` | 4 | Derivable from error code via registry |
| Omit `error.retryAfterMs: null` | 5 | Only include when non-null |
| Add `error.details.action` | -3 | New field (cost) |
| Reduced structural overhead | 15 | Fewer keys = fewer JSON structural chars |
| **NET SAVINGS** | **~91 tokens** | **~64% reduction** |

### 7.3 Full Workflow Token Impact

Consider an agent workflow that encounters 5 errors before succeeding:

| Metric | Current | v1.7.0 minimal | Savings |
|--------|---------|----------------|---------|
| Error tokens (5 errors) | 710 | 200 | 510 tokens |
| Agent reasoning per error | ~300 tokens | ~100 tokens (with action hints) | 1000 tokens |
| Registry lookups | 5 tool calls (~500 tokens) | 0 (action inline) | 500 tokens |
| **Total workflow savings** | | | **~2010 tokens** |

---

## 8. Specific File Changes Required

### 8.1 Modified Files

| File | Changes | Phase |
|------|---------|-------|
| `src/types.ts` | Add `LAFSMetaMinimal`, `LAFSMetaStandard`, `LAFSErrorMinimal`, `ErrorAction`, `ErrorFix`, `AgentActionableDetails`, `LafsProblemDetails` types | 1-3 |
| `src/envelope.ts` | Add `projectEnvelope()` call in `createEnvelope()`, add `enrichErrorDetails()` helper | 1-2 |
| `src/errorRegistry.ts` | Expose `typeUri` and `defaultAction` from registry entries, add `getDefaultAction()` | 1-2 |
| `src/budgetEnforcement.ts` | Apply MVI projection before token estimation, add `action` to budget exceeded errors | 1-2 |
| `src/tokenEstimator.ts` | No changes needed (works on any JSON) | -- |
| `src/validateEnvelope.ts` | Update AJV schema to support conditional MVI-based validation | 4 |
| `src/a2a/bindings/http.ts` | Add `instance` field mapping, set `Content-Type: application/problem+json`, populate `x-lafs-problem` extension | 3 |
| `src/a2a/bindings/index.ts` | Export new problem details helpers | 3 |
| `schemas/v1/envelope.schema.json` | Add MVI-conditional required fields, make `$schema` optional, version bump to `1.7.0` | 4 |
| `schemas/v1/error-registry.json` | Add `typeUri` and `defaultAction` to each entry | 1 |
| `lafs.md` | Update sections 7 (Error Contract), 9 (MVI), add new section on agent-actionable errors | 1-3 |
| `src/index.ts` | Re-export new modules | 1 |
| `src/conformance.ts` | Add conformance checks for MVI projection correctness | 1 |

### 8.2 New Files

| File | Purpose | Phase |
|------|---------|-------|
| `src/mviProjection.ts` | MVI-aware envelope projection logic | 1 |
| `src/agentErrors.ts` | `enrichErrorDetails()`, `buildActionableError()`, `ErrorAction` constants | 2 |
| `src/problemDetails.ts` | Core `LafsProblemDetails` builder (transport-agnostic) | 3 |
| `fixtures/valid-error-minimal.json` | Minimal MVI error envelope fixture | 1 |
| `fixtures/valid-error-standard.json` | Standard MVI error envelope fixture (explicit) | 1 |
| `fixtures/valid-error-actionable.json` | Error with agent-actionable details | 2 |
| `tests/mviProjection.test.ts` | Projection correctness tests | 1 |
| `tests/agentErrors.test.ts` | Actionable error enrichment tests | 2 |
| `tests/problemDetails.test.ts` | Core problem details builder tests | 3 |

### 8.3 Files NOT Modified (and why)

| File | Reason |
|------|--------|
| `src/flagSemantics.ts` | Flag resolution is independent of error optimization |
| `src/fieldExtraction.ts` | Field extraction operates on `result`, not `error` |
| `src/a2a/bindings/grpc.ts` | gRPC binding types are unaffected; Problem Details is transport-agnostic |
| `src/a2a/bindings/jsonrpc.ts` | JSON-RPC error codes remain stable |
| `src/discovery.ts` | Agent Card is unrelated |
| `src/mcpAdapter.ts` | MCP adapter passes through envelopes; projection happens upstream |

---

## 9. Schema Evolution Plan

### 9.1 v1.7.0 (Additive, backward-compatible)

**Schema version:** `1.7.0`
**Spec version:** `1.7.0`

Changes to `envelope.schema.json`:
- `$schema` moves from `required` to optional (servers SHOULD include it)
- `_meta` gains MVI-conditional required fields via `if/then/else`:
  - If `_meta.mvi === "minimal"`: only `requestId` and `contextVersion` required
  - If `_meta.mvi === "standard"`: adds `timestamp`, `operation`, `mvi` required
  - Default (including `"full"`): all current fields required
- `error` gains MVI-conditional required fields:
  - If `_meta.mvi === "minimal"`: only `code` required
  - Default: all current fields required
- `result` conditional changes:
  - When `success: false` and `_meta.mvi === "minimal"`: `result` may be omitted entirely (not just null)
- New optional fields in error registry entries: `typeUri`, `defaultAction`
- `error.details` gains documented (but not schema-enforced) field name conventions for `action`, `fix`, `field`, etc.

**Validation behavior:**
- Old envelopes (full `_meta`, full `error`) pass validation unchanged
- New minimal envelopes also pass validation
- The schema version in `_meta.schemaVersion` indicates which features are available

### 9.2 v2.0.0 (Breaking, deferred)

**Changes requiring major version:**
1. Compact error codec (different top-level shape)
2. Removal of `error.message` as a required field at all MVI levels
3. Possible rename of `retryAfterMs` to `retryAfterSec` for consistency with Cloudflare pattern
4. `$schema` fully removed (replaced by `_v` version marker in compact format)

**Migration tooling requirements:**
- `v1ToV2Envelope()` converter
- `v2ToV1Envelope()` converter (for backward-compatible proxies)
- Schema coexistence: v2 responses MUST include `_v: 2` for format detection

---

## 10. Trade-Off Analysis

### 10.1 Decisions Made

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| MVI controls error verbosity | Yes | Separate `--error-verbosity` flag | MVI already exists as the verbosity knob; adding another creates flag proliferation |
| `error.message` omittable at minimal | Yes | Always required | LLM agents can reconstruct prose from error codes; tokens saved per error are significant |
| Action hints in `error.details` | Yes | Separate `_action` top-level field | `details` already accepts `Record<string, unknown>`; no schema change needed |
| Problem Details in `_extensions` | Yes | New top-level `_problem` field | Extensions are the designated extensibility point; avoids schema changes |
| Compact format deferred to v2 | Yes | Ship in v1.7 with negotiation | Changing envelope shape is a breaking change; v1.x must remain compatible |
| `retryAfterSec` in details (not `retryAfterMs`) | Yes | Keep milliseconds | Seconds align with HTTP `Retry-After` header and Cloudflare's pattern; more natural for agent reasoning |

### 10.2 Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Agents depend on `error.message` for parsing | MEDIUM | LOW | `message` is still present at `standard` (default MVI); `minimal` is opt-in |
| MVI-conditional schema is complex to validate | MEDIUM | MEDIUM | Thorough test fixtures; conformance suite covers all MVI x error combinations |
| `error.details` field names collide with user details | LOW | LOW | Standardized names use common terms (`action`, `field`); collisions are semantically coherent |
| v2 compact format adoption is slow | LOW | LOW | v1.7 minimal already achieves 73% reduction; compact is incremental |

---

## 11. Conformance Test Plan

New conformance checks for v1.7.0:

1. **MVI minimal error**: Envelope with `mvi: "minimal"` MUST validate with only `code` in error
2. **MVI minimal meta**: Envelope with `mvi: "minimal"` MUST validate with only `requestId` + `contextVersion` in `_meta`
3. **MVI standard error**: Envelope with `mvi: "standard"` MUST include all current error fields
4. **MVI full**: Envelope with `mvi: "full"` MUST include all fields including echo-backs
5. **Action field validation**: If `error.details.action` is present, it MUST be a valid `ErrorAction` string
6. **Fix field validation**: If `error.details.fix` is present, it MUST have a `type` field
7. **Problem Details extension**: If `_extensions["x-lafs-problem"]` is present, it MUST have a `type` URI
8. **Projection idempotence**: `projectEnvelope(projectEnvelope(env, level), level)` MUST equal `projectEnvelope(env, level)`
9. **Registry completeness**: Every error code in the registry MUST have a `typeUri` and `defaultAction`
10. **Backward compatibility**: All existing fixtures MUST continue to validate against the updated schema

---

## 12. Implementation Priority

| Priority | Change | Impact | Effort |
|----------|--------|--------|--------|
| P0 | MVI error/meta projection | 73% token reduction | MEDIUM |
| P1 | Agent-actionable detail fields | Eliminates reasoning cycles | SMALL |
| P1 | Error registry `typeUri` + `defaultAction` | Foundation for Problem Details | SMALL |
| P2 | Core Problem Details in `_extensions` | Cross-transport consistency | SMALL |
| P2 | Schema conditional updates | Formal validation support | MEDIUM |
| P3 | Compact error codec (v2) | Additional 10% reduction | LARGE |

**Recommended implementation order:** P0 and P1 in a single release (v1.7.0), P2 follows in same or next minor, P3 deferred to v2.0.0 planning cycle.
