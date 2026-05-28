# LAFS Envelope Contract

Status: Accepted for CLEO envelope-first doctrine
Owner: T11113 / T10346
Last updated: 2026-05-28

## Goal

Define the human-readable contract for the LAFS envelope so CLEO producers,
consumers, CLIs, SDKs, HTTP/gRPC adapters, and future cockpit/daemon IPC agree
on one canonical response boundary.

## Non-Goals

- This document does not define operation-specific `result` payload schemas.
- This document does not replace the machine-readable JSON Schema or error
  registry; it explains how humans and agents should interpret them.
- This document does not define authorization policy. MVI controls disclosure
  after authorization has already succeeded.

## Requirements

- Every CLEO-facing producer MUST emit the top-level envelope shape documented
  here when an envelope is available.
- Producers MUST preserve success/result/error invariants.
- Producers MUST use registered error categories/codes and transport mappings.
- Consumers MUST branch on `success` and treat transport-specific status codes as
  secondary mapping signals.
- Extensions MUST live under `_extensions`, not ad hoc top-level fields.

## Out-of-Scope

- Concrete schemas for each `operation` result body.
- Wire-level framing for individual transports beyond status-code conventions.
- UI rendering rules for human table/prose output.

## 1. Purpose

The LAFS envelope is the canonical CLEO boundary. Every CLEO-facing operation
returns or transports the same envelope shape regardless of implementation
language, process boundary, or transport. Rust, TypeScript, CLI, HTTP, gRPC,
SDK calls, and future cockpit/daemon IPC are implementation details; the
contract between producers and consumers is the envelope.

The envelope gives agents and tools a stable response grammar:

- one place for protocol metadata and tracing (`_meta`),
- one success discriminator (`success`),
- one result slot (`result`),
- one structured error slot (`error`),
- one pagination slot (`page`), and
- one extension slot (`_extensions`) for namespaced vendor data.

Consumers MUST parse the envelope first, then interpret the transport-specific
status code as advisory. Transport failures can prevent an envelope from being
received, but when an envelope is present it is the source of truth.

## 2. JSON structure

Canonical top-level shape:

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-05-28T05:00:00.000Z",
    "operation": "tasks.show",
    "requestId": "req_123",
    "transport": "cli",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 1,
    "sessionId": "ses_abc"
  },
  "success": true,
  "result": {},
  "error": null,
  "page": { "mode": "none" },
  "_extensions": {}
}
```

Field-by-field contract:

| Field | Required | Meaning |
|---|---:|---|
| `$schema` | yes | JSON Schema URL for this envelope family: `https://lafs.dev/schemas/v1/envelope.schema.json`. |
| `_meta` | yes | Protocol metadata, versioning, correlation, transport, strictness, and MVI controls. |
| `success` | yes | Boolean discriminator. `true` means the operation completed; `false` means the operation failed in a structured way. |
| `result` | yes | Operation payload. Usually object/array on success and `null` on failure. Validation-style operations MAY include actionable result data even when `success=false`. |
| `error` | conditional | Structured error object on failure. It MUST be absent or `null` on success and MUST be present/non-null on failure. |
| `page` | optional | Pagination metadata for collection results. Omit when irrelevant; use `{ "mode": "none" }` only when an explicit no-pagination marker is useful. |
| `_extensions` | optional | Namespaced extension data. Omit when empty. |

Strict producers SHOULD omit optional empty fields instead of serializing them as
`null`. In strict mode, explicit `null` for optional fields such as `page`, or
`error` on successful envelopes, is non-canonical even if a lenient consumer can
recover.

## 3. `_meta` sub-fields

