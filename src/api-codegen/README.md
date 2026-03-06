# CLEO API Code Generation

Dynamic API specification generator for the CLEO ecosystem. Generates OpenAPI specs, TypeScript clients, and Markdown documentation directly from the OperationRegistry.

## Quick Start

```bash
# Generate OpenAPI spec for NEXUS domain
npm run generate:api -- --format openapi --domain nexus --output docs/specs/cleo-nexus-openapi.json

# Generate TypeScript client for all domains
npm run generate:api -- --format typescript --output src/clients/cleo-client.ts

# Generate Markdown documentation
npm run generate:api -- --format markdown --domain nexus --output docs/specs/nexus-api-generated.md

# Output to stdout (useful for piping)
npm run generate:api -- --format openapi --domain nexus | jq .
```

## Supported Formats

| Format | Extension | Use Case |
|--------|-----------|----------|
| `openapi` | `.json` | API documentation, client generation, import to Postman/Insomnia |
| `typescript` | `.ts` | Type-safe client SDK for TypeScript/JavaScript consumers |
| `markdown` | `.md` | Human-readable documentation |

## Command Options

```
Options:
  --format, -f      Output format: openapi|typescript|markdown (default: openapi)
  --domain, -d      Filter to specific domain (e.g., 'nexus', 'tasks')
  --output, -o      Output file path (default: stdout)
  --version, -v     API version (default: 1.0.0)
  --help, -h        Show help message
```

## API Specification Sources

The generator reads from `src/dispatch/registry.ts`:

- **OPERATIONS** array - All 256 operations (145 query + 111 mutate)
- **OperationDef** interface - Operation metadata structure
- **CanonicalDomain** - 10 official domains

## LAFS Compliance

All generated specifications include:

- **LAFS Envelope** support (`application/vnd.lafs+json`)
- **MVI (Minimal Verbosity Indicator)** levels
- **Field filtering** (`_fields` parameter)
- **Exit code mapping** to HTTP status codes
- **Correlation IDs** for distributed tracing

## Generated Output Examples

### OpenAPI (NEXUS Domain)

Generates a complete OpenAPI 3.1 specification with:

- All 24 nexus operations documented
- Request/response schemas
- LAFS envelope schemas
- HTTP status code mappings
- Security schemes (bearer auth)

### TypeScript Client

```typescript
import { createCleoClient } from './clients/cleo-client';

const client = createCleoClient({ baseUrl: 'http://localhost:34567' });

// Type-safe API calls
const status = await client.nexus.status({});
const projects = await client.nexus.list({});
```

### Markdown Documentation

Generates human-readable docs with:

- Domain grouping
- Operation descriptions
- Parameter tables
- Tier/idempotency/session info

## Integration with CLEO-NEXUS-API

The [CLEO-NEXUS-API.md](../specs/CLEO-NEXUS-API.md) specification is the **canonical reference** for the NEXUS domain. This code generator produces machine-readable specs from the same source of truth (OperationRegistry).

To regenerate specs after adding new operations:

```bash
# Regenerate OpenAPI spec
npm run generate:api -- --format openapi --domain nexus \
  --output docs/specs/cleo-nexus-openapi.json

# Regenerate TypeScript client
npm run generate:api -- --format typescript \
  --output src/clients/nexus-client.ts
```

## A2A Compliance

Generated clients support **Agent-to-Agent (A2A)** communication:

```typescript
// A2A envelope mode
const response = await client.nexus.status({}, { lafs: true });
// Returns full LAFS envelope with _meta, success, result

// Capability discovery
const capabilities = await client.admin.help({ domain: 'nexus' });
```

## Exit Codes

NEXUS-specific exit codes (70-79):

| Code | Meaning |
|------|---------|
| 71 | Nexus not initialized |
| 72 | Project not found |
| 73 | Permission denied |
| 74 | Invalid syntax |
| 75 | Sync failed |
| 76 | Registry corrupt |
| 77 | Project exists |
| 78 | Query failed |
| 79 | Graph error |

## Related Specifications

- [CLEO-NEXUS-API.md](../specs/CLEO-NEXUS-API.md) - Comprehensive NEXUS API docs
- [CLEO-WEB-API-SPEC.md](../specs/CLEO-WEB-API-SPEC.md) - HTTP adapter spec
- [LAFS Protocol](https://github.com/kryptobaseddev/lafs-protocol) - LLM-Agent-First Specification

## Implementation Notes

- The generator uses dynamic imports to load the registry at runtime
- All paths are resolved relative to the project root
- Generated files include a "DO NOT EDIT" header
- Timestamps are in ISO 8601 format (UTC)
