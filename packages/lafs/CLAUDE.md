@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LAFS (LLM-Agent-First Specification) is a language-neutral protocol for software systems whose primary consumer is an LLM agent. This package provides the canonical spec (`lafs.md`), versioned JSON schemas, and TypeScript-first reference tooling for validation and conformance testing.

Published as `@cleocode/lafs` on npm (version 2026.4.0). Part of a pnpm monorepo.

## Commands

```bash
pnpm run build          # Clean build: rm -rf dist && tsc -p tsconfig.build.json
pnpm run typecheck      # Type-check without emitting
pnpm run test           # Run all tests (vitest run)
pnpm run conformance -- --envelope fixtures/valid-success-envelope.json --flags fixtures/flags-valid.json
```

Run a single test file:
```bash
pnpm exec vitest run tests/envelope.test.ts
```

## Architecture

### Protocol Layer (language-agnostic)

- `lafs.md` - Canonical protocol specification using RFC 2119 keywords
- `schemas/v1/envelope.schema.json` - JSON Schema (Draft-07) for the response envelope
- `schemas/v1/error-registry.json` - Standard error codes with HTTP/gRPC/CLI exit code mappings
- `schemas/v1/context-ledger.schema.json` - Schema for context ledger entries
- `schemas/v1/discovery.schema.json` - Schema for agent discovery / Agent Card
- `schemas/v1/agent-card.schema.json` - A2A Agent Card schema
- `schemas/v1/conformance-profiles.json` - Tiered conformance check definitions (core/standard/complete)
- `fixtures/` - 25 JSON fixtures (valid and invalid envelopes, flags, pagination, agent workflows)

### TypeScript Toolkit (`src/`)

All modules are re-exported from `src/index.ts`:

| Module | Purpose |
|--------|---------|
| **Core** | |
| `types.ts` | Core types: `LAFSEnvelope`, `LAFSError`, `LAFSMeta`, `LAFSTransport`, `LAFSErrorCategory`, `MVILevel`, `LAFSAgentAction`, `LAFSPage`, `ContextLedger`, `Warning`, budget types |
| `envelope.ts` | Envelope builder: `createEnvelope()`, `createSuccessEnvelope()`, `createErrorEnvelope()`, `CATEGORY_ACTION_MAP`, error normalization with registry lookup |
| `validateEnvelope.ts` | Schema validation: `validateEnvelope()`, `assertEnvelope()`. Native Rust validator (lafs-napi) with AJV fallback. |
| `native-loader.ts` | Lazy loader for the napi-rs native validator binary with graceful AJV fallback |
| `errorRegistry.ts` | Error code lookup: `getErrorRegistry()`, `isRegisteredErrorCode()`, `getRegistryCode()`, `getTransportMapping()`, `getAgentAction()`, `getDocUrl()` |
| **Flags and Format Resolution** | |
| `flagSemantics.ts` | Single-layer format resolver (section 5.1-5.3): `resolveOutputFormat()`, `LAFSFlagError`, precedence: explicit flag > project config > user config > TTY detection > default (json) |
| `flagResolver.ts` | Unified cross-layer flag resolver (section 5.4): composes format + field extraction, validates cross-layer interactions |
| `fieldExtraction.ts` | `--field` / `--fields` / `--mvi` resolution (section 9.2): `resolveFieldExtraction()`, conflict detection |
| **MVI and Token Management** | |
| `mviProjection.ts` | MVI-aware envelope projection: strips fields based on declared MVI level to reduce token cost (minimal ~38 tokens vs full ~162) |
| `tokenEstimator.ts` | Character-based token estimation (1 token ~ 4 chars) with Unicode grapheme support and circular reference detection |
| `budgetEnforcement.ts` | Middleware for enforcing MVI token budgets: budget checking, truncation, `E_MVI_BUDGET_EXCEEDED` error generation |
| **Conformance and Compliance** | |
| `conformance.ts` | Conformance test runners: `runEnvelopeConformance()`, `runFlagConformance()` with tiered profiles |
| `conformanceProfiles.ts` | Tiered conformance profiles (core/standard/complete): `getConformanceProfiles()`, `getChecksForTier()` |
| `compliance.ts` | Multi-stage compliance pipeline: schema > envelope > flags > format, `enforceCompliance()` |
| `deprecationRegistry.ts` | Deprecation detector: `detectDeprecatedEnvelopeFields()`, `getDeprecationRegistry()` |
| **Interoperability** | |
| `problemDetails.ts` | RFC 9457 Problem Details bridge: `lafsErrorToProblemDetails()`, converts LAFSError to RFC 9457 objects |
| `discovery.ts` | Express middleware for A2A Agent Card at `/.well-known/agent-card.json` with `autoIncludeLafsExtension`, backward compat with `/.well-known/lafs.json` |
| `cli.ts` | CLI entry point (`lafs-conformance` binary) |
| **Operations and Reliability** | |
| `health/index.ts` | Health check middleware for Express: `healthCheck()`, aggregated `HealthStatus` with custom check functions |
| `shutdown/index.ts` | Graceful shutdown handler: `gracefulShutdown()`, connection draining, configurable timeout and signal handling |
| `circuit-breaker/index.ts` | Circuit breaker pattern: `CircuitBreaker` class with CLOSED/OPEN/HALF_OPEN states, configurable thresholds |
| **A2A Integration** | |
| `a2a/index.ts` | Barrel export for all A2A modules |
| `a2a/bridge.ts` | A2A SDK integration: `LafsA2AResult`, `createLafsArtifact()`, `createTextArtifact()`, `createFileArtifact()`, extension helpers |
| `a2a/extensions.ts` | Extension negotiation: `negotiateExtensions()`, `buildLafsExtension()`, Express middleware, `ExtensionSupportRequiredError` |
| `a2a/task-lifecycle.ts` | Task state machine: `TaskManager`, `VALID_TRANSITIONS`, `TERMINAL_STATES`, `attachLafsEnvelope()`, `InvalidStateTransitionError` |
| `a2a/streaming.ts` | Streaming/async primitives: `TaskEventBus`, `PushNotificationConfigStore`, `PushNotificationDispatcher`, `TaskArtifactAssembler`, `streamTaskEvents()` |
| `a2a/bindings/jsonrpc.ts` | JSON-RPC method constants, A2A error codes (-32001 to -32009), request/response builders |
| `a2a/bindings/http.ts` | HTTP endpoints, status codes, RFC 9457 Problem Details, URL building |
| `a2a/bindings/grpc.ts` | gRPC status codes, error reasons, service method definitions (types only, no runtime dep) |
| `a2a/bindings/index.ts` | Barrel export + `getErrorCodeMapping()` cross-binding error mapping |

