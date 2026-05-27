# RCASD: T10400 SG-CLEO-SDK-API — Unified SDK API Specification

**Saga**: T10400 SG-CLEO-SDK-API  
**Tier**: 0 (impl) — Tier-0 North Star  
**Depends on**: T10343 SG-ENVELOPE-FIRST (doctrine)  
**Status**: Research → Consensus → Architecture Decision → Specification → Decomposition  
**Date**: 2026-05-27  
**Author**: Hermes Agent (decomposition subagent)

---

## RCASD Stage 1: RESEARCH — Current SDK API Surface Audit

### 1.1 Existing API Surface

CLEO currently has NO unified SDK API. The API surface is fragmented across four packages, consumed only through the CLI (`@cleocode/cleo`) or in-process SDK calls:

| Package | Role | LOC | Public exports |
|---------|------|-----|---------------|
| `@cleocode/contracts` | Zero-dep type contracts | ~2,242 lines (index.ts) | 30+ domain exports, 200+ operation types, DataAccessor interface |
| `@cleocode/lafs` | LAFS envelope protocol | ~110 lines (index.ts) | Envelope creation, validation, MVI projection, A2A bridge, operations gates |
| `@cleocode/core` | Business logic SDK | Large | Task/session/memory/orchestration/lifecycle engines |
| `@cleocode/cleo` | CLI thin wrapper | ~457 lines (daemon.ts) | citty command definitions, dispatch layer |

**Operations Registry** (`packages/contracts/src/dispatch/operations-registry.ts`, 8,722 lines):
- 26 canonical domains: tasks, orchestrate, focus, docs, session, memory, brain, daemon, doctor, release, agents, nexus, conduit, dialectic, intelligence, issues, lifecycle, llm, pipeline, playbook, research, sentient, skills, sticky, system, validate, worktree
- ~200 operation definitions with gateway classification (query/mutate), params, tiers, idempotency
- Operations gating: STATIC_GATE_TABLE covers only 3 operations (tasks.add, tasks.complete, tasks.show)

**Current Transport Model**:
- `LAFSTransport = 'cli' | 'http' | 'grpc' | 'sdk'` defined but only `cli` and `sdk` (in-process) are implemented
- NO HTTP/REST server, NO gRPC server — all dispatching is CLI-local or in-process
- LAFS envelope wraps all operations: `{ $schema, _meta, success, result, error, page, _extensions }`

### 1.2 What T10400 Must Deliver (from North Star)

1. **True Envelope SSoT** — derive from T10343 doctrine, formalize the LAFS envelope as THE canonical boundary for all inter-component communication
2. **RESTful API surface** — OpenAPI 3.2 specification covering all ~200 operations
3. **`@cleocode/cleo-sdk` client library** — typed TypeScript SDK wrapping the API
4. **CI gate** — `lint-envelope-compliance.mjs` enforcing envelope shape at CI time

### 1.3 Consumer Sagas (Why T10400 is Tier-0 blocking)

Every Tier-0 saga depends on T10400:
- **T10401 SG-HARNESS-DAEMON-IPC**: daemon consumes `orchestrate.ready`, `orchestrate.spawn`, `tasks.claim`, `tasks.complete` via SDK API
- **T10402 SG-COCKPIT-HARNESS**: Cockpit TUI consumes SDK API + daemon IPC
- **T10403 SG-GENKIT-MIDDLEWARE**: consumes SDK API for credential resolution
- **T10404 SG-CANT-RUNTIME-V2**: consumes SDK API for workflow dispatch
- **T10409 SG-VAULT-CORE**: vault API endpoints (T10417) served through SDK gateway
- **T10418 SG-AGENT-TOOL-REGISTRY**: self-discovering tool catalog via SDK
- **T10419 SG-CHANNELS**: 18 channel adapters consume SDK for session/delivery

### 1.4 Key Findings from ADR-089 (Daemon Native Dispatch)

