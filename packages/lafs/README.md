# LAFS Protocol

**LLM-Agent-First Specification** — a response envelope contract for AI agent systems.

LAFS defines a standard envelope format for structured responses from LLM-powered agents and tools. It complements transport protocols like [MCP](https://modelcontextprotocol.io/) and [A2A](https://github.com/google/A2A) by standardizing what comes back — not how it gets there.

**Current version:** 1.5.0 | [📚 Documentation](https://codluv.gitbook.io/lafs/) | [Spec](lafs.md) | [Migration Guides](migrations/)

[![GitBook](https://img.shields.io/badge/docs-gitbook-blue)](https://codluv.gitbook.io/lafs/)
[![npm](https://img.shields.io/npm/v/@cleocode/lafs)](https://www.npmjs.com/package/@cleocode/lafs)

## What LAFS provides

| Layer | Files | Description |
|-------|-------|-------------|
| **Spec** | `lafs.md` | Protocol specification with RFC 2119 language |
| **Schemas** | `schemas/v1/envelope.schema.json` | Envelope schema (Draft-07) with conditional pagination validation |
| | `schemas/v1/context-ledger.schema.json` | Context ledger for state tracking across request/response cycles |
| | `schemas/v1/error-registry.json` | 12 registered error codes with HTTP/gRPC/CLI transport mappings |
| **Tooling** | `src/` | TypeScript validation, conformance runner, CLI diagnostic tool |
| **A2A** | `src/a2a/` | Agent-to-Agent integration: extensions, task lifecycle, protocol bindings (JSON-RPC/HTTP/gRPC) |
| **Tests** | `tests/` | Tests covering envelope, pagination, strict mode, error handling, A2A extensions, task lifecycle, bindings |
| **Fixtures** | `fixtures/` | 14 JSON fixtures (valid + invalid) for conformance testing |
| **Docs** | `docs/` | [GitBook documentation](https://codluv.gitbook.io/lafs/) with guides, SDK reference, and specs |

## Install

```bash
npm install @cleocode/lafs
```

## Usage

```typescript
import {
  createEnvelope,
  parseLafsResponse,
  LafsError,
  validateEnvelope,
  runEnvelopeConformance,
  isRegisteredErrorCode,
} from "@cleocode/lafs";

// Build envelope with defaults
const envelope = createEnvelope({
  success: true,
  result: { items: [] },
  meta: { operation: "example.list", requestId: "req_1" },
});

// Validate an envelope against the schema
const validation = validateEnvelope(envelope);
if (!validation.valid) {
  console.error(validation.errors);
}

// Parse envelope responses with one function
try {
  const parsed = parseLafsResponse(envelope);
  console.log(parsed);
} catch (error) {
  if (error instanceof LafsError) {
    console.error(error.code, error.message);
  }
}

// Run full conformance suite (schema + invariants + error codes + strict mode + pagination)
const report = runEnvelopeConformance(envelope);
console.log(report.ok); // true if all checks pass
```

## LLM-agent implementation guides

- `docs/guides/llm-agent-guide.md` - parser, success/error handling, strict JSON policy
- `docs/guides/schema-extension.md` - operation-specific result validation on top of core schema
- `docs/guides/compliance-pipeline.md` - generation middleware with validate + conformance gates
- `docs/llms.txt` - LLM-oriented index and canonical sources

## CLI

```bash
# Run conformance checks on a fixture
npm run conformance -- --envelope fixtures/valid-success-envelope.json

# Run tests
npm test

# Type check
npm run typecheck
```

## Envelope structure

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-13T00:00:00Z",
    "operation": "example.list",
    "requestId": "req_01",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 1
  },
  "success": true,
  "result": { "items": [{ "id": "1", "title": "Example" }] },
  "page": {
    "mode": "cursor",
    "nextCursor": "eyJpZCI6IjEwIn0=",
    "hasMore": true
  }
}
```

## Key features

- **Conditional pagination** — cursor, offset, and none modes with mode-specific required fields
- **Strict/lenient mode** — `strict: true` rejects unknown properties; `strict: false` allows them
- **MVI disclosure levels** — `minimal`, `standard`, `full`, `custom` control response verbosity
- **Field selection** (`_fields`) and **expansion** (`_expand`) request parameters
- **Context ledger** — tracks state across request/response cycles with monotonic versioning
- **Error registry** — 12 codes with category, retryability, and transport-specific status mappings
- **Extension mechanism** — `_extensions` field for vendor metadata (`x-` prefix convention)
- **Adoption tiers** — Core, Standard, Complete with progressive conformance requirements
- **A2A integration** — Agent Card discovery, extension negotiation, task lifecycle management, protocol bindings

## A2A Integration

LAFS integrates with the [A2A Protocol](https://github.com/google/A2A) via `@a2a-js/sdk`. Import from the `@cleocode/lafs/a2a` subpath:

```typescript
import {
  // Extensions
  buildLafsExtension,
  extensionNegotiationMiddleware,
  LAFS_EXTENSION_URI,

  // Task lifecycle
  TaskManager,
  attachLafsEnvelope,
  isTerminalState,

  // Protocol bindings
  getErrorCodeMapping,
  createJsonRpcRequest,
  createProblemDetails,
} from "@cleocode/lafs/a2a";
```

**Agent Card with LAFS extension** — use `autoIncludeLafsExtension` in discovery config:

```typescript
import { discoveryMiddleware } from "@cleocode/lafs/discovery";

app.use(discoveryMiddleware({
  agent: { name: "my-agent", /* ... */ },
  autoIncludeLafsExtension: true,
}));
```

**Protocol bindings** are also available as a standalone subpath:

```typescript
import { getErrorCodeMapping } from "@cleocode/lafs/a2a/bindings";
```

## Conformance checks

| Check | Description | Tier |
|-------|-------------|------|
| `envelope_schema_valid` | Validates against JSON Schema | Core |
| `envelope_invariants` | success/result/error consistency | Core |
| `error_code_registered` | Error code exists in registry | Core |
| `meta_mvi_present` | Valid MVI disclosure level | Standard |
| `meta_strict_present` | Strict mode declared | Standard |
| `strict_mode_behavior` | Optional fields omitted (not null) in strict mode | Standard |
| `strict_mode_enforced` | Additional properties rejected/allowed per mode | Standard |
| `pagination_mode_consistent` | Page fields match declared mode | Standard |

## Project layout

```
lafs.md                          # Protocol specification
schemas/v1/
  envelope.schema.json           # Envelope schema (Draft-07)
  context-ledger.schema.json     # Context ledger schema
  error-registry.json            # Error code registry
src/
  types.ts                       # TypeScript types (discriminated unions)
  validateEnvelope.ts            # Ajv-based schema validator
  conformance.ts                 # Conformance runner (8 checks)
  errorRegistry.ts               # Error code helpers
  flagSemantics.ts               # Format flag resolution
  discovery.ts                   # A2A Agent Card discovery middleware
  cli.ts                         # CLI diagnostic tool
  a2a/
    bridge.ts                    # A2A SDK integration & result wrapper
    extensions.ts                # Extension negotiation & LAFS extension builder
    task-lifecycle.ts            # Task state machine & lifecycle management
    bindings/
      jsonrpc.ts                 # JSON-RPC 2.0 method/error constants & builders
      http.ts                    # HTTP endpoints, RFC 9457 Problem Details
      grpc.ts                    # gRPC status codes & service definitions (types only)
      index.ts                   # Barrel export & cross-binding error mapping
tests/                           # Tests (vitest)
fixtures/                        # JSON test fixtures
docs/
  POSITIONING.md                 # MCP/A2A complementary positioning
  VISION.md                      # Project vision and primary persona
  CONFORMANCE.md                 # Conformance checks and adoption tiers
migrations/
  v0.3.0-to-v0.4.0.md           # Envelope rationalization migration
  v0.4.0-to-v0.5.0.md           # Pagination & MVI schema migration
CONTRIBUTING.md                  # Contributor guidelines, RFC process
```

## Version history

| Version | Phase | Description |
|---------|-------|-------------|
| **v1.2.3** | **4** | **A2A v1.0+ compliance: extension negotiation, task lifecycle, protocol bindings (JSON-RPC/HTTP/gRPC)** |
| v1.0.0 | 3 | Production release: Token budgets, agent discovery, MCP integration, complete SDKs |
| v0.5.0 | 2B | Conditional pagination, MVI field selection/expansion, context ledger schema |
| v0.4.0 | 2A | Optional page/error, extensions, strict/lenient mode, warnings |
| v0.3.0 | 1 | Strategic positioning, vision alignment, adoption tiers |
| v0.2.0 | 0 | Protocol cleanup, fixtures, governance, security considerations |
| v0.1.1 | — | Initial npm publish |
| v0.1.0 | — | Bootstrap |

## License

MIT
