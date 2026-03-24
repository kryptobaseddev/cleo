<!-- CAAMP:START -->
@AGENTS.md
<!-- CAAMP:END -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- CLEO:START -->
@.cleo/templates/AGENT-INJECTION.md
<!-- CLEO:END -->

## Project Overview

LAFS (LLM-Agent-First Specification) is a language-neutral protocol for software systems whose primary consumer is an LLM agent. This repository provides the canonical spec (`lafs.md`), versioned JSON schemas, and TypeScript-first reference tooling for validation and conformance testing.

Published as `@cleocode/lafs` on npm.

## Commands

```bash
npm run build          # Clean build: rm -rf dist && tsc -p tsconfig.build.json
npm run typecheck      # Type-check without emitting
npm test               # Run all tests (vitest run)
npm run conformance -- --envelope fixtures/valid-success-envelope.json --flags fixtures/flags-valid.json
```

Run a single test file:
```bash
npx vitest run tests/envelope.test.ts
```

## Architecture

### Protocol Layer (language-agnostic)

- `lafs.md` - Canonical protocol specification using RFC 2119 keywords
- `schemas/v1/envelope.schema.json` - JSON Schema (Draft-07) for the response envelope
- `schemas/v1/error-registry.json` - Standard error codes with HTTP/gRPC/CLI exit code mappings
- `fixtures/` - Valid and invalid example payloads for testing

### TypeScript Toolkit (`src/`)

All modules are re-exported from `src/index.ts`:

| Module | Purpose |
|--------|---------|
| `types.ts` | Core types: `LAFSEnvelope`, `LAFSError`, `LAFSMeta`, `LAFSTransport`, `LAFSErrorCategory` |
| `validateEnvelope.ts` | AJV-based schema validation (`validateEnvelope()`, `assertEnvelope()`) |
| `errorRegistry.ts` | Error code lookup (`getErrorRegistry()`, `isRegisteredErrorCode()`) |
| `flagSemantics.ts` | Output format resolution with precedence: explicit flag > project config > user config > default (json) |
| `conformance.ts` | Conformance test runners for envelopes and flags |
| `cli.ts` | CLI entry point (`lafs-conformance` binary) |
| `discovery.ts` | Express middleware for A2A Agent Card at `/.well-known/agent-card.json` with `autoIncludeLafsExtension` option |
| `a2a/bridge.ts` | A2A SDK integration: `LafsA2AResult`, `createLafsArtifact()`, extension helpers |
| `a2a/extensions.ts` | Extension negotiation (`negotiateExtensions()`), `buildLafsExtension()`, Express middleware, `ExtensionSupportRequiredError` |
| `a2a/task-lifecycle.ts` | Task state machine (`TaskManager`), state constants, `attachLafsEnvelope()` |
| `a2a/bindings/jsonrpc.ts` | JSON-RPC method constants, A2A error codes (-32001 to -32009), request/response builders |
| `a2a/bindings/http.ts` | HTTP endpoints, status codes, RFC 9457 Problem Details, URL building |
| `a2a/bindings/grpc.ts` | gRPC status codes, error reasons, service method definitions (types only, no runtime dep) |
| `a2a/bindings/index.ts` | Barrel export + `getErrorCodeMapping()` cross-binding error mapping |

### Key Protocol Invariants

- JSON output is the default; human-readable requires explicit `--human` opt-in
- `--human` and `--json` together MUST fail with `E_FORMAT_CONFLICT`
- Exactly one of `result` or `error` MUST be non-null in every envelope
- `success=true` implies `error=null`; `success=false` implies `result=null`
- Error codes are stable within major versions

### Build Configuration

- ESM-only (`"type": "module"`)
- Target: ES2022, Module: NodeNext, strict mode enabled
- `tsconfig.build.json` extends `tsconfig.json` but excludes tests
- `prepack` hook auto-builds before `npm publish`
- npm publish uses Sigstore provenance (`--provenance` flag in CI)

## CI

GitHub Actions runs on push to main and PRs: typecheck -> test -> build. Release workflow triggers on `v*` tags and publishes to npm with provenance attestation.
