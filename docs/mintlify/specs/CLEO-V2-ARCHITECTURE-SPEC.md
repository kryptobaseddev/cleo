---
title: "CLEO V2 Architecture Specification"
version: "1.0.0"
status: "draft"
created: "2026-02-13"
updated: "2026-02-13"
epic: "T4454"
authors: ["CLEO Development Team"]
supersedes: ["CLEO-MIGRATION-DOCTRINE.md (partially)"]
---

> **Note**: This document is a supporting reference under `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md`. For canonical strategic direction, see the Canonical Plan. This document provides detailed V2 technical architecture and LAFS conformance requirements.

# CLEO V2 Architecture Specification

**Version**: 1.0.0
**Status**: DRAFT
**Date**: 2026-02-13
**Epic**: T4454 - EPIC: CLEO V2 Full TypeScript System (LAFS-native)
**Authority**: This document defines the end-to-end architecture for CLEO V2. Global canonical strategy and decision authority are maintained in `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md`.

## Canonical Docs Index (2026-02-13)

Use this index to avoid split authority:

| Document | Path | Canonical Role |
|----------|------|----------------|
| Canonical Plan and Decision Spec | `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md` | Single source of truth for strategy, decision state, and execution alignment |
| V2 Architecture Spec (this document) | `docs/specs/CLEO-V2-ARCHITECTURE-SPEC.md` | End-to-end V2 architecture and technical design |
| Migration Doctrine | `docs/specs/CLEO-MIGRATION-DOCTRINE.md` | Migration detail, convergence criteria, engine inventory |
| Strategic Roadmap | `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` | Phase model, evidence gates, metrics, risk/rollback governance |
| Architecture Decisions (ADR D1-D6) | `claudedocs/CLEO-V2-ARCHITECTURE-DECISIONS.md` | Decision rationale and historical tradeoff record |

Conflict resolution order:

1. `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md`
2. `docs/specs/CLEO-V2-ARCHITECTURE-SPEC.md` and `docs/specs/CLEO-MIGRATION-DOCTRINE.md`
3. `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` and `claudedocs/CLEO-V2-ARCHITECTURE-DECISIONS.md`

---

## 1. Executive Summary

CLEO V2 is the full TypeScript rewrite of CLEO's 133K LOC Bash system, running two parallel tracks to convergence:

- **Track MCP**: Expand the native TypeScript engine from 29 to 123 operations within the existing MCP server
- **Track CLI**: Ungate T2021 and build a complete Commander.js CLI with LAFS-compliant output

Both tracks share a common TypeScript core (`src/core/`). When both reach parity, they converge into a single system where CLI and MCP are thin wrappers over the same engine.

**LAFS (LLM-Agent-First Specification)** is baked in from day one -- every command returns a LAFS-compliant envelope, error codes map to the LAFS error taxonomy, and output is machine-readable by default with human-readable opt-in.

**CAAMP (@cleocode/caamp v0.3.0)** is the canonical package manager for skills, MCP servers, and agent instructions.

---

## 2. System Architecture (LAFS-Native)

### 2.1 LAFS Conformance Target

CLEO V2 targets **L2 conformance** with the LAFS protocol:

| Level | Requirements | CLEO V2 Status |
|-------|-------------|----------------|
| **L0** | Structured JSON output | Already met (v0.91.0 MCP engine) |
| **L1** | Canonical envelope schema, error contract | Target for Phase 1 |
| **L2** | Full envelope conformance, flag resolution, error registry, MVI | Target for Phase 2-3 |
| **L3** | Pagination, strict mode, transport negotiation | Future (Phase 4+) |

### 2.2 Canonical Response Envelope

