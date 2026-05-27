# LAFS Protocol

**LLM-Agent-First Specification** -- a response envelope contract for AI agent systems.

LAFS defines a standard envelope format for structured responses from LLM-powered agents and tools. It complements transport protocols like [MCP](https://modelcontextprotocol.io/) and [A2A](https://github.com/google/A2A) by standardizing what comes back -- not how it gets there.

**Current version:** 2026.4.0 | [Spec](lafs.md)

[![npm](https://img.shields.io/npm/v/@cleocode/lafs)](https://www.npmjs.com/package/@cleocode/lafs)

## What LAFS provides

| Layer | Files | Description |
|-------|-------|-------------|
| **Spec** | `lafs.md` | Protocol specification with RFC 2119 language |
| **Schemas** | `schemas/v1/envelope.schema.json` | Envelope schema (Draft-07) with conditional pagination validation |
| | `schemas/v1/context-ledger.schema.json` | Context ledger for state tracking across request/response cycles |
| | `schemas/v1/discovery.schema.json` | Agent Card discovery schema |
| | `schemas/v1/conformance-profiles.json` | Conformance tier definitions |
| | `schemas/v1/error-registry.json` | 13 registered error codes with HTTP/gRPC/CLI transport mappings |
| **Tooling** | `src/` | TypeScript validation, conformance runner, CLI diagnostic tool |
| **A2A** | `src/a2a/` | Agent-to-Agent integration: extensions, task lifecycle, streaming, protocol bindings (JSON-RPC/HTTP/gRPC) |
| **Tests** | `tests/` | 20 test suites covering envelope, pagination, strict mode, error handling, A2A extensions, task lifecycle, bindings |
| **Fixtures** | `fixtures/` | 25 JSON fixtures (valid + invalid + agent workflow scenarios) for conformance testing |
| **Docs** | `docs/` | Guides, SDK reference, architecture docs, and specs |

## Install

```bash
# Inside the monorepo (pnpm workspace)
pnpm add @cleocode/lafs

# External consumers
npm install @cleocode/lafs
# or: yarn add @cleocode/lafs
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

// Build a success envelope
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

// Parse envelope responses
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

### Envelope invariants

- `$schema`, `_meta`, `success`, and `result` are always required.
- `success: true` implies `error` is `null` (or absent).
- `success: false` requires a non-null `error` object. `result` MAY be non-null on error envelopes -- this allows validation tools to include actionable data (e.g., suggested fixes) alongside error metadata.
- Exactly one pagination mode (`cursor`, `offset`, `none`) with mode-specific required fields.
- `strict: true` rejects additional properties; `strict: false` allows them.

## Key features

- **Conditional pagination** -- cursor, offset, and none modes with mode-specific required fields
- **Strict/lenient mode** -- `strict: true` rejects unknown properties; `strict: false` allows them
- **MVI disclosure levels** -- `minimal`, `standard`, `full`, `custom` control response verbosity
- **Field selection** (`_fields`) and **expansion** (`_expand`) request parameters
- **Context ledger** -- tracks state across request/response cycles with monotonic versioning
- **Error registry** -- 13 codes with category, retryability, agent action, and transport-specific status mappings
- **Extension mechanism** -- `_extensions` field for vendor metadata (`x-` prefix convention)
- **Adoption tiers** -- Core, Standard, Complete with progressive conformance requirements
- **A2A integration** -- Agent Card discovery, extension negotiation, task lifecycle management, protocol bindings
- **Operations and reliability** -- circuit breaker, health checks, graceful shutdown, budget enforcement, token estimation
- **MCP adapter** -- wrap LAFS envelopes for Model Context Protocol tool responses
- **Problem Details** -- RFC 9457 Problem Details generation from LAFS errors

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

**Agent Card with LAFS extension** -- use `autoIncludeLafsExtension` in discovery config:

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

## CLI

```bash
# Run conformance checks on a fixture
pnpm run conformance -- --envelope fixtures/valid-success-envelope.json

# Run tests
pnpm test

# Type check
pnpm run typecheck
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
  discovery.schema.json          # Agent Card discovery schema
  conformance-profiles.json      # Conformance tier definitions
  agent-card.schema.json         # Agent Card schema
  error-registry.json            # Error code registry (13 codes)
src/
  index.ts                       # Barrel export (all public API)
  types.ts                       # Core types (LAFSEnvelope, LAFSError, etc.)
  envelope.ts                    # createEnvelope(), parseLafsResponse(), LafsError
  validateEnvelope.ts            # Schema validator (native Rust via napi-rs, AJV fallback)
  conformance.ts                 # Conformance runner (runEnvelopeConformance)
  conformanceProfiles.ts         # Tier-based conformance profile definitions
  compliance.ts                  # Compliance pipeline utilities
  errorRegistry.ts               # Error code helpers (getRegistryCode, isRegisteredErrorCode)
  flagSemantics.ts               # Format flag resolution (--json / --human)
  flagResolver.ts                # Flag resolution with config precedence
  fieldExtraction.ts             # _fields / _expand parameter extraction
  mviProjection.ts               # MVI disclosure level projection
  tokenEstimator.ts              # Token budget estimation
  budgetEnforcement.ts           # Token budget enforcement
  problemDetails.ts              # RFC 9457 Problem Details from LAFS errors
  deprecationRegistry.ts         # Deprecation tracking and warnings
  native-loader.ts               # Lazy native Rust validator loader
  discovery.ts                   # A2A Agent Card discovery middleware
  cli.ts                         # CLI diagnostic tool (lafs-conformance)
  health/index.ts                # Health check endpoint
  circuit-breaker/index.ts       # Circuit breaker pattern
  shutdown/index.ts              # Graceful shutdown handler
  a2a/
    index.ts                     # A2A barrel export
    bridge.ts                    # A2A SDK integration & result wrapper
    extensions.ts                # Extension negotiation & LAFS extension builder
    task-lifecycle.ts            # Task state machine & lifecycle management
    streaming.ts                 # SSE/streaming task event support
    bindings/
      index.ts                   # Barrel export & cross-binding error mapping
      jsonrpc.ts                 # JSON-RPC 2.0 method/error constants & builders
      http.ts                    # HTTP endpoints, RFC 9457 Problem Details
      grpc.ts                    # gRPC status codes & service definitions (types only)
tests/                           # 20 test suites (vitest)
fixtures/                        # 25 JSON fixtures (valid + invalid + agent workflows)
docs/                            # Guides, architecture, SDK reference
CONTRIBUTING.md                  # Contributor guidelines
```

## Version history

| Version | Description |
|---------|-------------|
| **2026.4.0** | CalVer adoption. Operations and reliability modules (circuit breaker, health, shutdown, budget enforcement). MCP adapter. Problem Details (RFC 9457). Streaming support. |
| 1.8.0 | Error envelopes MAY include non-null `result` for actionable data alongside error metadata. |
| 1.5.0 | Agent workflows fixtures. Deprecation registry. Field extraction. MVI projection. |
| 1.2.3 | A2A v1.0+ compliance: extension negotiation, task lifecycle, protocol bindings (JSON-RPC/HTTP/gRPC). |
| 1.0.0 | Production release: token budgets, agent discovery, MCP integration. |
| 0.5.0 | Conditional pagination, MVI field selection/expansion, context ledger schema. |
| 0.4.0 | Optional page/error, extensions, strict/lenient mode, warnings. |
| 0.3.0 | Strategic positioning, vision alignment, adoption tiers. |
| 0.1.0 | Initial release. |

## Repository

This package lives at [`packages/lafs`](https://github.com/kryptobaseddev/cleo/tree/main/packages/lafs) in the [kryptobaseddev/cleo](https://github.com/kryptobaseddev/cleo) monorepo.

## License

MIT