ADR-089 identifies specific SDK API endpoints the daemon needs:
- **Consumes**: `orchestrate.ready`, `orchestrate.spawn`, `tasks.claim`, `tasks.complete`
- **Adds**: `daemon.start`, `daemon.stop`, `runs.history`, `runs.status`, `runs.reclaim`
- Transport: HTTPS control plane (axum+hyper+tokio-rustls) + Unix socket fallback + ZeroMQ data plane

### 1.5 Existing Gaps

1. No HTTP server exists — operations are CLI-only
2. No OpenAPI spec exists — operations registry is TypeScript-only
3. No SDK client package — consumers import `@cleocode/core` directly
4. No envelope compliance CI gate
5. Gate table covers only 3 of ~200 operations
6. No versioning/deprecation contract for the API surface
7. No structured error code registry beyond static gates
8. Vault API (T10417) has no spec yet

---

## RCASD Stage 2: CONSENSUS — Architecture Decisions

### Decision: T10400 Scope Boundary

**D-T10400-1**: T10400 owns the SPECIFICATION and the SDK CLIENT. It does NOT own the HTTP server implementation — that's T10401's responsibility. T10400 delivers:
- The OpenAPI 3.2 spec (the contract)
- The `@cleocode/cleo-sdk` TypeScript client (the consumer-side library)
- The CI compliance gate (the enforcement)
- The Vault API endpoints spec (T10417 child)

T10401 builds the HTTP gateway server that IMPLEMENTS the spec.

### Decision: Operations Scope

**D-T10400-2**: All ~200 operations in the OPERATIONS registry MUST be represented in the OpenAPI spec. No cherry-picking. The spec is the SSoT — if an operation isn't in the spec, it's deprecated.

### Decision: SDK Package Structure

**D-T10400-3**: `@cleocode/cleo-sdk` is a new package under `packages/cleo-sdk/`. It wraps `@cleocode/lafs` for envelope handling and provides typed method-per-operation access (e.g., `sdk.tasks.show(id)`, `sdk.orchestrate.ready(epicId)`). It does NOT re-implement core logic — it's a transport-agnostic typed client that current in-process consumers can adopt immediately, and future HTTP consumers can swap the transport layer.

---

## RCASD Stage 3: ARCHITECTURE DECISION — SDK API Architecture

### 3.1 Package Architecture

```
packages/cleo-sdk/           # NEW: @cleocode/cleo-sdk
├── src/
│   ├── index.ts             # Main entry — re-exports all domains
│   ├── client.ts            # CleoSdkClient class (transport-agnostic)
│   ├── transport/
│   │   ├── base.ts          # Transport interface (execute op → envelope)
│   │   ├── in-process.ts    # Direct core import (current path)
│   │   └── http.ts          # HTTP client (future — T10401 builds server)
│   ├── domains/
│   │   ├── tasks.ts         # tasks.* methods
│   │   ├── orchestrate.ts   # orchestrate.* methods
│   │   ├── focus.ts         # focus.* methods
│   │   ├── docs.ts          # docs.* methods
│   │   ├── session.ts       # session.* methods
│   │   ├── memory.ts        # memory.* methods
│   │   ├── brain.ts         # brain.* methods
│   │   ├── daemon.ts        # daemon.* methods (ADR-089 endpoints)
│   │   ├── vault.ts         # vault.* methods (T10417)
│   │   └── ...              # Remaining 17 domains
│   └── types/
│       ├── generated.ts     # Auto-generated from OpenAPI spec
│       └── manual.ts        # Hand-authored supplemental types
├── openapi/
│   └── cleo-sdk-api.openapi.yaml  # THE OpenAPI 3.2 spec (SSoT)
├── scripts/
│   └── lint-envelope-compliance.mjs  # CI gate
└── package.json
```

### 3.2 OpenAPI Spec Structure