Every CLEO V2 command MUST return a LAFS-compliant envelope:

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-13T00:00:00Z",
    "operation": "tasks.show",
    "requestId": "req_abc123",
    "transport": "cli",
    "strict": true,
    "mvi": true,
    "contextVersion": 0
  },
  "success": true,
  "result": { },
  "error": null,
  "page": null
}
```

**Envelope Invariants** (RFC 2119):

- Every response MUST conform to `envelope.schema.json`
- Exactly one of `result` or `error` MUST be non-null
- `success=true` implies `error=null`
- `success=false` implies `result=null`
- Unknown fields SHOULD be rejected when strict mode is enabled
- The `_meta.mvi` field MUST be present (Machine-Verifiable Indicator)

### 2.3 Error Model: LAFS Error Codes + CLEO Exit Codes

CLEO V2 maps its 72 exit codes to the LAFS error taxonomy:

```typescript
// LAFS error contract
interface LAFSError {
  code: string;           // E_VALIDATION_SCHEMA, E_NOT_FOUND_RESOURCE, etc.
  message: string;        // Human-readable description
  category: ErrorCategory; // VALIDATION, NOT_FOUND, CONFLICT, INTERNAL, RATE_LIMIT
  retryable: boolean;
  retryAfterMs: number | null;
  details: Record<string, unknown>;
}

// CLEO exit code to LAFS mapping
const EXIT_TO_LAFS: Record<number, string> = {
  0:   'SUCCESS',
  1:   'E_INTERNAL',
  2:   'E_VALIDATION_INPUT',
  3:   'E_IO_FILE',
  4:   'E_NOT_FOUND_RESOURCE',
  5:   'E_DEPENDENCY_MISSING',
  6:   'E_VALIDATION_SCHEMA',
  7:   'E_LOCK_TIMEOUT',
  8:   'E_CONFIG_INVALID',
  10:  'E_NOT_FOUND_PARENT',
  11:  'E_VALIDATION_DEPTH',
  12:  'E_VALIDATION_SIBLING_LIMIT',
  // ... (full mapping in src/core/exit-codes.ts)
  20:  'E_CONFLICT_CHECKSUM',
  21:  'E_CONFLICT_CONCURRENT',
  30:  'E_CONFLICT_SESSION',
  38:  'E_ACTIVE_TASK_REQUIRED',
  60:  'E_PROTOCOL_RESEARCH',
  61:  'E_PROTOCOL_CONSENSUS',
  62:  'E_PROTOCOL_SPECIFICATION',
  63:  'E_PROTOCOL_DECOMPOSITION',
  64:  'E_PROTOCOL_IMPLEMENTATION',
  65:  'E_PROTOCOL_CONTRIBUTION',
  66:  'E_PROTOCOL_RELEASE',
  67:  'E_PROTOCOL_GENERIC',
  75:  'E_LIFECYCLE_GATE_FAILED',
  100: 'E_NO_DATA',
  101: 'E_ALREADY_EXISTS',
  102: 'E_NO_CHANGE',
};
```

Each LAFS error code maps to transport-specific codes:

| LAFS Code | HTTP Status | gRPC Status | CLI Exit |
|-----------|-------------|-------------|----------|
| E_VALIDATION_SCHEMA | 400 | INVALID_ARGUMENT | 6 |
| E_NOT_FOUND_RESOURCE | 404 | NOT_FOUND | 4 |
| E_CONFLICT_CONCURRENT | 409 | ABORTED | 21 |
| E_LOCK_TIMEOUT | 423 | UNAVAILABLE | 7 |
| E_PROTOCOL_RESEARCH | 422 | FAILED_PRECONDITION | 60 |
| E_LIFECYCLE_GATE_FAILED | 428 | FAILED_PRECONDITION | 75 |

### 2.4 Transport Layer

CLEO V2 is transport-agnostic. The same semantic contract applies across all transports:

```
                    ┌─────────────────────────────────────────┐
                    │           Shared TypeScript Core         │
                    │                                         │
                    │   src/core/  (engine, validation, store) │
                    └───────┬──────────┬──────────┬───────────┘
                            │          │          │
                    ┌───────▼──┐ ┌─────▼────┐ ┌──▼──────────┐
                    │ CLI      │ │ MCP      │ │ HTTP        │
                    │ Transport│ │ Transport│ │ Transport   │
                    │          │ │          │ │             │
                    │Commander │ │ FastMCP  │ │ Express/    │
                    │.js       │ │ stdio    │ │ Fastify     │
                    └──────────┘ └──────────┘ └─────────────┘
                     (Phase 1)   (Existing)    (Future)
