# CLEO API Specification

**Version**: 3.0.0
**Status**: Canonical Specification
**Date**: 2026-03-18
**Epic**: T4820 (CLEO Core Architecture)

---

## 1. Overview

The **CLEO API** is the canonical interface for all CLEO operations. It provides a unified, transport-agnostic contract that powers:

- **@cleocode/core**: Typed function API (direct programmatic access, standalone)
- **CLEO-NEXUS-API**: Cross-project coordination (multi-project view)
- **MCP Integration**: AI agent tools (Claude Code) — via `@cleocode/cleo`
- **CLI Interface**: Command-line access — via `@cleocode/cleo`
- **CLEO-WEB-API**: HTTP/REST adapter (**Status: PLANNED** — part of CleoOS vision)

Consumers can access the API at two levels:
- **Direct**: Import `@cleocode/core` for typed function calls (no dispatch layer)
- **Routed**: Use MCP or CLI through `@cleocode/cleo`'s dispatch layer

---

## 2. Architecture

### 2.1 Unified API Layer

```
┌──────────────────────────────────────────────────────────────────┐
│                       API CONSUMERS                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Path A: Direct (no dispatch)       Path B: Routed (dispatch)    │
│                                                                  │
│  ┌──────────────────┐       ┌──────────────┐  ┌──────────────┐  │
│  │ App Developers   │       │ MCP/CLI      │  │ CLEO-NEXUS   │  │
│  │ (import core)    │       │ (Agents)     │  │ (Cross-Proj) │  │
│  └────────┬─────────┘       └──────┬───────┘  └──────┬───────┘  │
│           │                        │                 │           │
│           │                        └────────┬────────┘           │
│           │                                 │                    │
│           │                          ┌──────┴──────┐             │
│           │                          │  DISPATCHER │             │
│           │                          │  (CQRS)     │             │
│           │                          └──────┬──────┘             │
│           │                                 │                    │
│           └──────────────┬──────────────────┘                    │
│                          │                                       │
│                   ┌──────┴──────┐                                │
│                   │@cleocode/   │                                │
│                   │  core       │                                │
│                   │(typed API)  │                                │
│                   └──────┬──────┘                                │
│                          │                                       │
│        ┌─────────────────┼─────────────────┐                     │
│        │                 │                 │                     │
│        ▼                 ▼                 ▼                     │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐               │
│  │ tasks.db │      │ brain.db │      │ nexus.db │               │
│  │(project) │      │(project) │      │ (global) │               │
│  └──────────┘      └──────────┘      └──────────┘               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Path A** — Direct: `import { addTask } from '@cleocode/core'` — typed function calls, no dispatch overhead.
**Path B** — Routed: MCP `query tasks.show` or CLI `cleo tasks show T001` — string-addressed dispatch through `@cleocode/cleo`.

### 2.2 Transport Adapters

| Adapter            | Transport        | Status          | Purpose                                                      |
| ------------------ | ---------------- | --------------- | ------------------------------------------------------------ |
| **@cleocode/core** | Direct import    | **Implemented** | Typed function API for app developers                        |
| **CLI**            | Process          | **Implemented** | Primary channel — scripts, automation, human use             |
| **MCP Tools**      | stdio (JSON-RPC) | **Implemented** | Fallback channel — AI agents, Claude Code                    |
| **CLEO-NEXUS-API** | MCP/CLI          | **Implemented** | Cross-project operations, global registry                    |
| **CLEO-WEB-API**   | HTTP (Fastify)   | **PLANNED**     | Web dashboard, browser access (CleoOS)                       |

---

## 3. Core Concepts

### 3.1 Domain-Based Organization

All operations organized by **domain**:

| Domain        | Query            | Mutate           | Total          | Purpose                                                                                             |
| ------------- | ---------------- | ---------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `tasks`       | See registry     | See registry     | Live total     | Task CRUD, hierarchy, dependencies                                                                  |
| `session`     | See registry     | See registry     | Live total     | Session lifecycle, handoffs                                                                         |
| `memory`      | See registry     | See registry     | Live total     | BRAIN storage, patterns, learnings                                                                  |
| `check`       | See registry     | See registry     | Live total     | Validation, compliance, testing                                                                     |
| `pipeline`    | See registry     | See registry     | Live total     | RCASD lifecycle, releases                                                                           |
| `orchestrate` | See registry     | See registry     | Live total     | Multi-agent coordination                                                                            |
| `tools`       | See registry     | See registry     | Live total     | Skills, issues, providers                                                                           |
| `admin`       | See registry     | See registry     | Live total     | System management, configuration                                                                    |
| `nexus`       | See registry     | See registry     | Live total     | Cross-project coordination                                                                          |
| `sticky`      | See registry     | See registry     | Live total     | Ephemeral capture, quick notes                                                                      |
| **Total**     | **See registry** | **See registry** | **Live total** | Canonical counts live in `packages/cleo/src/dispatch/registry.ts` and `docs/specs/CLEO-OPERATION-CONSTITUTION.md` |

### 3.2 Gateway Pattern

Two gateways for all operations:

- **`query`**: Read operations (idempotent, cacheable)
- **`mutate`**: Write operations (validated, logged, atomic)

### 3.3 LAFS Protocol

All responses follow **LAFS** (LLM-Agent-First Specification):

```json
{
  "_meta": {
    "operation": "tasks.show",
    "requestId": "req_abc123",
    "exitCode": 0,
    "durationMs": 42
  },
  "success": true,
  "result": {
    /* data */
  }
}
```

---

## 4. API Surface

### 4.1 Total Operations

The live operation inventory spans **10 canonical domains**. For current totals, use `packages/cleo/src/dispatch/registry.ts` and `docs/specs/CLEO-OPERATION-CONSTITUTION.md` as the source of truth.

- Query operations are read-only and idempotent
- Mutate operations are state-changing and validated

#### Why This Many Operations?

This large surface reflects CLEO's comprehensive scope across four interdependent systems:

**System Coverage:**

- **BRAIN** (memory domain): registry-defined read/write surface for cognitive memory, observations, patterns, and learnings
- **LOOM** (pipeline domain): registry-defined lifecycle surface for RCASD-IVTR+C phases, chains, gates, and releases
- **NEXUS** (nexus domain): registry-defined cross-project coordination, registry, and `nexus.share.*` relay operations
- **LAFS** (protocol layer): enforced via all response envelopes

**Granularity:**

- Each domain provides CRUD operations
- Separate query/mutate gateways (CQRS)
- Sub-namespace operations (e.g., `pipeline.stage.validate`, `nexus.share.push`)
- Lifecycle-specific operations (validate, verify, check distinctions per VERB-STANDARDS.md)

**Progressive Disclosure:**

- Tier 0 (Core): live registry-defined core workflow surface
- Tier 1 (Extended): live registry-defined memory, manifest, and advanced query surface
- Tier 2 (Full System): live registry-defined cross-project, admin, and advanced tooling surface

**For comparison:**

- GitHub REST API: ~600+ endpoints
- Linear API: ~100+ operations
- Jira REST API: ~1,000+ endpoints

CLEO's operation surface provides comprehensive control while maintaining strict domain boundaries and canonical verb standards. Refer to the dispatch registry and constitution for the live count.

### 4.2 Operation Registry

Single source of truth: `packages/cleo/src/dispatch/registry.ts`

```typescript
export const OPERATIONS: OperationDef[] = [
  {
    gateway: "query",
    domain: "tasks",
    operation: "show",
    description: "Show task details",
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ["taskId"],
  },
  // ... additional registry-defined operations
];
```

### 4.3 Dynamic Generation

> **Status: PLANNED** — The commands below are designed but not yet implemented. No `generate:api` npm script exists today. The operation registry in `packages/cleo/src/dispatch/registry.ts` is the machine-readable source of truth, but automated spec generation tooling has not been built.

```bash
# PLANNED: Generate OpenAPI spec
npm run generate:api -- --format openapi

