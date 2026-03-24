# TypeScript SDK Reference

Code-truth source for this page: `src/index.ts`.

## Install

```bash
npm install @cleocode/lafs
```

## Envelope APIs

### `createEnvelope(input)`

Builds a schema-ready envelope with sane defaults for `_meta`.

```typescript
import { createEnvelope } from "@cleocode/lafs";

const envelope = createEnvelope({
  success: true,
  result: { message: "Hello, World!" },
  meta: {
    operation: "hello.world",
    requestId: "req_123",
  },
});
```

Defaults applied:
- `$schema`: `https://lafs.dev/schemas/v1/envelope.schema.json`
- `_meta.specVersion`: `1.0.0`
- `_meta.schemaVersion`: `1.0.0`
- `_meta.timestamp`: current ISO date-time
- `_meta.transport`: `sdk`
- `_meta.strict`: `true`
- `_meta.mvi`: `standard`
- `_meta.contextVersion`: `0`

### `parseLafsResponse(input, options?)`

Validates input and returns `result` on success. Throws `LafsError` on protocol error envelopes.

```typescript
import { LafsError, parseLafsResponse } from "@cleocode/lafs";

try {
  const result = parseLafsResponse<{ users: Array<{ id: string }> }>(envelope);
  console.log(result.users.length);
} catch (error) {
  if (error instanceof LafsError) {
    console.error(error.code, error.category, error.retryable);
  }
}
```

Options:
- `requireRegisteredErrorCode?: boolean`

### `LafsError`

Thrown by `parseLafsResponse` for `success: false` envelopes.

Properties:
- `code`
- `message`
- `category`
- `retryable`
- `retryAfterMs`
- `details`
- `registered` (whether code exists in registry)

## Validation and conformance APIs

### `validateEnvelope(input)`

Schema validation using Ajv and `schemas/v1/envelope.schema.json`.

```typescript
import { validateEnvelope } from "@cleocode/lafs";

const result = validateEnvelope(envelope);
if (!result.valid) {
  console.error(result.errors);
}
```

### `assertEnvelope(input)`

Same validation, throws if invalid and returns typed `LAFSEnvelope` if valid.

```typescript
import { assertEnvelope } from "@cleocode/lafs";

const typed = assertEnvelope(unknownInput);
```

### `runEnvelopeConformance(envelope)`

Runs semantic checks in addition to schema validation.

```typescript
import { runEnvelopeConformance } from "@cleocode/lafs";

const report = runEnvelopeConformance(envelope);
if (!report.ok) {
  for (const check of report.checks) {
    if (!check.pass) console.error(check.name, check.detail);
  }
}
```

Optional tier filter:

```typescript
const coreOnly = runEnvelopeConformance(envelope, { tier: "core" });
```

Checks currently include:
- `envelope_schema_valid`
- `envelope_invariants`
- `error_code_registered`
- `transport_mapping_consistent`
- `context_mutation_failure`
- `context_preservation_valid`
- `meta_mvi_present`
- `meta_strict_present`
- `strict_mode_behavior`
- `pagination_mode_consistent`
- `strict_mode_enforced`

### `isRegisteredErrorCode(code)`

```typescript
import { isRegisteredErrorCode } from "@cleocode/lafs";

if (!isRegisteredErrorCode("E_VALIDATION_SCHEMA")) {
  throw new Error("Unregistered error code");
}
```

## Compliance pipeline APIs

### `enforceCompliance(input, options?)`

Runs schema validation, envelope conformance checks, optional flag conformance, and optional JSON-output policy checks.

```typescript
import { enforceCompliance } from "@cleocode/lafs";

const result = enforceCompliance(envelope, {
  checkConformance: true,
  requireJsonOutput: true,
  flags: { jsonFlag: true },
});

if (!result.ok) {
  console.error(result.issues);
}
```

### `assertCompliance(input, options?)`

Returns typed `LAFSEnvelope` if compliant, otherwise throws `ComplianceError`.

### `withCompliance(producer, options?)`

Wrap any envelope producer with compliance gating.

### `createComplianceMiddleware(options?)`

Creates middleware `(envelope, next) => envelope` that enforces compliance on `next()` output.

## Format policy APIs

### `resolveOutputFormat(flags)`

```typescript
import { resolveOutputFormat } from "@cleocode/lafs";

const format = resolveOutputFormat({ jsonFlag: true, humanFlag: false });
// { format: "json", source: "flag", quiet: false }
```

### `runFlagConformance(flags)`

```typescript
import { runFlagConformance } from "@cleocode/lafs";

const report = runFlagConformance({ projectDefault: "json" });
console.log(report.ok);
```

## MCP adapter APIs

### `wrapMCPResult(mcpResult, operation, budget?)`

Converts MCP `CallToolResult` to a LAFS envelope.

### `createAdapterErrorEnvelope(message, operation, category?)`

Creates LAFS envelope for adapter-level failures.

## A2A APIs

Use `@cleocode/lafs/a2a` for:
- Extension negotiation
- Task lifecycle utilities
- Binding helpers (`@cleocode/lafs/a2a/bindings`)

## Schema imports

You can import canonical schemas directly:

```typescript
import envelopeSchema from "@cleocode/lafs/schemas/v1/envelope.schema.json";
import conformanceProfiles from "@cleocode/lafs/schemas/v1/conformance-profiles.json";
```

## Next steps

- [Quick Start Guide](../getting-started/quickstart.md)
- [LLM Agent Guide](../guides/llm-agent-guide.md)
- [Schema Extension Guide](../guides/schema-extension.md)