```

| Transport | Protocol | Status | Use Case |
|-----------|----------|--------|----------|
| **CLI** | Commander.js, stdout/stderr | Phase 1 (T2021 ungated) | Developer terminal usage |
| **MCP** | FastMCP, stdio | Existing (v0.91.0) | AI agent integration (Claude Code, Cursor) |
| **HTTP** | REST/StreamableHTTP | Future (Phase 4+) | Remote access, web UI, team coordination |

### 2.5 Progressive Disclosure for Agents (L0-L3)

Agents interact with CLEO at varying sophistication levels:

| Level | Agent Capability | CLEO Response Style |
|-------|-----------------|-------------------|
| **L0** | Basic JSON parsing | Flat JSON, minimal nesting |
| **L1** | Envelope-aware | Full LAFS envelope with _meta |
| **L2** | Error-handling, retry | Error codes with retryable hints, fix suggestions |
| **L3** | Pagination, streaming | Cursor-based pagination, SSE for long-running ops |

The `_meta.contextVersion` field enables progressive response evolution without breaking existing consumers.

---

## 3. Dual-Track Execution Plan

### 3.1 Track Overview

```
          Track CLI (T2021 Ungated)              Track MCP (T4334 Expansion)
          ═══════════════════════               ══════════════════════════

Phase 1   ┌─────────────────────┐               (already at 29 ops)
(Found.)  │ Project structure   │
          │ Core types + LAFS   │
          │ Atomic file ops     │
          │ Config engine       │
          └─────────┬───────────┘
                    │
Phase 2   ┌─────────▼───────────┐   ┌──────────────────────────┐
(Core)    │ add/list/show/find  │   │ orchestrate domain       │
          │ complete/update/del │   │ research domain          │
          │ focus commands      │   │ lifecycle domain         │
          │ session management  │   │ release domain           │
          └─────────┬───────────┘   │ validate domain          │
                    │               └──────────┬───────────────┘
Phase 3   ┌─────────▼───────────┐              │
(Parity)  │ phases + deps graph │              │
          │ research + manifest │              │
          │ orchestration       │              │
          │ lifecycle + release │              │
          │ migration system    │              │
          └─────────┬───────────┘              │
                    │                          │
Phase 4   ┌─────────▼──────────────────────────▼──┐
(Integ.)  │ LAFS conformance certification        │
          │ CAAMP full API (88 exports)            │
          │ Cross-platform CI matrix               │
          │ Documentation + deprecation plan       │
          └─────────┬─────────────────────────────┘
                    │
          ┌─────────▼───────────────────────────────┐
          │            CONVERGENCE                    │
          │  CLI + MCP = thin wrappers over          │
          │  shared TypeScript core                   │
          │  Bash CLI → maintenance/deprecation       │
          └───────────────────────────────────────────┘