### Export Structure (package.json `exports`)

| Subpath | Maps to |
|---------|---------|
| `.` | `src/index.ts` (all modules) |
| `./discovery` | `src/discovery.ts` |
| `./a2a` | `src/a2a/index.ts` |
| `./a2a/bindings` | `src/a2a/bindings/index.ts` |
| `./schemas/v1/*` | Direct JSON schema access |

### Key Protocol Invariants

- JSON output is the default; human-readable requires explicit `--human` opt-in
- `--human` and `--json` together MUST fail with `E_FORMAT_CONFLICT`
- `success=true` implies `error` is null or absent; `success=false` implies `result` is null by default
- Error envelopes MAY include a non-null `result` (e.g. validation tools returning actionable data alongside error metadata)
- The `error` field is optional on `LAFSEnvelope` (`error?: LAFSError | null`)
- Error codes are stable within major versions
- MVI levels: `minimal`, `standard`, `full`, `custom`
- Agent actions: `retry`, `retry_modified`, `escalate`, `stop`, `wait`, `refresh_context`, `authenticate`
- Pagination modes: `cursor`, `offset`, `none`

### Conformance Tiers

| Tier | Checks |
|------|--------|
| `core` | `envelope_schema_valid`, `envelope_invariants`, `error_code_registered` |
| `standard` | core + `agent_action_valid`, `error_registry_agent_action`, `transport_mapping_consistent`, `meta_mvi_present`, `meta_strict_present`, `strict_mode_behavior`, `pagination_mode_consistent`, `strict_mode_enforced` |
| `complete` | standard + `context_mutation_failure`, `context_preservation_valid` |

### Build Configuration

- ESM-only (`"type": "module"`)
- Target: ES2022, Module: NodeNext, moduleResolution: NodeNext
- Strict mode with `noUncheckedIndexedAccess`
- `tsconfig.build.json` extends `tsconfig.json`, excludes tests and examples, includes `schemas/**/*.json`
- `prepack` hook auto-builds before `npm publish`
- npm publish uses Sigstore provenance (`--provenance` flag in CI)

### Dependencies

- **Runtime**: `ajv`, `ajv-formats` (schema validation fallback when native binding unavailable), `@a2a-js/sdk` (A2A protocol), `express` (middleware)
- **Native (optional)**: `lafs-napi` Rust crate provides native schema validation via napi-rs. Built with `cargo build --release -p lafs-napi`. The TypeScript layer falls back to AJV when the binary isn't present.
- **Dev**: `typescript`, `vitest`, `tsx`, `supertest`, `@types/node`, `@types/express`, `@types/supertest`

## Tests

20 test files in `tests/`:
`a2aBridge`, `agentAction`, `bindings`, `budgetEnforcement`, `compliance`, `conformanceProfiles`, `deprecationMigration`, `discovery`, `envelope`, `envelopeApi`, `extensions`, `fieldExtraction`, `flag-resolver`, `flags`, `mviProjection`, `problemDetails`, `streamingAsync`, `structuredValidation`, `task-lifecycle`

## CI

GitHub Actions runs on push to main and PRs: typecheck -> test -> build. Release workflow triggers on `v*` tags and publishes to npm with provenance attestation.
