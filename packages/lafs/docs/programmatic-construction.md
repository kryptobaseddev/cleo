# Programmatic Construction

This guide shows how to construct LAFS protocol-compliant messages from scratch using the TypeScript SDK, with the versioned JSON schemas driving type safety and field constraints.

## How the schema drives construction

Every LAFS message is validated against `schemas/v1/envelope.schema.json` (JSON Schema Draft-07). The TypeScript types in `src/types.ts` are derived from the same schema, so the compiler and the runtime validator enforce the same rules.

```typescript
// Import the canonical schema for direct use with your own validator
import envelopeSchema from "@cleocode/lafs/schemas/v1/envelope.schema.json";

// Import the TypeScript types generated from that schema
import type { LAFSEnvelope, LAFSMeta, LAFSError, LAFSPage } from "@cleocode/lafs";
```

The schema enforces:
- `$schema` must be the exact URI `"https://lafs.dev/schemas/v1/envelope.schema.json"`
- `_meta`, `success`, and `result` are required top-level fields
- `success: true` implies `error` must be `null`; `success: false` requires a non-null `error` and `result: null`
- `_meta.operation` is 1–128 characters; `_meta.requestId` is 3–128 characters
- `_meta.transport` is one of `"cli" | "http" | "grpc" | "sdk"`
- Error codes must match the pattern `^E_[A-Z0-9]+_[A-Z0-9_]+$`
- When `_meta.strict` is `true`, no additional top-level properties are allowed

## The `createEnvelope` factory

`createEnvelope` is the primary construction API. It builds a schema-ready envelope and fills in protocol defaults so you only supply what varies per call.

```typescript
import { createEnvelope } from "@cleocode/lafs";
import type { CreateEnvelopeInput } from "@cleocode/lafs";
```

The input is a discriminated union on `success`:

```typescript
// success: true path
interface CreateEnvelopeSuccessInput {
  success: true;
  result: Record<string, unknown> | Record<string, unknown>[];
  page?: LAFSPage | null;
  error?: null;
  _extensions?: Record<string, unknown>;
  meta: CreateEnvelopeMetaInput;
}

// success: false path
interface CreateEnvelopeErrorInput {
  success: false;
  error: { code: string; message: string; category?: string; retryable?: boolean; retryAfterMs?: number | null; details?: Record<string, unknown> };
  result?: null;
  page?: LAFSPage | null;
  _extensions?: Record<string, unknown>;
  meta: CreateEnvelopeMetaInput;
}
```

### Meta defaults

The factory applies these defaults when fields are omitted from `meta`:

| Field | Default | Schema constraint |
|---|---|---|
| `$schema` | `"https://lafs.dev/schemas/v1/envelope.schema.json"` | exact const |
| `specVersion` | `"1.0.0"` | semver pattern `^\d+\.\d+\.\d+$` |
| `schemaVersion` | `"1.0.0"` | semver pattern `^\d+\.\d+\.\d+$` |
| `timestamp` | `new Date().toISOString()` | ISO 8601 date-time |
| `transport` | `"sdk"` | enum: cli, http, grpc, sdk |
| `strict` | `true` | boolean |
| `mvi` | `"standard"` | enum: minimal, standard, full, custom |
| `contextVersion` | `0` | integer ≥ 0 |

## Constructing a success message

Provide the operation name, a request identifier, and the result payload:

```typescript
import { createEnvelope } from "@cleocode/lafs";

const envelope = createEnvelope({
  success: true,
  result: {
    user: {
      id: "usr_01HXYZ",
      email: "alice@example.com",
      role: "admin",
    },
  },
  meta: {
    operation: "users.get",    // 1–128 chars, dot-namespaced by convention
    requestId: "req_01HXYZ",   // 3–128 chars, unique per request
    transport: "http",
    strict: true,
  },
});
```

The resulting envelope satisfies the `LAFSEnvelope` type and passes schema validation:

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-01-15T10:30:00.000Z",
    "operation": "users.get",
    "requestId": "req_01HXYZ",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 0
  },
  "success": true,
  "result": {
    "user": { "id": "usr_01HXYZ", "email": "alice@example.com", "role": "admin" }
  }
}
```

## Constructing an error message

Error envelopes require `success: false`, `result: null`, and a fully populated `error` object. The factory normalizes defaults for optional error fields:

```typescript
import { createEnvelope, isRegisteredErrorCode } from "@cleocode/lafs";