```

### 3.2 Track MCP: Expand Native Engine (29 to ~130 Operations)

**Current State**: 29 native + 1 hybrid out of ~130 total operations across 8 domains.

**Expansion Priority** (high-frequency operations first):

| Domain | Current Native | Target Native | Priority |
|--------|---------------|---------------|----------|
| **Tasks (query)** | 6 | 18 | Done (core), expand analytics |
| **Tasks (mutate)** | 6 | 14 | Done (core), expand reorder/reparent |
| **Session** | 8 (query) + 6 (mutate) | 8 + 12 | Expand resume, archive, cleanup |
| **Orchestrate** | 0 | 14 | HIGH -- critical for agent coordination |
| **Research** | 0 | 12 | HIGH -- critical for manifest ops |
| **Lifecycle** | 0 | 10 | MEDIUM -- RCASD-IVTR+C pipeline tracking |
| **Release** | 0 | 7 | MEDIUM -- release automation |
| **Validate** | 1 | 11 | MEDIUM -- extend beyond schema |
| **System** | 5 + 1 hybrid | 25+ | LOW -- many are informational |

**Dependency**: P3 golden parity tests (T4338) MUST pass before new native operations are shipped to auto-mode users.

**Tasks**: T4474, T4475, T4476, T4477, T4478

### 3.3 Track CLI: Full TypeScript Rewrite (T2021 Ungated)

T2021 is now **ungated**. The T2112 (Bash stabilization) gate is removed for CLI track work because:

1. The MCP-first track has proven TypeScript viability (29 native ops, cross-platform)
2. The shared core strategy means CLI work directly benefits MCP and vice versa
3. LAFS adoption requires consistent output format across all transports -- this is most efficiently achieved with a shared TypeScript core

**Module Structure**:

```
src/
├── commands/           # Commander.js command definitions
│   ├── task/           #   add, list, show, find, complete, update, delete, archive
│   ├── session/        #   start, end, status, resume, list
│   ├── focus/          #   set, show, clear, history
│   ├── phase/          #   set, show, advance, list
│   ├── research/       #   init, list, show, inject, link
│   ├── orchestrate/    #   status, next, ready, analyze, spawn
│   ├── lifecycle/      #   check, status, gates, skip, reset
│   ├── release/        #   create, plan, ship, changelog
│   └── system/         #   version, config, init, doctor, dash
├── core/               # Shared business logic (used by CLI AND MCP)
│   ├── task-engine.ts
│   ├── session-engine.ts
│   ├── config-engine.ts
│   ├── init-engine.ts
│   ├── orchestrate-engine.ts
│   ├── research-engine.ts
│   ├── lifecycle-engine.ts
│   ├── release-engine.ts
│   └── validate-engine.ts
├── types/              # TypeScript type definitions
│   ├── task.ts
│   ├── session.ts
│   ├── config.ts
│   ├── lafs.ts         # LAFS envelope, error contract types
│   └── exit-codes.ts   # 72 exit codes enum
├── schemas/            # JSON Schema files (reused from Bash)
│   ├── todo.schema.json
│   ├── config.schema.json
│   └── research-manifest.schema.json
├── store/              # Data access layer
│   ├── file-store.ts   # Atomic JSON file I/O
│   ├── lock.ts         # File locking (proper-lockfile)
│   └── backup.ts       # Backup rotation
├── validation/         # Validation layers
│   ├── schema.ts       # Ajv JSON Schema validation
│   ├── rules.ts        # Anti-hallucination semantic rules
│   ├── protocol.ts     # Protocol enforcement (exit 60-67)
│   └── lafs.ts         # LAFS envelope/flag conformance
├── output/             # Output formatting
│   ├── envelope.ts     # LAFS envelope builder
│   ├── formatter.ts    # JSON/human output switching
│   └── error.ts        # Error formatting with fix suggestions
└── index.ts            # CLI entry point (Commander.js)
```

**Phase Breakdown**:

| Phase | Scope | Tasks | Dependencies |
|-------|-------|-------|-------------|
| **P1: Foundation** | Project structure, types, file ops, config | T4455-T4458 | None (starting point) |
| **P2: Core Commands** | add/list/show/find, complete/update/delete, focus, sessions | T4460-T4463 | P1 complete |
| **P3: Feature Parity** | phases, deps, research, orchestration, lifecycle, release, migration | T4464-T4468 | P2 complete |
| **P4: Integration** | LAFS certification, CAAMP, CI, docs | T4469-T4472 | P3 complete |

---

## 4. CAAMP Integration Architecture

### 4.1 CAAMP as Canonical Package Manager

CAAMP (@cleocode/caamp v0.3.0) serves three roles in CLEO V2:

| Role | Description | API Surface |
|------|-------------|-------------|
| **Skills** | Discovery, installation, version management of CLEO skills | `installSkill`, `removeSkill`, `listSkills`, `getSkillManifest` |
| **MCP Servers** | Provider registry (46 providers), config generation, server management | `installMcpServer`, `removeMcpServer`, `mcpList`, `mcpListAll`, `mcpConfigPath` |
| **Agent Instructions** | CLAUDE.md, AGENTS.md, GEMINI.md injection and update | `injectionCheck`, `injectionUpdate`, `generateInjectionContent`, `getInstructionFiles` |

### 4.2 Current Adapter (17 exports)

The existing `caamp-adapter.ts` in the MCP server provides 17 exports:

```typescript
// Provider registry (6)
providerList, providerGet, providerDetect, providerInstalled, providerCount, registryVersion

