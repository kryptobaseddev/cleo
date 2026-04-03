---
name: SKILL-lafs
description: >
  LLM-Agent-First Specification schemas and conformance tooling Use when: (1) running lafs-conformance CLI commands, (2) calling its 92 API functions, (3) configuring @cleocode/lafs, (4) understanding its 100 type definitions, (5) working with its 18 classes, (6) user mentions "lafs", "llm", "agent", "protocol", "schema", (7) user mentions "@cleocode/lafs" or asks about its API.
---

# @cleocode/lafs

LLM-Agent-First Specification schemas and conformance tooling

## Quick Start

```bash
npm install -D @cleocode/lafs
```

```bash
npx lafs-conformance --help
```

## API

| Function | Description |
|----------|-------------|
| `estimateTokens()` | Convenience function to estimate tokens for a value. |
| `estimateTokensJSON()` | Convenience function to estimate tokens from a JSON string. |
| `isMVILevel()` | Type guard that checks whether an unknown value is a valid `MVILevel`. |
| `isAgentAction()` | Type guard that checks whether an unknown value is a valid `LAFSAgentAction`. |
| `applyBudgetEnforcement()` | Apply budget enforcement to an envelope. |
| `withBudget()` | Create a budget enforcement middleware function. |
| `checkBudget()` | Check if an envelope has exceeded its budget without modifying it. |
| `withBudgetSync()` | Synchronous version of withBudget for non-async contexts. |
| `wrapWithBudget()` | Higher-order function that wraps a handler with budget enforcement. |
| `composeMiddleware()` | Compose multiple middleware functions into a single middleware. |
| `getConformanceProfiles()` | Loads the conformance profiles from the bundled JSON schema. |
| `getChecksForTier()` | Returns the list of check names that belong to the given conformance tier. |
| `validateConformanceProfiles()` | Validates that the conformance profiles are internally consistent and reference only known checks. |
| `getErrorRegistry()` | Loads the full LAFS error registry from the bundled JSON. |
| `isRegisteredErrorCode()` | Checks whether a given error code exists in the LAFS error registry. |
| ... | 77 more — see API reference |

## Configuration

```typescript
import type { ServiceConfig } from "@cleocode/lafs";

const config: Partial<ServiceConfig> = {
  // Service name
  name: "...",
  // Service version
  version: "...",
  // Human-readable description.
  description: "...",
};
```

See [references/CONFIGURATION.md](references/CONFIGURATION.md) for full details.

## Gotchas

- `Capability` is deprecated: Use `AgentSkill` instead.
- `ServiceConfig` is deprecated: Use `AgentCard` instead.
- `EndpointConfig` is deprecated: Will be removed in v2.0.0.
- `DiscoveryDocument` is deprecated: Use `AgentCard` instead.
- `resolveOutputFormat()` throws: `LAFSFlagError` When `humanFlag` and `jsonFlag` are both truthy.
- `assertEnvelope()` throws: Error When the input does not conform to the envelope schema.
- `assertCompliance()` throws: `ComplianceError` When any compliance stage fails.
- `parseLafsResponse()` throws: LafsError When the envelope indicates failure (`success=false`).
- `parseLafsResponse()` throws: Error When the envelope is structurally invalid or   `requireRegisteredErrorCode` is `true` and the code is unregistered.
- `resolveFieldExtraction()` throws: `LAFSFlagError` When both `fieldFlag` and `fieldsFlag` are set.
- `resolveFlags()` throws: `LAFSFlagError` When format or field layer flags conflict.
- `getErrorCodeMapping()` throws: Error if the error type is not a known A2A error type

## Key Types

- **`TokenEstimatorOptions`** — Configuration options for the token estimator.
- **`TokenEstimator`** — Character-based token estimator for JSON payloads.
- **`LAFSTransport`** — Transport protocol used to deliver a LAFS envelope.
- **`LAFSErrorCategory`** — Classification category for a LAFS error.
- **`Warning`** — A non-fatal warning attached to a LAFS envelope's `_meta.warnings` array.
- **`MVILevel`** — Minimum Viable Information level controlling envelope verbosity.
- **`LAFSMeta`** — Metadata block (`_meta`) embedded in every LAFS envelope.
- **`LAFSAgentAction`** — Recommended action an LLM agent should take in response to an error.
- **`LAFSError`** — Structured error payload returned in a failing LAFS envelope.
- **`LAFSPageCursor`** — Cursor-based pagination metadata.

## References

- [references/CONFIGURATION.md](references/CONFIGURATION.md) — Full config options
- [references/API-REFERENCE.md](references/API-REFERENCE.md) — Signatures, parameters, examples