The OpenAPI spec is organized by domain tag, mirroring the OPERATIONS registry:
- `paths: /tasks/show, /tasks/list, /tasks/find, ...`
- `paths: /orchestrate/ready, /orchestrate/spawn, ...`
- Common schema components for LAFSEnvelope, LAFSError, LAFSPage, etc.

### 3.3 Transport Interface

```typescript
interface SdkTransport {
  execute<T>(operation: string, params: Record<string, unknown>): Promise<LAFSEnvelope<T>>;
}
```

Two initial implementations:
- `InProcessTransport`: calls `@cleocode/core` directly (zero network overhead, backward compat)
- `HttpTransport`: HTTP client calling T10401's gateway (future, spec-compliant)

### 3.4 Vault API (T10417 child)

The vault API is a sub-domain of the SDK API served through the gateway. Endpoints:
- `vault.store` — Store a credential (AES-256-GCM encrypted)
- `vault.retrieve` — Retrieve and decrypt a credential
- `vault.list` — List stored credential aliases (keys never exposed)
- `vault.rotate` — Rotate a credential
- `vault.audit` — Audit log of credential access
- `vault.health` — Vault health check (unsealed, DB reachable)

---

## RCASD Stage 4: SPECIFICATION — Acceptance Criteria for T10400

**Epic AC (T10400 itself)**:
- AC1: OpenAPI 3.2 spec covers 100% of operations in the OPERATIONS registry
- AC2: `@cleocode/cleo-sdk` package ships with typed method-per-operation client
- AC3: `lint-envelope-compliance.mjs` CI gate passes on every PR
- AC4: All existing `@cleocode/core` in-process consumers can migrate to `@cleocode/cleo-sdk` with zero behavioral change
- AC5: LAFS envelope shape is the canonical SSoT — no deviation in any transport
- AC6: Vault API spec is complete (T10417 delivers T1805/T1807/T1813)
- AC7: ADR-089 daemon endpoints (daemon.start, runs.history, etc.) are spec'd
- AC8: SDK versioning contract is documented with semver policy

---

## RCASD Stage 5: DECOMPOSITION — 12 Child Tasks

### Wave 0 — Foundation (no deps, parallel-safe)

**T200 — Audit & Catalog All Operations**
- Kind: research
- Size: medium
- Depends: none
- AC1: Produce a complete inventory of all ~200 operations in the OPERATIONS registry
- AC2: For each operation, document: domain, gateway (query/mutate), params, return type, idempotency, tier, session requirement
- AC3: Flag operations with missing/incorrect param definitions
- AC4: Flag operations with no gate definitions
- AC5: Output: Markdown catalog at `docs/research/T10400-operations-catalog.md`
- Files: `packages/contracts/src/dispatch/operations-registry.ts` (source), `docs/research/T10400-operations-catalog.md` (output)

**T201 — Formalize LAFS Envelope SSoT from T10343 Doctrine**
- Kind: research
- Size: small
- Depends: none
- AC1: Derive canonical LAFS envelope shape from T10343 doctrine
- AC2: Document: required fields, optional fields, extension points, pagination modes
- AC3: Document: error categories, agent actions, retry semantics
- AC4: Document: MVI projection levels (minimal/standard/full/custom)
- AC5: Document: transport bindings (HTTP status codes, gRPC codes, CLI exit codes)
- AC6: Output: `docs/specs/T10400-lafs-envelope-ssot.md`
- Files: `packages/lafs/src/types.ts` (source), `docs/specs/T10400-lafs-envelope-ssot.md` (output)

**T202 — Error Code Registry Audit & Gap Fill**
- Kind: research
- Size: small
- Depends: none
- AC1: Audit `packages/lafs/src/errorRegistry.ts` for completeness
- AC2: Cross-reference with `STATIC_GATE_TABLE` — identify gaps
- AC3: Produce complete error code catalog covering all 10 LAFS error categories
- AC4: For each error code, document: code, category, retryable, retryAfterMs, agentAction, docUrl
- AC5: Flag error codes used in core but not registered in the error registry
- AC6: Output: `docs/specs/T10400-error-code-registry.md`
- Files: `packages/lafs/src/errorRegistry.ts`, `packages/lafs/src/operation-gates.ts`