| `_meta` field | Required | Type | Meaning |
|---|---:|---|---|
| `specVersion` | yes | semver string | Version of the LAFS protocol specification stamped by the producer. Current default: `1.0.0`. |
| `schemaVersion` | yes | semver string | Version of the JSON Schema used to validate the envelope. Current default: `1.0.0`. |
| `timestamp` | yes | ISO 8601 string | Time the envelope was created. |
| `operation` | yes | string | Dot-delimited operation identifier, for example `tasks.list`, `docs.fetch`, or `session.briefing.show`. |
| `requestId` | yes | string | Unique correlation id for the request/response pair. Consumers should include it in bug reports and logs. |
| `transport` | yes | `cli` \| `http` \| `grpc` \| `sdk` | Transport used to deliver the envelope. This controls status-code mapping expectations only; the envelope shape stays identical. |
| `strict` | yes | boolean | When `true`, producers promise strict schema behavior and consumers may reject unknown/extra properties. |
| `mvi` | yes | `minimal` \| `standard` \| `full` \| `custom` | Minimum Viable Information level controlling how much data is disclosed. |
| `contextVersion` | yes | number | Monotonically increasing context-ledger version known to the producer/consumer. `0` means no prior context identity. |
| `sessionId` | optional | string | Session processing the request, used for multi-step workflow correlation. |
| `originSessionId` | optional | string | Root session that initiated a delegated or replayed workflow. |
| `executionSessionId` | optional | string | Specific execution attempt carrying this envelope. |
| `warnings` | optional | array | Non-fatal notices such as deprecations, fallback behavior, or soft policy warnings. |

`operation` plus `requestId` is the minimum correlation pair. `sessionId`,
`originSessionId`, and `executionSessionId` provide cross-session traceability
for orchestrated work.

## 4. Success, result, and error invariants

Producers MUST maintain these invariants:

1. `success=true` means the operation completed successfully.
2. `success=true` envelopes MUST NOT carry a non-null `error`.
3. `success=false` envelopes MUST carry a non-null structured `error` object.
4. `result` MUST always be present. On ordinary failures it is `null`.
5. `result` MAY be non-null on `success=false` only when the payload is
   actionable failure data, such as lint findings, validation diagnostics, or
   suggested fixes.
6. Consumers MUST branch on `success`, not on transport status alone.
7. Consumers SHOULD preserve `_meta.requestId` and `_meta.operation` when
   reporting or escalating failures.

Structured error shape:

| Error field | Required | Meaning |
|---|---:|---|
| `code` | yes | Stable machine-readable error code such as `E_NOT_FOUND_RESOURCE`. |
| `message` | yes | Human-readable error explanation. |
| `category` | yes | Broad semantic category from the registry. |
| `retryable` | yes | Whether retrying the same request can succeed. |
| `retryAfterMs` | yes | Suggested retry delay in milliseconds, or `null`. |
| `details` | yes | JSON object with additional machine-readable context. |
| `agentAction` | optional | Recommended next action: `retry`, `retry_modified`, `escalate`, `stop`, `wait`, `refresh_context`, or `authenticate`. |
| `escalationRequired` | optional | Explicit human/higher-privilege intervention signal. |
| `suggestedAction` | optional | Free-text recovery advice. |
| `docUrl` | optional | Human-readable documentation URL for the error code. |

## 5. Error categories and semantics

Canonical categories are defined by the LAFS error registry and type surface.
Categories drive telemetry grouping and default agent behavior.

| Category | Semantics | Default agent action |
|---|---|---|
| `VALIDATION` | Input failed schema, field, budget, or request validation. | `retry_modified` |
| `AUTH` | Missing, expired, or invalid authentication material. | `authenticate` |
| `PERMISSION` | Authenticated principal lacks permission. | `escalate` |
| `NOT_FOUND` | Referenced resource does not exist or is not visible. | `stop` |
| `CONFLICT` | Version, stale context, or concurrency conflict. | `retry_modified` or registry-specific `refresh_context` |
| `RATE_LIMIT` | Producer or upstream throttled the request. | `wait` |
| `TRANSIENT` | Temporary dependency or infrastructure failure. | `retry` |
| `INTERNAL` | Unexpected producer failure. | `escalate` |
| `CONTRACT` | Caller and producer disagreed on protocol/flags/context requirements. | `retry_modified` or registry-specific `stop` |
| `MIGRATION` | Requested protocol or schema version is unsupported. | `stop` |

Registered error codes include transport mappings. Example mappings from the v1
registry:

| Error code | Category | HTTP | gRPC | CLI | Agent action |
|---|---|---:|---|---:|---|
| `E_FORMAT_CONFLICT` | `CONTRACT` | 400 | `INVALID_ARGUMENT` | 2 | `stop` |
| `E_VALIDATION_SCHEMA` | `VALIDATION` | 400 | `INVALID_ARGUMENT` | 2 | `retry_modified` |
| `E_NOT_FOUND_RESOURCE` | `NOT_FOUND` | 404 | `NOT_FOUND` | 4 | `stop` |
| `E_CONFLICT_VERSION` | `CONFLICT` | 409 | `ABORTED` | 7 | `refresh_context` |
| `E_RATE_LIMITED` | `RATE_LIMIT` | 429 | `RESOURCE_EXHAUSTED` | 8 | `wait` |
| `E_TRANSIENT_UPSTREAM` | `TRANSIENT` | 503 | `UNAVAILABLE` | 9 | `retry` |
| `E_INTERNAL_UNEXPECTED` | `INTERNAL` | 500 | `INTERNAL` | 1 | `escalate` |
| `E_CONTEXT_MISSING` | `CONTRACT` | 400 | `FAILED_PRECONDITION` | 6 | `retry_modified` |
| `E_CONTEXT_STALE` | `CONFLICT` | 409 | `ABORTED` | 7 | `refresh_context` |
| `E_MIGRATION_UNSUPPORTED_VERSION` | `MIGRATION` | 426 | `FAILED_PRECONDITION` | 10 | `stop` |
| `E_DISCLOSURE_UNKNOWN_FIELD` | `VALIDATION` | 400 | `INVALID_ARGUMENT` | 2 | `retry_modified` |
| `E_MVI_BUDGET_EXCEEDED` | `VALIDATION` | 413 | `RESOURCE_EXHAUSTED` | 2 | `retry_modified` |
| `E_FIELD_CONFLICT` | `CONTRACT` | 400 | `INVALID_ARGUMENT` | 2 | `stop` |

## 6. Pagination modes

`page` is a discriminated union. Producers MUST use one of these modes when
pagination metadata is present.

### `cursor`

Use cursor pagination for large or changing datasets.

```json
{
  "mode": "cursor",
  "nextCursor": "opaque-token-or-null",
  "hasMore": true,
  "limit": 50,
  "total": null
}
```

- `nextCursor` is opaque. Consumers MUST pass it back verbatim.
- `hasMore` states whether another page exists.
- `limit` and `total` are optional; `total` may be `null` when unknown.

### `offset`

Use offset pagination for stable, index-addressable datasets.

```json
{
  "mode": "offset",
  "limit": 50,
  "offset": 0,
  "hasMore": true,
  "total": 137
}
```

- `offset` is zero-based.
- Offset pagination is direct but may drift if records are inserted or deleted
  between reads.

### `none`

Use `none` when a producer intentionally wants to state that no pagination is
applied.

```json
{ "mode": "none" }
```

When no pagination signal is needed, omit `page` entirely.

## 7. `_extensions` for vendor data

`_extensions` is the only top-level escape hatch. It prevents the envelope core
from accumulating one-off fields while preserving forward-compatible structured
data.

Rules:

1. Extension keys SHOULD be namespaced, for example `lafs`, `context`,
   `x-trace-id`, `x-vendor-name`, or `com.example.feature`.
2. Extension values MUST be JSON-serializable.
3. Producers MUST NOT put core envelope substitutes in `_extensions`; use core
   fields for success, error, pagination, metadata, and result payloads.
4. Consumers MUST ignore unknown extension keys unless they explicitly opted into
   that extension.
5. Empty `_extensions` objects SHOULD be omitted.

Example:

```json
{
  "_extensions": {
    "x-trace-id": "trace_abc123",
    "lafs": { "contextRequired": true }
  }
}
```

## 8. MVI levels and disclosure

MVI means Minimum Viable Information. It lets producers return enough structure
for agents to act without oversharing large payloads or sensitive context.

| Level | Disclosure contract |
|---|---|
| `minimal` | Essential routing and action fields only. Keeps `success`, `error.code`, important `error.details` when non-empty, `_meta.requestId`, and `_meta.contextVersion`; strips echo-back metadata and bulky payloads where safe. |
| `standard` | Default operational view. Includes all required envelope fields and normal result/error/page data, while still avoiding unnecessary debug/bulk fields. |
| `full` | Diagnostic view. Includes optional metadata, warnings, extensions, and full available payloads suitable for debugging or audit. |
| `custom` | Caller-defined subset. Requires explicit field selection such as field flags or projection rules. |

