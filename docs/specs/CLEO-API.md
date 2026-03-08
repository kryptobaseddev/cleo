# CLEO API Specification

**Version**: 2.1.0  
**Status**: Canonical Specification  
**Date**: 2026-03-08  
**Epic**: T4820 (CLEO Core Architecture)

---

## 1. Overview

The **CLEO API** is the canonical interface for all CLEO operations. It provides a unified, transport-agnostic contract that powers:

- **CLEO-NEXUS-API**: Cross-project coordination (multi-project view)
- **CLEO-WEB-API**: HTTP/REST adapter (browser access)
- **MCP Integration**: AI agent tools (Claude Code)
- **CLI Interface**: Command-line access

All adapters consume the same core API through the Dispatcher layer.

---

## 2. Architecture

### 2.1 Unified API Layer

```
┌─────────────────────────────────────────────────────────────┐
│                     API CONSUMERS                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ CLEO-NEXUS   │  │ CLEO-WEB     │  │ MCP/CLI      │      │
│  │ (Cross-Proj) │  │ (HTTP)       │  │ (Agents)     │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│         └─────────────────┼─────────────────┘               │
│                           │                                 │
│                    ┌──────┴──────┐                          │
│                    │  CLEO API   │                          │
│                    │  (Canonical)│                          │
│                    └──────┬──────┘                          │
│                           │                                 │
│                    ┌──────┴──────┐                          │
│                    │  DISPATCHER │                          │
│                    │  (CQRS)     │                          │
│                    └──────┬──────┘                          │
│                           │                                 │
│         ┌─────────────────┼─────────────────┐               │
│         │                 │                 │               │
│         ▼                 ▼                 ▼               │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐          │
│  │ tasks.db │      │ brain.db │      │ nexus.db │          │
│  │(project) │      │(project) │      │ (global) │          │
│  └──────────┘      └──────────┘      └──────────┘          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Transport Adapters

| Adapter            | Transport        | Purpose                                   |
| ------------------ | ---------------- | ----------------------------------------- |
| **CLEO-NEXUS-API** | HTTP/MCP/CLI     | Cross-project operations, global registry |
| **CLEO-WEB-API**   | HTTP (Fastify)   | Web dashboard, browser access             |
| **MCP Tools**      | stdio (JSON-RPC) | AI agents, Claude Code                    |
| **CLI**            | Process          | Scripts, automation, human use            |

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
| **Total**     | **See registry** | **See registry** | **Live total** | Canonical counts live in `src/dispatch/registry.ts` and `docs/specs/CLEO-OPERATION-CONSTITUTION.md` |

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

The live operation inventory spans **10 canonical domains**. For current totals, use `src/dispatch/registry.ts` and `docs/specs/CLEO-OPERATION-CONSTITUTION.md` as the source of truth.

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

Single source of truth: `src/dispatch/registry.ts`

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

API specifications generated from registry:

```bash
# Generate OpenAPI spec
npm run generate:api -- --format openapi

# Generate TypeScript client
npm run generate:api -- --format typescript

# Generate Markdown docs
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

```
~/.cleo/
├── nexus.db              # Global registry
└── projects/
    └── {project-hash}/
        ├── tasks.db      # Project data
        ├── brain.db      # BRAIN memory
        └── config.json   # Project config
```

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

See: [CLEO-WEB-API.md](./CLEO-WEB-API.md)

```
POST /api/query   { domain, operation, params }
POST /api/mutate  { domain, operation, params }
GET  /api/poll    (ETag-based change detection)
```

The HTTP adapter MUST also serve grade analytics and token telemetry through the same dispatch contract. That includes existing `admin.grade*` and `admin.token.*` operations, plus future grade-run, timing, comparison, and eval endpoints.

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
```

---

## 7. Related Specifications

| Document                                                             | Purpose                                |
| -------------------------------------------------------------------- | -------------------------------------- |
| **[CLEO-NEXUS-API.md](./CLEO-NEXUS-API.md)**                         | Cross-project API (builds on CLEO-API) |
| **[CLEO-WEB-API.md](./CLEO-WEB-API.md)**                             | HTTP adapter specification             |
| **[CLEO-ARCHITECTURE.md](./CLEO-ARCHITECTURE.md)**                   | System architecture                    |
| **[LAFS Protocol](https://github.com/kryptobaseddev/lafs-protocol)** | LLM-Agent-First Specification          |

---

## 8. Grade and Token API Plan

### 8.1 Canonical Registry Surface

As of v2.1, the canonical registry surface for grade and token analytics is in transition and SHOULD be read from `src/dispatch/registry.ts` rather than inferred from legacy handler names.

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
├── CLEO-NEXUS-API.md (Cross-project layer)
└── CLEO-WEB-API.md (HTTP transport layer)
```

---

**Version**: 2.1.0  
**Last Updated**: 2026-03-08