// MCP server management (5)
mcpList, mcpListAll, mcpInstall, mcpRemove, mcpConfigPath

// Instruction injection (4)
injectionCheck, injectionCheckAll, injectionUpdate, injectionUpdateAll

// Utility (2)
caampResolveAlias, caampBuildServerConfig
```

### 4.3 Target: Full API Coverage (88 exports)

V2 expands to the full CAAMP API surface:

| Category | Current | Target | Key Additions |
|----------|---------|--------|---------------|
| Provider Registry | 6 | 15 | Tier filtering, batch detection, format support queries |
| MCP Server Mgmt | 5 | 20 | Batch install with rollback, config migration, scope management |
| Skill Lifecycle | 0 | 18 | Install, remove, list, manifest, version, dependency resolution |
| Instruction Injection | 4 | 12 | Per-provider injection, template generation, diff preview |
| Advanced Batch | 0 | 8 | `installBatchWithRollback`, tier-filtered operations |
| Configuration | 2 | 15 | Config read/write per provider, format-specific transforms |

### 4.4 Native Engine + CAAMP Adapter Pattern

```
┌───────────────────────────────────────────────┐
│  CLEO V2 TypeScript Core                       │
│                                                │
│  src/core/caamp-integration.ts                 │
│    ├── imports from @cleocode/caamp            │
│    ├── wraps CAAMP API with LAFS envelopes     │
│    └── error mapping: CAAMP errors → LAFS codes│
│                                                │
│  Adapter Pattern:                              │
│    CAAMP native API  →  CLEO wrapper  →  LAFS  │
│                                                │
└─────────────┬─────────────┬───────────────────┘
              │             │
      ┌───────▼──────┐ ┌───▼──────────┐
      │ CLI Command  │ │ MCP Domain   │
      │ cleo caamp   │ │ providers    │
      │ cleo skills  │ │ domain       │
      └──────────────┘ └──────────────┘
```

---

## 5. LAFS Conformance Requirements

### 5.1 Output Format Rules

1. All commands MUST return LAFS-compliant structured output by default (JSON)
2. Human-readable output is opt-in via `--human` flag
3. Flag precedence: explicit flags > project config > user config > protocol default (JSON)
4. Conflicting flags (`--json` + `--human`) MUST be rejected with `E_FORMAT_CONFLICT`
5. The `resolveOutputFormat()` function from `lafs-protocol` MUST be used for flag resolution

### 5.2 Error Handling Rules

1. Error codes MUST map to the LAFS error taxonomy (registered via `getErrorRegistry()`)
2. Every error MUST include a `category` field from: VALIDATION, NOT_FOUND, CONFLICT, INTERNAL, RATE_LIMIT, AUTHENTICATION, AUTHORIZATION, IO
3. Retryable errors MUST set `retryable: true` and provide `retryAfterMs`
4. CLEO-specific error details (exit code, fix command, alternatives) go in the `details` object

### 5.3 Transport Agnosticism

1. The same semantic contract MUST apply across CLI, MCP, and HTTP transports
2. Transport-specific behavior (exit codes for CLI, HTTP status for REST, gRPC codes for gRPC) is derived from the LAFS error code, not hardcoded
3. The `_meta.transport` field MUST accurately reflect the active transport

### 5.4 Agent-First Design

1. Machine-readable (JSON) is the default -- human-readable is opt-in
2. Error responses MUST include actionable fix suggestions in `details.fix`
3. List responses SHOULD include pagination metadata in `page`
4. The `_meta.mvi` (Machine-Verifiable Indicator) MUST always be present and `true`

### 5.5 Conformance Testing

LAFS conformance is validated using the `@cleocode/lafs-protocol` package:

```typescript
import {
  runEnvelopeConformance,
  runFlagConformance,
  getErrorRegistry,
  isRegisteredErrorCode
} from 'lafs-protocol';

// Validate every command output
const report = runEnvelopeConformance(commandOutput);
assert(report.ok, `LAFS envelope check failed: ${JSON.stringify(report.checks)}`);