MVI is not an authorization mechanism. Producers MUST still apply normal access
control before building the envelope. MVI only controls how much already-
authorized data is serialized.

## 9. Transport-specific conventions

The envelope shape is transport-independent. Transport status codes are mapped
from the structured error registry so conventional clients can interoperate.

### CLI

- Success SHOULD exit `0`.
- Failure SHOULD exit with the registry `cliExit` for the error code.
- CLI output intended for agents SHOULD be the JSON envelope.
- Human renderers MAY display tables or prose, but machine-readable modes MUST
  preserve the envelope.

### HTTP

- Success SHOULD use the appropriate 2xx HTTP status and include the envelope as
  the response body.
- Failure SHOULD use the registry `httpStatus` and include the same structured
  envelope body.
- Problem Details adapters MAY derive RFC 9457 fields from `error.code`,
  `error.message`, `error.details`, and registry `typeUri`, but MUST NOT replace
  the envelope for CLEO-facing clients.

### gRPC

- Failure SHOULD map to the registry `grpcStatus`.
- The envelope SHOULD be carried in a response payload, trailing metadata, or an
  agreed error-details message depending on binding constraints.

### SDK

- SDK transport has no external status code. Callers receive the envelope or a
  typed exception derived from the envelope.
- The conformance checker skips external status-code mapping for `sdk`.

## 10. Examples

### Success envelope

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-05-28T05:00:00.000Z",
    "operation": "tasks.show",
    "requestId": "req_success_001",
    "transport": "cli",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 12,
    "sessionId": "ses_20260528_example"
  },
  "success": true,
  "result": {
    "task": {
      "id": "T11113",
      "title": "Publish human-readable envelope contract documentation",
      "status": "done"
    }
  }
}
```

### Error envelope

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-05-28T05:00:00.000Z",
    "operation": "docs.fetch",
    "requestId": "req_error_001",
    "transport": "cli",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 12,
    "sessionId": "ses_20260528_example"
  },
  "success": false,
  "result": null,
  "error": {
    "code": "E_NOT_FOUND_RESOURCE",
    "message": "Attachment not found: lafs-envelope-contract",
    "category": "NOT_FOUND",
    "retryable": false,
    "retryAfterMs": null,
    "details": { "slug": "lafs-envelope-contract" },
    "agentAction": "stop",
    "docUrl": "https://lafs.dev/docs/errors/not-found-resource"
  }
}
```

### Paginated envelope

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-05-28T05:00:00.000Z",
    "operation": "tasks.list",
    "requestId": "req_page_001",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 12,
    "sessionId": "ses_20260528_example"
  },
  "success": true,
  "result": [
    { "id": "T11109", "title": "Unify CLI meta shape" },
    { "id": "T11113", "title": "Publish human-readable envelope contract documentation" }
  ],
  "page": {
    "mode": "cursor",
    "nextCursor": "eyJvZmZzZXQiOjJ9",
    "hasMore": true,
    "limit": 2,
    "total": null
  },
  "_extensions": {
    "x-trace-id": "trace_page_001"
  }
}
```

## 11. Consumer checklist

- Parse JSON into the envelope shape before reading operation-specific data.
- Branch on `success`.
- If `success=false`, inspect `error.code`, `category`, `retryable`,
  `retryAfterMs`, and `agentAction` before deciding to retry or escalate.
- Preserve `_meta.requestId`, `_meta.operation`, and session ids in logs.
- Respect `page.mode` when requesting additional data.
- Ignore unknown `_extensions` keys.
- Use MVI intentionally: default to `standard`, request `minimal` for high-volume
  agent loops, and reserve `full` for debugging/audit.

## 12. Producer checklist

- Populate `_meta` for every envelope.
- Keep `success`, `result`, and `error` invariants intact.
- Use registered error codes and transport mappings.
- Omit empty optional fields in strict mode.
- Put vendor data under `_extensions`, not new top-level fields.
- Return the same envelope semantics across CLI, HTTP, gRPC, and SDK surfaces.