# PLANNED: Generate TypeScript client
npm run generate:api -- --format typescript

# PLANNED: Generate Markdown docs
npm run generate:api -- --format markdown
```

---

## 5. Data Storage

### 5.1 Three-Database Architecture

| Database     | Scope       | Tables                               | Purpose            |
| ------------ | ----------- | ------------------------------------ | ------------------ |
| **tasks.db** | Per-project | tasks, sessions, pipelines, adrs     | Project operations |
| **brain.db** | Per-project | memory, patterns, learnings, vectors | Cognitive storage  |
| **nexus.db** | Global      | project_registry, nexus_audit_log    | Cross-project      |

### 5.2 Storage Location

Global paths use `env-paths` for OS-appropriate locations:

```
{CLEO_HOME}/                          # OS-aware via env-paths
├── nexus.db                          # Global cross-project registry
├── config.json                       # Global config
├── templates/CLEO-INJECTION.md       # Injection template
├── logs/                             # Global logs

Linux:   ~/.local/share/cleo/
macOS:   ~/Library/Application Support/cleo/
Windows: %LOCALAPPDATA%\cleo\Data\

{project-root}/.cleo/
├── tasks.db              # Per-project tasks
├── brain.db              # Per-project memory
├── config.json           # Per-project config
├── project-info.json     # Project identity (hash, UUID)
├── project-context.json  # Detected project type
├── memory-bridge.md      # Auto-generated memory context
```

Per-project databases live **inside the project directory** (under `{project-root}/.cleo/`). Global assets use `getCleoHome()` which resolves via `env-paths` per OS.

### 5.3 Grade Analytics and Token Telemetry

CLEO currently splits grade analytics data across `tasks.db` and filesystem artifacts.

**Canonical in `tasks.db` today:**

- `audit_log` - source data for behavioral grading
- `sessions` - session lifecycle, including `gradeMode`
- `token_usage` - per-exchange token telemetry for CLI, MCP, and future HTTP/agent adapters

**Filesystem artifacts still in active use:**

- `.cleo/metrics/GRADES.jsonl` - persisted grade results from `admin.grade`
- `.cleo/metrics/grade-runs/<run-id>/run-manifest.json` - run configuration and slot structure
- `.cleo/metrics/grade-runs/<run-id>/**/timing.json` - per-arm timing and token capture
- `.cleo/metrics/grade-runs/<run-id>/**/comparison.json` - blind comparator output
- `.cleo/metrics/grade-runs/<run-id>/**/analysis.json` - post-run synthesis
- `.cleo/metrics/grade-runs/<run-id>/summary.json` and `token-summary.json` - aggregated run summaries

`ct-grade-v2-1` is more feature-complete than `ct-grade` and already depends on richer run artifacts, per-arm timing, token linkage, and run manifests. The API MUST grow around those needs instead of only exposing legacy `GRADES.jsonl` browsing.

### 5.4 Current vs Future Grade Data Model

| Capability                      | `ct-grade`    | `ct-grade-v2-1`                           | API implication                                                      |
| ------------------------------- | ------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| Session grade result            | Yes           | Yes                                       | Keep `admin.grade` and `admin.grade.list`                            |
| Multi-run scenario execution    | Basic         | Stronger                                  | Add run-level read APIs                                              |
| Blind A/B comparison            | Yes           | Yes                                       | Add comparison and analysis payload APIs                             |
| Token enrichment on grades      | Script-driven | Stronger, more explicit                   | Keep token telemetry separate, link by `sessionId`/`tokenUsageId`    |
| Per-arm timing records          | Basic         | Stronger (`session_id`, `token_usage_id`) | Add timing read APIs                                                 |
| Run manifest and slot structure | Yes           | Stronger                                  | Add run manifest and slot summary APIs                               |
| Expanded scenario coverage      | 5 scenarios   | 10 scenarios                              | API should expose scenario/run metadata, not hardcode scenario count |

Design direction:

- `token_usage` is the canonical store for per-exchange token measurement
- `audit_log` remains the canonical source for behavioral grading inputs
- `GRADES.jsonl` remains supported as the persisted grade-result ledger until grade results move into first-class tables
- grade-run artifacts remain valid filesystem sources, but CLEO should expose them through query operations so web and MCP clients do not need to read files directly

---

## 6. Transport Details

### 6.1 HTTP (CLEO-WEB-API)

> **Status: PLANNED** — The HTTP transport layer is not implemented. The endpoints below represent the planned design for CleoOS. No `CLEO-WEB-API.md` spec exists yet.

```
POST /api/query   { domain, operation, params }
POST /api/mutate  { domain, operation, params }
GET  /api/poll    (ETag-based change detection)
```

When implemented, the HTTP adapter SHOULD serve grade analytics and token telemetry through the same dispatch contract, including `admin.grade*` and `admin.token.*` operations.

### 6.2 MCP

```json
{
  "name": "query",
  "arguments": {
    "domain": "tasks",
    "operation": "show",
    "params": { "taskId": "T001" }
  }
}
```

### 6.3 CLI

```bash
cleo tasks show T001
cleo nexus list
cleo session start
cleo detect               # Re-detect project type
cleo upgrade --detect     # Force re-detect during upgrade
cleo upgrade --name "foo" # Update project name
```

---

## 7. Related Specifications

| Document                                                             | Status          | Purpose                                |
| -------------------------------------------------------------------- | --------------- | -------------------------------------- |
| **[CLEO-NEXUS-API.md](./CLEO-NEXUS-API.md)**                         | Exists          | Cross-project API (builds on CLEO-API) |
| **[CLEO-OPERATION-CONSTITUTION.md](./CLEO-OPERATION-CONSTITUTION.md)**| Exists          | Canonical operation registry (see registry for live count) |
| **[VERB-STANDARDS.md](./VERB-STANDARDS.md)**                          | Exists          | Canonical verb definitions             |
| **[LAFS Protocol](https://github.com/kryptobaseddev/lafs-protocol)** | External        | LLM-Agent-First Specification          |
| CLEO-WEB-API.md                                                       | **PLANNED**     | HTTP adapter specification (not yet written) |
| CLEO-ARCHITECTURE.md                                                  | **PLANNED**     | System architecture (not yet written)  |

---

## 8. Grade and Token API Plan

> **Status: PLANNED** — The endpoints in this section are designed but not all are in the canonical registry today. Sections 8.1-8.2 describe the current transitional state. Sections 8.3-8.5 describe planned additions that are not yet implemented.

### 8.1 Canonical Registry Surface

As of v3.0, the canonical registry surface for grade and token analytics is in transition and SHOULD be read from `packages/cleo/src/dispatch/registry.ts` rather than inferred from legacy handler names.

**Current registry direction includes:**

- grade reads under `check`, including `grade` and the current list-style companion route exposed by the registry/runtime surface
- `query admin token` with `action=summary|list|show`
- `mutate admin token` with `action=record|delete|clear`

This reflects the current direction: grade reads are moving under `check`, and token telemetry is consolidated under `admin.token`. Clients SHOULD prefer generated registry metadata over hardcoding any one grade-list spelling while the surface continues to converge.

### 8.2 Runtime Compatibility Surface

The runtime handlers are not fully aligned with that registry surface yet.

- The `admin` domain handler still serves legacy `query admin grade` and `query admin grade.list` compatibility paths.
- The `admin` domain handler still serves split token paths: `query admin token.summary|list|show` and `mutate admin token.record|delete|clear`.
- `query admin grade.run.list` and `query admin grade.run.show` are implemented in handlers today, but they are not yet canonical registry operations.

This mismatch is a transitional compatibility layer, not a long-term stability guarantee. New specs and client generation SHOULD prefer the canonical registry surface, while runtime callers MAY encounter additional compatibility routes until registry and handlers converge.

### 8.3 Planned Analytics Endpoints for `ct-grade-v2-1`

> **Not yet implemented.** These operation families are designed but not registered in the canonical dispatch registry.

`ct-grade-v2-1` needs a richer read surface than the legacy grade APIs provide. The following operation families SHOULD be added and documented as first-class analytics endpoints:

| Operation family                           | Purpose                                              | Typical source                          |
| ------------------------------------------ | ---------------------------------------------------- | --------------------------------------- |
| `admin.grade.run.list` / `show`            | List and inspect run manifests                       | `run-manifest.json` + linked summaries  |
| `admin.grade.run.slot.show`                | Return one scenario/domain slot across runs and arms | run directory structure                 |
| `admin.grade.run.timing.list` / `show`     | Expose `timing.json` data without file reads         | timing artifacts + token links          |
| `admin.grade.run.comparison.list` / `show` | Blind comparator outputs                             | `comparison.json`                       |
| `admin.grade.run.analysis.list` / `show`   | Analyzer outputs and recommendations                 | `analysis.json`                         |
| `admin.grade.run.summary.show`             | Aggregated run summary                               | `summary.json` + `token-summary.json`   |
| `admin.grade.eval.list` / `show`           | Eval definitions and eval results when present       | `evals.json` and generated eval outputs |

### 8.4 Response Shape Requirements

- list operations return top-level `page`
- run/slot payloads include enough metadata to render dashboard summaries without opening nested files
- token-linked records include `sessionId`, `requestId`, and `tokenUsageId` when available
- file-backed results should carry provenance fields such as `runId`, `slot`, `arm`, `runNumber`, and `artifactPath`

### 8.5 Data Ownership Rules

- `token_usage` owns token measurement details
- grade APIs consume audit + token data but should not duplicate per-exchange token rows
- run artifacts remain the source of truth for blind comparison and run synthesis until dedicated tables are introduced
- future tables SHOULD mirror the artifact boundaries: `grade_results`, `grade_runs`, `grade_run_slots`, `grade_run_artifacts`, rather than flattening everything into one record

---

## 9. Document Hierarchy

```
CLEO-API.md (Master)
├── CLEO-NEXUS-API.md (Cross-project layer) — EXISTS
├── CLEO-OPERATION-CONSTITUTION.md (Operation registry) — EXISTS
└── CLEO-WEB-API.md (HTTP transport layer) — PLANNED, not yet written
```

---

**Version**: 3.1.0
**Last Updated**: 2026-03-21