### Wave 1 — Core Spec (depends on Wave 0)

**T203 — Author OpenAPI 3.2 Specification**
- Kind: specification
- Size: large
- Depends: T200, T201
- AC1: Produce `packages/cleo-sdk/openapi/cleo-sdk-api.openapi.yaml`
- AC2: All domains represented as tagged path groups
- AC3: Common schema components: LAFSEnvelope, LAFSMeta, LAFSError, LAFSPage, Warning, MVILevel
- AC4: Every operation from T200 catalog has a path entry with params, requestBody, responses
- AC5: HTTP status code mapping: success→200, validation→400, auth→401, not_found→404, conflict→409, internal→500, etc.
- AC6: Spec passes OpenAPI 3.2 validation (`swagger-cli validate` or equivalent)
- AC7: Pagination supported via query params (cursor/offset) and response page envelope
- Files: `packages/cleo-sdk/openapi/cleo-sdk-api.openapi.yaml`

**T204 — Create @cleocode/cleo-sdk Package Scaffold**
- Kind: implementation
- Size: medium
- Depends: T203
- AC1: New package at `packages/cleo-sdk/` with `package.json`, `tsconfig.json`, build config
- AC2: Package name: `@cleocode/cleo-sdk`, version: `0.1.0`
- AC3: Transport interface defined at `src/transport/base.ts`
- AC4: InProcessTransport at `src/transport/in-process.ts` — wraps `@cleocode/core` dispatch
- AC5: Main client class `CleoSdkClient` at `src/client.ts` accepting a transport
- AC6: Package builds with `tsc` and exports both CJS and ESM
- AC7: README with basic usage examples
- Files: `packages/cleo-sdk/` (new directory)

**T205 — Implement SDK Domain Methods (Wave A: tasks + orchestrate + focus + daemon)**
- Kind: implementation
- Size: large
- Depends: T204
- AC1: `sdk.tasks.*` methods: show, list, find, tree, current, next, create, update, complete, claim, release, slice, analyze, depends, blockers, context, plan (typed params/returns)
- AC2: `sdk.orchestrate.*` methods: status, next, ready, start, analyze, context, waves, plan, bootstrap
- AC3: `sdk.focus.*` method: focus(taskId) — single unified orientation call
- AC4: `sdk.daemon.*` methods: start, stop, status, install, uninstall (matching existing CLI daemon.ts)
- AC5: All methods return `Promise<LAFSEnvelope<T>>` 
- AC6: Each method JSDoc'd with parameter descriptions and example usage
- AC7: Unit tests for each domain module (≥80% coverage)
- Files: `packages/cleo-sdk/src/domains/tasks.ts`, `orchestrate.ts`, `focus.ts`, `daemon.ts`

**T206 — Implement SDK Domain Methods (Wave B: docs + session + memory + brain + remaining 17 domains)**
- Kind: implementation
- Size: large
- Depends: T204
- AC1: `sdk.docs.*` methods: add, fetch, update, publish, search, list, delete
- AC2: `sdk.session.*` methods: start, status, end, resume, list
- AC3: `sdk.memory.*` methods: observe, find, recall, search
- AC4: `sdk.brain.*` methods: query, graph, status, backup, recover
- AC5: Remaining 17 domains with typed methods (agents, nexus, conduit, dialectic, intelligence, issues, lifecycle, llm, pipeline, playbook, release, research, sentient, skills, system, validate, worktree)
- AC6: All methods return `Promise<LAFSEnvelope<T>>`
- AC7: Unit tests for each domain module (≥80% coverage)
- Files: `packages/cleo-sdk/src/domains/*.ts` (20+ domain files)

### Wave 2 — Vault + Daemon + CI (depends on Wave 1)