const envelope = createEnvelope({
  success: false,
  error: {
    code: "E_NOT_FOUND_RESOURCE",     // Must match ^E_[A-Z0-9]+_[A-Z0-9_]+$
    message: "User usr_01HXYZ not found",
    category: "NOT_FOUND",            // One of 10 defined categories
    retryable: false,
    retryAfterMs: null,               // ms to wait before retry; null when non-retryable
    details: { userId: "usr_01HXYZ" },
  },
  meta: {
    operation: "users.get",
    requestId: "req_01HXYZ",
    transport: "http",
  },
});
```

Error fields and their schema constraints:

| Field | Type | Constraint | Default (from factory) |
|---|---|---|---|
| `code` | string | `^E_[A-Z0-9]+_[A-Z0-9_]+$` | required |
| `message` | string | 1–1024 chars | required |
| `category` | string | enum of 10 values | `"INTERNAL"` |
| `retryable` | boolean | — | `false` |
| `retryAfterMs` | integer \| null | ≥ 0 when set | `null` |
| `details` | object | — | `{}` |

### Error categories

Use the appropriate category so consumers can route errors correctly:

| Category | Meaning | Retryable |
|---|---|---|
| `VALIDATION` | Input failed schema or business rule | no |
| `AUTH` | Missing or invalid credentials | no |
| `PERMISSION` | Authenticated but not authorized | no |
| `NOT_FOUND` | Resource does not exist | no |
| `CONFLICT` | Version or concurrency conflict | yes |
| `RATE_LIMIT` | Too many requests | yes |
| `TRANSIENT` | Upstream dependency temporarily unavailable | yes |
| `INTERNAL` | Unexpected server-side failure | no |
| `CONTRACT` | Protocol violation (e.g., format conflict) | no |
| `MIGRATION` | Schema or data migration in progress | yes |

### Registered vs custom error codes

Use registered codes when your error maps to a standard case. Registered codes carry cross-transport status code mappings (HTTP, gRPC, CLI exit):

```typescript
import { isRegisteredErrorCode, getErrorRegistry } from "@cleocode/lafs";

// Check before constructing
if (!isRegisteredErrorCode("E_NOT_FOUND_RESOURCE")) {
  throw new Error("Unknown error code");
}

// Browse all registered codes with their transport mappings
const registry = getErrorRegistry();
for (const entry of registry.codes) {
  console.log(entry.code, entry.httpStatus, entry.grpcStatus, entry.cliExit);
}
```

Custom codes are allowed. They must still match the pattern `E_[A-Z0-9]+_[A-Z0-9_]+`:

```typescript
const envelope = createEnvelope({
  success: false,
  error: {
    code: "E_BILLING_SUBSCRIPTION_EXPIRED",  // custom, domain-scoped
    message: "Subscription has expired",
    category: "PERMISSION",
    retryable: false,
    retryAfterMs: null,
    details: { expiredAt: "2026-01-01T00:00:00Z" },
  },
  meta: { operation: "billing.check", requestId: "req_abc" },
});
```

## Constructing paginated results

For list operations, include a `page` field describing the pagination state.

### Cursor-based pagination

```typescript
const envelope = createEnvelope({
  success: true,
  result: {
    users: [
      { id: "usr_01", email: "alice@example.com" },
      { id: "usr_02", email: "bob@example.com" },
    ],
  },
  page: {
    mode: "cursor",
    nextCursor: "eyJpZCI6InVzcl8wMiJ9",  // null when no more pages
    hasMore: true,
    limit: 20,
    total: null,   // unknown total is allowed
  },
  meta: {
    operation: "users.list",
    requestId: "req_list_001",
    transport: "http",
  },
});
```

### Offset-based pagination

```typescript
const envelope = createEnvelope({
  success: true,
  result: { items: [...] },
  page: {
    mode: "offset",
    limit: 50,     // 1–1000 per schema constraint
    offset: 100,   // ≥ 0
    hasMore: true,
    total: 437,
  },
  meta: { operation: "items.list", requestId: "req_items_001" },
});
```

### No pagination

```typescript
page: { mode: "none" }
```

## Session-correlated messages

Multi-step agent workflows use `sessionId` to correlate related envelopes:

```typescript
const SESSION_ID = "sess_workflow_abc123";

// Step 1
const step1 = createEnvelope({
  success: true,
  result: { taskId: "task_01", status: "created" },
  meta: {
    operation: "workflow.create",
    requestId: "req_step1",
    sessionId: SESSION_ID,
    contextVersion: 0,
  },
});