// Validate flag handling
const flagReport = runFlagConformance({ jsonFlag: true });
assert(flagReport.ok);

// Verify all CLEO error codes are registered
Object.values(EXIT_TO_LAFS).forEach(lafsCode => {
  assert(isRegisteredErrorCode(lafsCode), `Unregistered: ${lafsCode}`);
});
```

---

## 6. Testing Strategy

### 6.1 Test Framework Stack

| Layer | Framework | Scope | Location |
|-------|-----------|-------|----------|
| **Unit Tests** | Vitest | Individual TypeScript modules | `tests/unit/` |
| **Integration Tests** | Vitest | Cross-module workflows | `tests/integration/` |
| **Golden Parity Tests** | Custom (diff-based) | Native vs CLI output equality | `tests/golden/` |
| **LAFS Conformance** | `@cleocode/lafs-protocol` | Envelope + flag conformance | `tests/conformance/` |
| **CLI Integration** | BATS (kept during transition) | End-to-end CLI behavior | `tests/bats/` |
| **Cross-Platform** | GitHub Actions matrix | Ubuntu, macOS, Windows | `.github/workflows/` |

### 6.2 Golden Parity Tests

Golden parity tests validate that native TypeScript output matches CLI Bash output for identical inputs:

```typescript
// For each operation in the capability matrix:
const cliOutput = await runCLI('cleo show T1234');
const nativeOutput = await runNative('tasks', 'show', { id: 'T1234' });

// Semantic equality (ignoring timestamps, requestIds)
assertSemanticEqual(normalize(cliOutput), normalize(nativeOutput));
```

**Gate criteria**: All golden parity tests MUST pass before enabling auto-mode by default.

### 6.3 LAFS Conformance Test Suite

Automated conformance checks run on every CI build:

1. **Envelope validation**: Every command output passes `runEnvelopeConformance()`
2. **Flag resolution**: `--json`, `--human`, conflict detection, defaults
3. **Error code registry**: All CLEO error codes are registered LAFS codes
4. **Invariant checks**: success/error mutual exclusivity, _meta completeness

### 6.4 Cross-Platform CI Matrix

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
    node: ['20', '22']
  fail-fast: false

steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: ${{ matrix.node }}
  - run: npm ci
  - run: npm run build
  - run: npm run test:unit
  - run: npm run test:integration
  - run: npm run test:conformance
  - run: npm run test:golden  # Only on ubuntu (requires bash)
```

---

## 7. Convergence Plan

### 7.1 Convergence Architecture

When both tracks reach feature parity, the system converges:

```
┌──────────────────────────────────────────────────────────┐
│                  Shared TypeScript Core                    │
│                                                           │
│  src/core/  ─── All business logic lives here             │
│  src/store/ ─── All data access lives here                │
│  src/validation/ ── All validation lives here             │
│  src/output/ ─── All formatting lives here                │
│                                                           │
└─────────┬────────────────────────────────┬────────────────┘
          │                                │
  ┌───────▼──────────┐           ┌─────────▼──────────┐
  │  CLI Wrapper      │           │  MCP Wrapper        │
  │                   │           │                     │
  │  Commander.js     │           │  FastMCP            │
  │  Flag parsing     │           │  Tool definitions   │
  │  Exit codes       │           │  Domain routing     │
  │  Human formatting │           │  Background jobs    │
  │                   │           │                     │
  │  ~500 LOC         │           │  ~500 LOC           │
  └───────────────────┘           └─────────────────────┘
```

### 7.2 Convergence Criteria

Both tracks MUST meet these criteria before convergence:

| Criterion | Measurement | Threshold |
|-----------|-------------|-----------|
| Feature parity | Command matrix comparison | 100% of CLI commands available |
| Golden parity | Output diff tests | 0 semantic differences |
| Cross-platform | CI matrix | Green on Ubuntu, macOS, Windows |
| Performance | Benchmark suite | Within 10% of Bash CLI |
| LAFS conformance | Conformance test suite | All checks passing |

### 7.3 Bash CLI Deprecation Timeline

