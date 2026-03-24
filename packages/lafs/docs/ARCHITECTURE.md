# Architecture

LAFS is organized around an envelope contract, validation runtime, and transport adapters.

## Core modules

- `src/envelope.ts` - envelope construction and parsing (`createEnvelope`, `parseLafsResponse`, `LafsError`)
- `src/validateEnvelope.ts` - Ajv schema validator
- `src/conformance.ts` - semantic conformance checks
- `src/compliance.ts` - first-class compliance gate + middleware helpers
- `src/flagSemantics.ts` - json/human format resolution + conflict detection
- `src/errorRegistry.ts` - registered error lookup

## Envelope lifecycle

1. Produce envelope (`createEnvelope` or adapter wrapper)
2. Validate schema (`validateEnvelope`)
3. Enforce semantics (`runEnvelopeConformance` or `enforceCompliance`)
4. Parse uniformly at consumers (`parseLafsResponse`)

## Transport adapters

- MCP adapter: `src/mcpAdapter.ts`
- A2A integration: `src/a2a/*`
- Discovery middleware: `src/discovery.ts`

## Public package exports

From `@cleocode/lafs`:

- Envelope API: `createEnvelope`, `parseLafsResponse`, `LafsError`
- Validation API: `validateEnvelope`, `assertEnvelope`
- Conformance API: `runEnvelopeConformance`, `runFlagConformance`
- Compliance API: `enforceCompliance`, `assertCompliance`, `withCompliance`, `createComplianceMiddleware`
- MCP helpers: `wrapMCPResult`, `createAdapterErrorEnvelope`

Subpaths:

- `@cleocode/lafs/a2a`
- `@cleocode/lafs/a2a/bindings`
- `@cleocode/lafs/schemas/v1/envelope.schema.json`

## Design goals (VISION alignment)

- One parser path for multi-protocol agent workflows
- Schema-first enforcement, no inferred contracts
- Reusable pipeline gating APIs for agent output hardening
- Machine-readable docs and schema exports for LLM tooling