**T207 — T10417 Vault API Specification & SDK Methods (parent: T10400)**
- Kind: specification + implementation
- Size: medium
- Depends: T203, T204
- AC1: Vault API OpenAPI paths: `POST /vault/store`, `GET /vault/retrieve`, `GET /vault/list`, `POST /vault/rotate`, `GET /vault/audit`, `GET /vault/health`
- AC2: Credential schema: `{ alias, provider, encrypted_value, created_at, rotated_at, metadata }`
- AC3: JWT Proxy-Authorization header documented (per T10409 AC7)
- AC4: `sdk.vault.*` methods implemented in cleo-sdk
- AC5: Vault methods NEVER return decrypted values — decryption happens at gateway layer
- AC6: Vault audit log schema: `{ timestamp, operation, alias, success, source_ip }`
- Files: `packages/cleo-sdk/openapi/cleo-sdk-api.openapi.yaml` (add vault paths), `packages/cleo-sdk/src/domains/vault.ts`

**T208 — Daemon API Endpoints per ADR-089**
- Kind: specification + implementation
- Size: medium
- Depends: T203, T204
- AC1: OpenAPI paths: `POST /daemon/start`, `POST /daemon/stop`, `GET /daemon/status`, `GET /runs/history`, `GET /runs/status`, `POST /runs/reclaim`
- AC2: Daemon status response: `{ pid, mode, uptime, activeRuns, completedRuns, failedRuns, nextTick }`
- AC3: Runs history response: paginated list of `{ runId, taskId, status, startedAt, completedAt, exitCode, worktreePath }`
- AC4: Runs reclaim response: `{ reclaimedRunIds[], freedBytes }`
- AC5: `sdk.daemon.*` extended with ADR-089 endpoints
- AC6: All daemon endpoints documented as requiring daemon to be running (503 when stopped)
- Files: `packages/cleo-sdk/openapi/cleo-sdk-api.openapi.yaml` (add runs paths), `packages/cleo-sdk/src/domains/daemon.ts`

**T209 — Implement lint-envelope-compliance.mjs CI Gate**
- Kind: implementation
- Size: small
- Depends: T203
- AC1: Script at `packages/cleo-sdk/scripts/lint-envelope-compliance.mjs`
- AC2: Validates all LAFSEnvelope responses against OpenAPI spec
- AC3: Checks: `$schema` presence, `_meta` required fields, `success` boolean, `result`/`error` mutual exclusion
- AC4: Checks error categories map to valid `LAFSErrorCategory` values
- AC5: Checks agent actions map to valid `LAFSAgentAction` values
- AC6: CI integration: runs on every PR touching `packages/cleo-sdk/` or `packages/core/`
- AC7: Output: human-readable violation report with file:line references
- Files: `packages/cleo-sdk/scripts/lint-envelope-compliance.mjs`

### Wave 3 — Integration & Polish (depends on Wave 2)

**T210 — Migration: Port cleo CLI to @cleocode/cleo-sdk**
- Kind: implementation
- Size: medium
- Depends: T205, T206
- AC1: `@cleocode/cleo` imports from `@cleocode/cleo-sdk` instead of `@cleocode/core` for all operations
- AC2: CLI behavior unchanged — all existing tests pass
- AC3: InProcessTransport used initially (HTTP transport when T10401 ships)
- AC4: Remove dead code paths where core was imported directly for dispatch
- AC5: CI: full test suite passes with no regressions
- Files: `packages/cleo/src/**/*.ts`

**T211 — SDK Versioning, Compatibility Contract & CHANGELOG**
- Kind: specification
- Size: small
- Depends: T203
- AC1: `packages/cleo-sdk/VERSIONING.md` — semver policy for SDK
- AC2: Document what constitutes MAJOR (envelope shape change), MINOR (new operations/domains), PATCH (bug fixes)
- AC3: Deprecation lifecycle: `@deprecated` JSDoc → W_DEPRECATED warning in envelope → removal after 2 minor versions
- AC4: OpenAPI spec `info.version` tracks SDK version
- AC5: CHANGELOG.md initialized
- Files: `packages/cleo-sdk/VERSIONING.md`, `packages/cleo-sdk/CHANGELOG.md`