| Phase | Duration | State |
|-------|----------|-------|
| **Parallel** | 60 days after convergence | Both Bash and TypeScript CLIs available |
| **Deprecation Notice** | Day 1 of parallel period | Bash CLI emits deprecation warning |
| **Maintenance Mode** | After parallel period | Bash CLI receives only critical fixes |
| **End of Life** | 6 months after maintenance | Bash CLI removed from distribution |

---

## 8. Task Decomposition

### 8.1 Epic Hierarchy

```
T4454: EPIC: CLEO V2 Full TypeScript System (LAFS-native)
│
├── Phase 1 - Foundation
│   ├── T4455: V2-P1: TypeScript project structure and build system
│   ├── T4456: V2-P1: Core types, exit codes, LAFS output format
│   ├── T4457: V2-P1: Atomic file operations
│   └── T4458: V2-P1: Config engine and path resolution
│
├── Phase 2 - Core Commands
│   ├── T4460: V2-P2: Port add/list/show/find commands
│   ├── T4461: V2-P2: Port complete/update/delete/archive commands
│   ├── T4462: V2-P2: Port focus command group
│   └── T4463: V2-P2: Port session management
│
├── Phase 3 - Feature Parity
│   ├── T4464: V2-P3: Port phase commands and dependency graph
│   ├── T4465: V2-P3: Port research commands and manifest operations
│   ├── T4466: V2-P3: Port orchestration and skill dispatch
│   ├── T4467: V2-P3: Port lifecycle and release commands
│   └── T4468: V2-P3: Port migration system and schema versioning
│
├── Phase 4 - Integration
│   ├── T4469: V2-P4: LAFS conformance testing and certification
│   ├── T4470: V2-P4: CAAMP full API integration (88 exports)
│   ├── T4471: V2-P4: Cross-platform CI matrix
│   └── T4472: V2-P4: Documentation, migration guide, deprecation plan
│
└── MCP Track (Parallel)
    ├── T4474: MCP-EXP: Expand research domain to native engine
    ├── T4475: MCP-EXP: Expand lifecycle domain to native engine
    ├── T4476: MCP-EXP: Expand release domain to native engine
    ├── T4477: MCP-EXP: Expand validate domain to native engine
    └── T4478: MCP-EXP: Expand orchestrate domain to native engine
```

### 8.2 Dependency Graph

```
Phase 1 (no deps)
  T4455 ─┐
  T4456 ─┤
  T4457 ─┤── Phase 2 depends on all P1 tasks
  T4458 ─┘
           T4460 ─┐
           T4461 ─┤── Phase 3 depends on P2 core tasks
           T4462  │
           T4463 ─┘
                    T4464 ─┐
                    T4465 ─┤── Phase 4 depends on all P3 tasks
                    T4466 ─┤
                    T4467 ─┘

MCP Track (independent, parallel with CLI phases)
  T4474, T4475, T4476, T4477, T4478  (no cross-track deps)
```

### 8.3 Task Count Summary

| Track | Phase | Tasks | Depends On |
|-------|-------|-------|-----------|
| CLI | P1: Foundation | 4 | None |
| CLI | P2: Core Commands | 4 | P1 |
| CLI | P3: Feature Parity | 5 | P2 |
| CLI | P4: Integration | 4 | P3 |
| MCP | Expansion | 5 | Independent |
| | **Total** | **22** | |

---

## 9. Key Dependencies

### 9.1 Production Dependencies

