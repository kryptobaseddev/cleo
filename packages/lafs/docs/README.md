# Welcome to LAFS

> GitBook: https://codluv.gitbook.io/lafs/

LAFS is a schema-first response envelope contract for tools, APIs, and agents. It gives LLM agents one stable response shape across transports.

What you get:
- One envelope parser path for REST, MCP, and A2A boundaries
- Deterministic error structure with registered code checks
- JSON-default format semantics with explicit conflict handling
- Conformance checks beyond raw schema validation

## Start here (LLM-agent focused)

1. [Quick Start Guide](getting-started/quickstart.md)
2. [LLM Agent Guide](guides/llm-agent-guide.md)
3. [Schema Extension Guide](guides/schema-extension.md)
4. [Compliance Pipeline Guide](guides/compliance-pipeline.md)

## What the TypeScript package exports today

Import from `@cleocode/lafs`:

- `validateEnvelope(input)`
- `assertEnvelope(input)`
- `createEnvelope(input)`
- `parseLafsResponse(input, options?)`
- `LafsError`
- `runEnvelopeConformance(envelope)`
- `runFlagConformance(flags)`
- `resolveOutputFormat(flags)`
- `isRegisteredErrorCode(code)`
- `wrapMCPResult(mcpResult, operation, budget?)`
- `createAdapterErrorEnvelope(message, operation, category?)`

Import from `@cleocode/lafs/a2a` for A2A integration helpers.

## Canonical envelope shape

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-24T00:00:00Z",
    "operation": "users.list",
    "requestId": "req_123",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 1
  },
  "success": true,
  "result": { "users": [] }
}
```

Notes:
- `error` is optional for `success: true`.
- `error` is required and `result` must be `null` when `success: false`.
- `page` is optional.

## Envelope-first APIs you should use

- `createEnvelope` for constructing canonical envelopes
- `parseLafsResponse` + `LafsError` for unified consumption
- `validateEnvelope` + `runEnvelopeConformance` for hardening

## Integration options

- [MCP Integration](integrations/mcp.md)
- [A2A Integration](integrations/a2a.md)
- [REST Integration](integrations/rest.md)

## Normative and machine-readable references

- [Specification](specification.md)
- [Envelope Schema](../schemas/v1/envelope.schema.json)
- [Error Registry](../schemas/v1/error-registry.json)
- [LLM index](llms.txt)