**T212 — SDK Integration Tests & Developer Documentation**
- Kind: testing + documentation
- Size: medium
- Depends: T205, T206, T207, T208
- AC1: Integration test suite at `packages/cleo-sdk/tests/` covering full workflow: create task → orchestrate → complete → verify
- AC2: Tests for InProcessTransport (round-trip with real `@cleocode/core`)
- AC3: Tests for error handling: every LAFS error category triggered and verified
- AC4: Tests for pagination: cursor and offset modes
- AC5: Developer guide at `packages/cleo-sdk/DEVELOPER.md` — setup, usage, domain reference
- AC6: Migration guide: porting from direct `@cleocode/core` imports to `@cleocode/cleo-sdk`
- AC7: `README.md` comprehensive with: install, quick start, all domain examples, error handling, transport selection
- Files: `packages/cleo-sdk/tests/`, `packages/cleo-sdk/DEVELOPER.md`, `packages/cleo-sdk/README.md`

---

## Wave Dependency Graph

```
Wave 0 (parallel):
  T200 (audit ops) ──┐
  T201 (envelope SSoT)┼── no deps, all parallel
  T202 (error registry)┘

Wave 1 (parallel pairs):
  T203 (OpenAPI spec) ← depends: T200, T201
  T204 (SDK scaffold) ← depends: T203
  T205 (SDK domains A) ← depends: T204
  T206 (SDK domains B) ← depends: T204  [parallel with T205]

Wave 2:
  T207 (vault API) ← depends: T203, T204
  T208 (daemon endpoints) ← depends: T203, T204  [parallel with T207]
  T209 (CI gate) ← depends: T203                [parallel with T207, T208]

Wave 3:
  T210 (CLI migration) ← depends: T205, T206
  T211 (versioning) ← depends: T203
  T212 (tests + docs) ← depends: T205, T206, T207, T208
```

**Total**: 12 child tasks across 4 waves (6+6 parallelizable across waves).

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| T10343 not ratified | T10400 blocked — doctrine is prerequisite | T10343 is "NEXT" in sequencing; ensure it completes first |
| Operations registry drift | OpenAPI spec goes stale if ops change | CI gate `lint-envelope-compliance.mjs` catches drift; spec regeneration script |
| HTTP server not yet built (T10401) | HttpTransport has nothing to call | InProcessTransport is the MVP; HttpTransport is future work scoped to T10401 |
| Vault API coupling with T10409 | Vault endpoints need gateway to exist | T10417 is spec-only until T10409 ships; SDK methods are client-side stubs first |
| 200+ operations is high surface area | Spec becomes unwieldy | Organize by domain tag; auto-generate from OPERATIONS registry where possible |

---

## Open Questions

1. **Should the OpenAPI spec be auto-generated from the OPERATIONS registry (TypeScript → YAML), or hand-authored?** Auto-generation ensures no drift but requires a codegen tool. Hand-authoring gives more control but risks staleness. Recommendation: auto-generate with manual override for descriptions/examples.

2. **Should `@cleocode/cleo-sdk` replace `@cleocode/lafs` or wrap it?** Recommendation: wrap it. `@cleocode/lafs` remains the protocol library (envelope creation, validation). `@cleocode/cleo-sdk` adds the typed per-operation client on top.

3. **What transport does `cleo daemon serve` use today?** Currently CLI-only (no HTTP server). The daemon's `daemon.start` operation is dispatched in-process. ADR-089 proposes the HTTP gateway, which T10401 builds.

---

*RCASD Stage 5 (Decomposition) complete. Next: create child tasks via `cleo add-batch`.*