// Step 2 — same sessionId, incremented contextVersion
const step2 = createEnvelope({
  success: true,
  result: { taskId: "task_01", status: "running" },
  meta: {
    operation: "workflow.advance",
    requestId: "req_step2",
    sessionId: SESSION_ID,
    contextVersion: 1,   // increment per step
  },
});
```

## Deprecation warnings

Attach non-fatal warnings to envelopes when fields or behaviors are deprecated:

```typescript
const envelope = createEnvelope({
  success: true,
  result: { data: [...] },
  meta: {
    operation: "legacy.search",
    requestId: "req_search",
    warnings: [
      {
        code: "DEPRECATED_FIELD",
        message: "The 'q' parameter is deprecated; use 'query' instead",
        deprecated: "q",
        replacement: "query",
        removeBy: "2.0.0",
      },
    ],
  },
});
```

## Versioning fields

`specVersion` and `schemaVersion` both default to `"1.0.0"` and must follow semver format. Override them when your implementation targets a specific schema version:

```typescript
const envelope = createEnvelope({
  success: true,
  result: { ok: true },
  meta: {
    operation: "health.check",
    requestId: "req_health",
    specVersion: "1.0.0",     // LAFS spec version this envelope conforms to
    schemaVersion: "1.0.0",   // JSON schema version used for validation
  },
});
```

Both fields are validated against the pattern `^\d+\.\d+\.\d+$`. The `$schema` URI is always set to the v1 canonical URL regardless of these fields.

## MVI levels

The `mvi` field (Minimum Viable Information) controls the verbosity contract:

| Level | Meaning |
|---|---|
| `minimal` | Only the MVI fields required by the spec |
| `standard` | Common fields for typical use (default) |
| `full` | All optional fields included |
| `custom` | Fields specified by a `_fields` parameter |

```typescript
// Minimal disclosure for high-frequency, latency-sensitive paths
const envelope = createEnvelope({
  success: true,
  result: { count: 42 },
  meta: {
    operation: "metrics.count",
    requestId: "req_m",
    mvi: "minimal",
  },
});
```

## Validating what you built

After construction, validate against the schema and run semantic conformance checks:

```typescript
import {
  createEnvelope,
  validateEnvelope,
  runEnvelopeConformance,
  assertCompliance,
} from "@cleocode/lafs";

const envelope = createEnvelope({ ... });

// 1. Schema validation (AJV against schemas/v1/envelope.schema.json)
const schemaResult = validateEnvelope(envelope);
if (!schemaResult.valid) {
  console.error("Schema errors:", schemaResult.errors);
  // e.g. ["/_meta/operation must NOT have fewer than 1 characters"]
}

// 2. Semantic conformance (invariants beyond schema)
const report = runEnvelopeConformance(envelope);
if (!report.ok) {
  for (const check of report.checks) {
    if (!check.pass) {
      console.error(`${check.name}: ${check.detail}`);
    }
  }
}

// 3. Combined (throws ComplianceError if any check fails)
const compliant = assertCompliance(envelope, { checkConformance: true });
```

## Handling construction errors

`createEnvelope` does not throw—it builds the object and returns it. Validation errors only surface when you explicitly validate. This means you can always call `validateEnvelope` after construction to get structured feedback:

```typescript
// Intentionally invalid: empty operation string
const bad = createEnvelope({
  success: true,
  result: { x: 1 },
  meta: {
    operation: "",           // violates minLength: 1
    requestId: "r",          // violates minLength: 3
  },
});

const { valid, errors } = validateEnvelope(bad);
// valid: false
// errors: [
//   "/_meta/operation must NOT have fewer than 1 characters",
//   "/_meta/requestId must NOT have fewer than 3 characters"
// ]
```

For strict pipelines that must guarantee compliance before emitting, use `assertCompliance` or `withCompliance`:

```typescript
import { withCompliance, ComplianceError } from "@cleocode/lafs";

// Wrap your producer — it will throw ComplianceError if the result is non-compliant
const safeProducer = withCompliance(
  async (userId: string) => createEnvelope({
    success: true,
    result: { userId },
    meta: { operation: "users.get", requestId: `req_${userId}` },
  }),
  { checkConformance: true },
);

try {
  const envelope = await safeProducer("usr_01");
} catch (error) {
  if (error instanceof ComplianceError) {
    console.error(error.issues);
    // [{ stage: "envelope", message: "...", detail: "..." }]
  }
}
```

## Using schema imports for external validators

Import the canonical schema for use with your own Ajv instance or other JSON Schema validators:

```typescript
import envelopeSchema from "@cleocode/lafs/schemas/v1/envelope.schema.json";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(envelopeSchema);

function buildAndValidate(data: unknown): boolean {
  return validate(data) as boolean;
}
```

For TypeScript projects, pair schema imports with the `LAFSEnvelope` type to get compile-time and runtime coverage:

```typescript
import type { LAFSEnvelope } from "@cleocode/lafs";

// satisfies gives compile-time checking without widening the type
const envelope = {
  $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
  _meta: {
    specVersion: "1.0.0",
    schemaVersion: "1.0.0",
    timestamp: new Date().toISOString(),
    operation: "tasks.complete",
    requestId: "req_done_01",
    transport: "sdk",
    strict: true,
    mvi: "standard",
    contextVersion: 2,
  },
  success: true,
  result: { taskId: "task_42", completedAt: new Date().toISOString() },
} satisfies LAFSEnvelope;
```

## Next steps

- [TypeScript SDK Reference](./sdk/typescript.md) — full API reference
- [Compliance Pipeline](./guides/compliance-pipeline.md) — enforce compliance across a pipeline
- [Schema Extension Guide](./guides/schema-extension.md) — extend the schema for your domain
- [Error Handling](./getting-started/error-handling.md) — error envelope patterns in detail