```json
{
  "dependencies": {
    "commander": "^12.0.0",
    "zod": "^3.23.0",
    "ajv": "^8.17.0",
    "ajv-formats": "^3.0.0",
    "write-file-atomic": "^6.0.0",
    "proper-lockfile": "^4.1.0",
    "@cleocode/caamp": "^0.3.0",
    "lafs-protocol": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "esbuild": "^0.24.0",
    "vitest": "^4.0.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

### 9.2 Build Targets

| Metric | Target |
|--------|--------|
| Bundle size | < 500KB (esbuild single file) |
| Startup time | < 50ms (p95, benchmarked) |
| Build time | < 2s |
| Node.js minimum | >= 20 |

---

## 10. Relationship to Existing Documents

### 10.1 Document Authority Hierarchy

```
docs/concepts/CLEO-VISION.mdx                        (immutable identity - HIGHEST)
    │
    ├── docs/specs/PORTABLE-BRAIN-SPEC.md       (product contract)
    │
    ├── docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md  (phase execution plan)
    │
    ├── docs/specs/CLEO-MIGRATION-DOCTRINE.md   (migration strategy - UPDATED)
    │       │
    │       └── Now reflects both-tracks-parallel
    │
    ├── claudedocs/CLEO-V2-ARCHITECTURE-DECISIONS.md  (ADR D1-D6)
    │       │
    │       └── D1 fully activated (not just incremental MCP)
    │       └── D5 activated (Commander.js CLI proceeding)
    │
    └── docs/specs/CLEO-V2-ARCHITECTURE-SPEC.md  (THIS DOCUMENT)
            │
            └── End-to-end V2 architecture with LAFS
```

### 10.2 ADR Status Under V2

| ADR | Original Status | V2 Status |
|-----|----------------|-----------|
| D1: TypeScript Port | Conditional GO (incremental MCP) | **FULL GO** (both tracks) |
| D2: JSON/JSONL Storage | Unchanged | Unchanged |
| D3: Manifest Validation | Unchanged | Unchanged |
| D4: Technical Debt Tracking | Unchanged | Unchanged |
| D5: Commander.js CLI | Deferred | **ACTIVATED** (T2021 ungated) |
| D6: Multi-Agent Consensus | Unchanged | Unchanged |

---

## 11. References

### 11.1 Source Documents

| Document | Path | Relationship |
|----------|------|-------------|
| Vision Charter | `docs/concepts/CLEO-VISION.mdx` | Immutable identity (highest authority) |
| Portable Brain Spec | `docs/specs/PORTABLE-BRAIN-SPEC.md` | Product contract |
| Strategic Roadmap | `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` | Phase execution plan |
| Migration Doctrine | `docs/specs/CLEO-MIGRATION-DOCTRINE.md` | Migration strategy (updated by this spec) |
| ADR D1-D6 | `claudedocs/CLEO-V2-ARCHITECTURE-DECISIONS.md` | Architecture decisions |
| MCP Server Spec | `docs/specs/MCP-SERVER-SPECIFICATION.md` | Two-tool CQRS gateway |
| MCP Agent Interaction | `docs/specs/MCP-AGENT-INTERACTION-SPEC.md` | Progressive disclosure levels |

### 11.2 External Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@cleocode/lafs-protocol` | ^1.0.0 | LAFS envelope, conformance testing, error registry |
| `@cleocode/caamp` | ^0.3.0 | Package manager for skills, MCP servers, agent instructions |
| Commander.js | ^12.0.0 | CLI framework |
| esbuild | ^0.24.0 | TypeScript bundler |
| Vitest | ^4.0.0 | Test framework |
| Ajv | ^8.17.0 | JSON Schema validation |
| Zod | ^3.23.0 | CLI input validation |

### 11.3 Key Tasks

| Task | Title | Status |
|------|-------|--------|
| T4454 | EPIC: CLEO V2 Full TypeScript System (LAFS-native) | Pending |
| T4455-T4458 | Phase 1: Foundation | Pending |
| T4460-T4463 | Phase 2: Core Commands | Pending (depends P1) |
| T4464-T4468 | Phase 3: Feature Parity | Pending (depends P2) |
| T4469-T4472 | Phase 4: Integration | Pending (depends P3) |
| T4474-T4478 | MCP Track: Engine Expansion | Pending (parallel) |
| T2021 | EPIC: Full TS Conversion (legacy) | Superseded by T4454 |
| T4334 | EPIC: MCP Native Engine | P0-P2 done, P3-P4 pending |

---

**Document Status**: DRAFT
**Authority**: End-to-end V2 architecture. Defers to `docs/concepts/CLEO-VISION.mdx` (immutable identity) and `docs/specs/PORTABLE-BRAIN-SPEC.md` (product contract) for product definition.
**Next Review**: After Phase 1 foundation tasks complete.
