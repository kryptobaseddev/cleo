# CLEO API Specification

**Version**: 3.4.0
**Status**: Canonical Specification
**Date**: 2026-03-24
**Epic**: T4820 (CLEO Core Architecture)

---

## 1. Overview

The **CLEO API** is the canonical interface for all CLEO operations. It provides a unified contract that powers:

- **@cleocode/core**: Typed function API for programmatic embedding (direct, standalone)
- **CLI Interface**: The sole runtime surface of `@cleocode/cleo`. Every CLEO operation is reachable through the `cleo` CLI (`packages/cleo/src/cli/index.ts`).
- **CLEO-NEXUS-API**: Cross-project coordination (multi-project view), reached via `cleo nexus …`
- **CLEO-WEB-API**: HTTP/REST adapter (**Status: PLANNED** — part of CleoOS vision)

Consumers can access the API at two levels:
- **Direct (Path A)**: Import `@cleocode/core` for typed function calls (no dispatch layer, standalone kernel)
- **Routed (Path B)**: Invoke the `cleo` CLI, which routes through `@cleocode/cleo`'s dispatch layer into `@cleocode/core`

---

## 2. Architecture

### 2.1 Unified API Layer

```
┌──────────────────────────────────────────────────────────────────┐
│                       API CONSUMERS                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Path A: Direct (no dispatch)       Path B: Routed (CLI)         │
│                                                                  │
│  ┌──────────────────┐                  ┌──────────────────────┐  │
│  │ App Developers   │                  │ Humans + AI Agents   │  │
│  │ (import core)    │                  │ (cleo CLI)           │  │
│  └────────┬─────────┘                  └──────────┬───────────┘  │
│           │                                       │              │
│           │                            ┌──────────┴──────────┐   │
│           │                            │ packages/cleo/src/  │   │
│           │                            │   cli/index.ts      │   │
│           │                            │   (citty runMain)   │   │
│           │                            └──────────┬──────────┘   │
│           │                                       │              │
│           │                            ┌──────────┴──────────┐   │
│           │                            │ dispatch/adapters/  │   │
│           │                            │   cli.ts            │   │
│           │                            │ dispatchRaw(gw,     │   │
│           │                            │   dom, op, params)  │   │
│           │                            └──────────┬──────────┘   │
│           │                                       │              │
│           │                            ┌──────────┴──────────┐   │
│           │                            │ dispatch/registry   │   │
│           │                            │ (CQRS tag: query|   │   │
│           │                            │  mutate routing)    │   │
│           │                            └──────────┬──────────┘   │
│           │                                       │              │
│           └───────────────┬───────────────────────┘              │
│                           │                                      │
│                    ┌──────┴──────┐                               │
│                    │@cleocode/   │                               │
│                    │  core       │                               │
│                    │(typed API)  │                               │
│                    └──────┬──────┘                               │
│                           │                                      │
│        ┌──────────────┬───┴──────────┬───────────────┐           │
│        │              │              │               │           │
│        ▼              ▼              ▼               ▼           │
│  ┌──────────┐   ┌──────────┐   ┌──────────────┐  ┌──────────┐    │
│  │ tasks.db │   │ brain.db │   │ signaldock.db│  │ nexus.db │    │
│  │(project) │   │(project) │   │  (project)   │  │ (global) │    │
│  └──────────┘   └──────────┘   └──────────────┘  └──────────┘    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Path A** — Direct: `import { addTask } from '@cleocode/core'` — typed function calls, no dispatch overhead. Used by any TypeScript consumer embedding CLEO programmatically. `@cleocode/core` imports nothing from `dispatch/` or `cli/`.

**Path B** — Routed: `cleo tasks show T001` — citty command handler resolves to `dispatchRaw('query', 'tasks', 'show', { taskId: 'T001' })`, which routes through the registry's CQRS split (internal `gateway` tag) into `@cleocode/core`. The CLI is the sole runtime surface; there is no second protocol layer.

### 2.2 Transport Adapters

| Adapter            | Transport        | Status          | Purpose                                                      |
| ------------------ | ---------------- | --------------- | ------------------------------------------------------------ |
| **@cleocode/core** | Direct import    | **Implemented** | Typed function API for programmatic embedding                |
| **CLI**            | Process (citty)  | **Implemented** | Sole runtime surface — scripts, automation, humans, AI agents |
| **CLEO-NEXUS-API** | CLI subcommands  | **Implemented** | Cross-project operations, global registry (via `cleo nexus …`) |
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

### 5.1 Four-Database Architecture

CLEO persistence is split across four SQLite databases. Three are per-project; one (`nexus.db`) is global and guarded to the global tier by `packages/core/src/store/nexus-sqlite.ts`.

| Database         | Scope       | Key Tables                                                  | Purpose                                                   |
| ---------------- | ----------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| **tasks.db**     | Per-project | `tasks`, `sessions`, `pipelineManifest`, `audit_log`, `adrs` | Task hierarchy, session lifecycle, pipeline manifest ledger, ADRs |
| **brain.db**     | Per-project | cognitive memory (FTS5 + vector)                            | BRAIN storage — observations, patterns, learnings         |
| **signaldock.db**| Per-project | ~22 tables for agent messaging                              | Agent registry and inter-agent messaging (SignalDock)     |
| **nexus.db**     | Global      | `project_registry`, `nexus_audit_log`                       | Cross-project coordination and dependency graph           |

**Sessions are stored in the `sessions` table inside `tasks.db`** (`packages/core/src/store/session-store.ts`, schema at `packages/core/src/store/tasks-schema.ts:141-182`), not as JSON files.

**The pipeline manifest ledger is stored in the `pipelineManifest` table inside `tasks.db`** (`packages/core/src/memory/pipeline-manifest-sqlite.ts`), not as a `MANIFEST.jsonl` file. The legacy file name is retained only for historical references in release artifacts.

### 5.2 Storage Location

The global `nexus.db` uses `env-paths` for OS-appropriate locations via `getCleoHome()`. Per-project databases live **inside the project directory** under `{project-root}/.cleo/`.

```
{CLEO_HOME}/                          # OS-aware via env-paths (global tier)
├── nexus.db                          # Global cross-project registry (ONLY this DB at global tier)
├── config.json                       # Global config
├── templates/CLEO-INJECTION.md       # Injection template
├── logs/                             # Global logs

Linux:   ~/.local/share/cleo/
macOS:   ~/Library/Application Support/cleo/
Windows: %LOCALAPPDATA%\cleo\Data\

{project-root}/.cleo/                 # Per-project tier
├── tasks.db              # Per-project tasks + sessions + pipelineManifest + audit_log + ADRs
├── brain.db              # Per-project cognitive memory
├── signaldock.db         # Per-project agent registry and messaging
├── config.json           # Per-project config
├── project-info.json     # Project identity (hash, UUID)
├── project-context.json  # Detected project type
├── memory-bridge.md      # Auto-generated memory context
```

The `nexus-sqlite.ts` store guard asserts that `nexus.db` only ever resolves to the global tier; attempts to write a project-tier `.cleo/nexus.db` are rejected.

### 5.3 Grade Analytics and Token Telemetry

CLEO currently splits grade analytics data across `tasks.db` and filesystem artifacts.

**Canonical in `tasks.db` today:**

- `audit_log` - source data for behavioral grading
- `sessions` - session lifecycle, including `gradeMode`
- `token_usage` - per-exchange token telemetry for CLI operations and future HTTP/agent adapters

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

# Task System Hardening (T056)
cleo backfill --dry-run   # Preview AC/verification backfill
cleo backfill             # Apply AC/verification to existing tasks
cleo compliance           # Show workflow compliance metrics
cleo config set-preset strict   # Apply strictness preset
cleo config presets       # List available presets

# Acceptance criteria (pipe-separated to allow commas in AC text)
cleo add "Task" --acceptance "AC1|AC2|AC3"
cleo update T001 --acceptance "AC1|AC2|AC3"

# Pipeline stage management
cleo update T001 --pipeline-stage implementation

# Agent health monitoring (T038/T039)
cleo agents health                         # Full health report for all agents
cleo agents health --id <agentId>          # Single agent status check
cleo agents health --detect-crashed        # Detect and mark crashed agents (mutating)
cleo agents health --threshold <ms>        # Custom staleness threshold in milliseconds

# Reasoning and intelligence operations (T038/T044)
cleo reason why <taskId>                   # Causal trace through dependency chains
cleo reason similar <taskId>              # Find semantically similar BRAIN entries
cleo reason impact <taskId>               # Show downstream tasks affected by changes
cleo reason timeline <taskId>             # Show task history and audit trail

# Task work operations (v2026.3.60)
cleo start T001              # Start working on task (sets focus)
cleo stop                    # Stop working on current task
cleo current                 # Show current task work state

# Session find (v2026.3.63)
cleo session find --status active --limit 5
```

---

## 7. Related Specifications

| Document                                                             | Status          | Purpose                                |
| -------------------------------------------------------------------- | --------------- | -------------------------------------- |
| **[CLEO-NEXUS-API.md](./CLEO-NEXUS-API.md)**                         | Exists          | Cross-project API (builds on CLEO-API) |
| **[CLEO-OPERATION-CONSTITUTION.md](./CLEO-OPERATION-CONSTITUTION.md)**| Exists          | Canonical operation registry (see registry for live count) |
| **[VERB-STANDARDS.md](./VERB-STANDARDS.md)**                          | Exists          | Canonical verb definitions             |
| **[LAFS Protocol](https://github.com/kryptobaseddev/lafs)** | External        | LLM-Agent-First Specification          |
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

## 15.6 New Features in T101 and T038 Release

### T101 — Config Schema Audit (Config Surface Reduction)

The T101 epic audited and cleaned the CLEO configuration schema, removing approximately 170 vaporware fields that existed in the schema and templates but were never read by any runtime code.

**Scale of reduction**: ~283 live + vaporware fields → ~113 live fields (approximately 60% reduction in declared surface).

**Sections removed entirely**:

| Section | Reason |
|---------|--------|
| `tools` | No runtime consumer — all reads via `caamp` directly |
| `testing` | No runtime consumer |
| `graphRag` | Planned feature, never implemented |
| `cli` | No runtime consumer |
| `display` | No runtime consumer |
| `logging` (legacy block) | Superseded by `pinoLogging`; no readers |
| `documentation` | No runtime consumer |
| `contextStates` | No runtime consumer |
| `multiSession` | No runtime consumer (all 13 fields vaporware) |
| `project` | No runtime consumer |

**Key field corrections**:

- `validation.enforceAcceptance` — removed; the authoritative gate is `enforcement.acceptance.mode`
- `hierarchy.requireAcceptanceCriteria` — phantom field removed from strictness preset writes; presets now correctly write `enforcement.acceptance.mode`
- `enforcement.*` and `verification.*` sections read via untyped dot-path (`getConfigValue`); a type safety gap remains and is tracked as a follow-up

**Type safety note**: `CleoConfig` in `@cleocode/contracts` does not yet declare `enforcement` and `verification` sections as typed fields. Runtime code reads them via dot-path. Consumers relying on `CleoConfig` as an exhaustive type contract should be aware that `enforcement.*` and `verification.*` fields exist at runtime but are not present in the TypeScript interface.

### T038 — Documentation-Implementation Drift Remediation (Agent Infrastructure)

The T038 epic shipped the agent health monitoring, retry, and registry infrastructure described in the kernel specification but not yet implemented at the time T034 was completed.

#### New Core Exports (agents namespace)

| Export | Source | Purpose |
|--------|--------|---------|
| `recordHeartbeat` | `agents/health-monitor.ts` | Update `last_heartbeat` for a live agent |
| `checkAgentHealth` | `agents/health-monitor.ts` | Per-agent health status report |
| `detectStaleAgents` | `agents/health-monitor.ts` | List agents with heartbeat older than threshold (read-only) |
| `detectCrashedAgents` | `agents/health-monitor.ts` | Detect and mark active agents with no heartbeat >3min (mutating) |
| `HEARTBEAT_INTERVAL_MS` | `agents/health-monitor.ts` | Recommended heartbeat interval constant (30 000 ms) |
| `STALE_THRESHOLD_MS` | `agents/health-monitor.ts` | Default staleness threshold constant (180 000 ms) |
| `AgentHealthStatus` (type) | `agents/health-monitor.ts` | Structured per-agent health report |
| `getAgentCapacity` | `agents/agent-registry.ts` | Remaining task-count capacity for one agent |
| `getAgentsByCapacity` | `agents/agent-registry.ts` | All active agents sorted by remaining capacity (descending) |
| `getAgentSpecializations` | `agents/agent-registry.ts` | Skills array from agent metadata |
| `updateAgentSpecializations` | `agents/agent-registry.ts` | Write specializations to agent metadata |
| `recordAgentPerformance` | `agents/agent-registry.ts` | Record performance metrics via execution-learning |
| `MAX_TASKS_PER_AGENT` | `agents/agent-registry.ts` | Upper bound for task-count capacity (5) |
| `findStaleAgentRows` | `agents/registry.ts` | Re-export of original `checkAgentHealth` (renamed to avoid conflict) |

#### New Core Exports (intelligence namespace)

| Export | Source | Purpose |
|--------|--------|---------|
| `predictImpact` | `intelligence/impact.ts` | Predict downstream task effects from a free-text change description |
| `analyzeChangeImpact` | `intelligence/impact.ts` | Analyze change impact across the task graph |
| `analyzeTaskImpact` | `intelligence/impact.ts` | Analyze impact for a specific task |
| `calculateBlastRadius` | `intelligence/impact.ts` | Compute blast radius for a proposed change |

#### New Core Exports (lib namespace)

| Export | Source | Purpose |
|--------|--------|---------|
| `withRetry` | `lib/retry.ts` | General-purpose retry with exponential backoff |
| `computeDelay` | `lib/retry.ts` | Preview delay schedule without invoking retry |
| `RetryOptions` (type) | `lib/retry.ts` | Retry configuration options |
| `RetryContext` (type) | `lib/retry.ts` | Context attached to the error on final failure |

The `lib` namespace is a new public namespace added in this release (exported as `export * as lib from './lib/index.js'`). It provides general-purpose utilities with no database coupling.

#### New CLI Commands (T038)

| Command | Purpose |
|---------|---------|
| `cleo agents health` | Full health report for all registered agents |
| `cleo agents health --id <agentId>` | Single agent health check |
| `cleo agents health --detect-crashed` | Detect and mark crashed agents (mutating) |
| `cleo agents health --threshold <ms>` | Custom staleness threshold |
| `cleo reason why <taskId>` | Causal trace via `memory.reason.why` dispatch |
| `cleo reason similar <taskId>` | Semantically similar BRAIN entries via `memory.reason.similar` |
| `cleo reason impact <taskId>` | Downstream dependency impact via `tasks.depends` |
| `cleo reason timeline <taskId>` | Task audit history via `tasks.history` |

#### New Dispatch Operations (T038)

| Gateway | Domain | Operation | Purpose |
|---------|--------|-----------|---------|
| `query` | `tasks` | `impact` | Predict downstream effects of a free-text change description |

#### Nexus Assessment (T045)

A production usage audit conducted as part of T038 found that zero Nexus operations have been invoked outside of automated tests after 15+ days of availability. All 22 registered Nexus operations are implemented and tested, but no real workflow has exercised cross-project coordination, task discovery, graph traversal, or transfer operations. Nexus has been formally deferred to Phase 3. See `.cleo/agent-outputs/T045-nexus-assessment.md` for the full assessment.

### 15.8 T123 — Bootstrap Injection Chain + CleoOS Facade Gaps (v2026.3.60)

The T123 epic closed four CleoOS facade API gaps and fixed bootstrap injection chain bugs.

**Facade additions:**

- `sessions.start({ startTask })` — bind session + task in a single call
- `tasks.start(taskId)`, `tasks.stop()`, `tasks.current()` — task work operations on facade
- `cleo.agents` getter — `AgentsAPI` with 8 methods (register, deregister, health, detectCrashed, recordHeartbeat, capacity, isOverloaded, list)
- `cleo.intelligence` getter — `IntelligenceAPI` with 2 methods (predictImpact, blastRadius)

The Cleo facade class now exposes **12 domain getter properties** (up from 10).

**Bootstrap fixes:**

- Legacy `~/.cleo/templates/` synced on every install (was XDG-only)
- `sanitizeCaampFile()` cleans orphaned CAAMP fragments before inject()
- `verifyBootstrapHealth()` Step 7 validates injection chain after bootstrap
- `checkGlobalTemplates()` checks version sync between XDG and legacy paths

### 15.9 Hotfix Batch (v2026.3.61–65)

Sixteen GitHub issues (#63–#78) resolved across five point releases. Key fixes:

- Migration journal reconciliation for tasks.db and brain.db (v2026.3.61)
- `ensureRequiredColumns()` safety net after migrations (v2026.3.61)
- `dryRun` flag threading through dispatch layer (v2026.3.62)
- `session find` CLI subcommand (v2026.3.63)
- `paginate()` null guard (v2026.3.64)
- `detect-drift` user project detection (v2026.3.65)

### 15.10 T134 — Brain Memory Automation (v2026.3.70)

The T134 epic (12 tasks, T135–T146) delivers the first full automation layer for BRAIN memory: local embeddings, lifecycle-driven bridge refresh, session summarization, cross-provider transcript extraction, and a combined maintenance command.

#### New CLI Commands (T134)

| Command | Purpose |
|---------|---------|
| `cleo brain maintenance` | Combined brain maintenance: temporal decay + consolidation + embedding backfill (T143) |
| `cleo brain maintenance --skip-decay` | Skip temporal decay step |
| `cleo brain maintenance --skip-consolidation` | Skip memory consolidation step |
| `cleo brain maintenance --skip-embeddings` | Skip embedding backfill step |
| `cleo backfill --embeddings` | Retroactive embedding backfill with progress reporting (T142) |

#### New Config Section (T135)

The `brain` section is now a first-class typed config block in `CleoConfig`:

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `brain.autoCapture` | `boolean` | `true` | Auto-capture observations on lifecycle events |
| `brain.embedding.enabled` | `boolean` | `false` | Enable local embedding provider |
| `brain.embedding.provider` | `'local' \| 'openai' \| 'custom'` | `'local'` | Embedding provider selection |
| `brain.memoryBridge.autoRefresh` | `boolean` | `true` | Auto-refresh bridge on session/task lifecycle events |
| `brain.memoryBridge.contextAware` | `boolean` | `false` | Use `hybridSearch()` for context-aware bridge content |
| `brain.memoryBridge.maxTokens` | `number` | `2000` | Token budget for bridge content |
| `brain.summarization.enabled` | `boolean` | `false` | Enable session summarization on `session.end` |

#### New Contract Types (T134)

| Type | Purpose |
|------|---------|
| `BrainConfig` | Top-level brain config section in `CleoConfig` |
| `BrainEmbeddingConfig` | `brain.embedding.*` sub-interface |
| `BrainMemoryBridgeConfig` | `brain.memoryBridge.*` sub-interface |
| `BrainSummarizationConfig` | `brain.summarization.*` sub-interface |
| `SessionSummaryInput` | Structured session summary type for ingestion |

**Updated interfaces:**

- `AdapterHookProvider` gains an optional `getTranscript()` method for cross-provider transcript extraction (T144)
- `SessionEndResult` gains `memoryPrompt?: string` for dual-mode summarization
- `SessionEndParams` gains `sessionSummary?: SessionSummaryInput` for structured summary ingestion

#### New Internal Exports (T134)

| Export | Source | Purpose |
|--------|--------|---------|
| `initDefaultProvider` | `memory/brain-embedding.ts` | Initialize local all-MiniLM-L6-v2 embedding provider (T136) |
| `generateContextAwareContent` | `memory/memory-bridge.ts` | Scope-aware bridge generation using `hybridSearch()` (T139) |
| `buildSummarizationPrompt` | `memory/session-memory.ts` | Build agent summarization prompt for dual-mode output (T140) |
| `ingestStructuredSummary` | `memory/session-memory.ts` | Auto-ingest structured `SessionSummaryInput` to brain.db (T140) |
| `extractFromTranscript` | `memory/auto-extract.ts` | Extract observations from provider transcript via hook (T144) |
| `runBrainMaintenance` | `memory/brain-maintenance.ts` | Combined maintenance: decay + consolidation + embedding backfill (T143) |
| `LocalEmbeddingProvider` | `memory/embedding-local.ts` | all-MiniLM-L6-v2 ONNX embedding via `@xenova/transformers` (T136) |
| `EmbeddingQueue` | `memory/embedding-queue.ts` | Async embedding queue for non-blocking background processing (T137) |

#### New Dependency (T136)

| Package | Version | Load Strategy |
|---------|---------|---------------|
| `@xenova/transformers` | `^2.17.2` | Dynamic import — only loads when `brain.embedding.enabled: true` |

---

## 15.11 T158 — CAAMP 1.9.1 Hook Normalizer Integration (v2026.3.next)

The T158 epic integrates CAAMP ^1.9.1 and its 16-event canonical hook taxonomy, ships three new provider adapters, upgrades five existing adapters via the normalizer, adds brain automation handlers for hook events, and introduces a diagnostic command for the provider hook matrix.

### New CLI Commands (T158)

| Command | Purpose |
|---------|---------|
| `cleo doctor --hooks` | Provider hook matrix diagnostic — shows which hooks each detected adapter supports (T167) |

### New Dispatch Operations (T158)

| Gateway | Domain | Operation | Tier | Purpose |
|---------|--------|-----------|------|---------|
| `query` | `admin` | `hooks.matrix` | 1 | Provider hook matrix — lists all adapters with their supported hook events |

### New Provider Adapters (T158)

| Adapter | Hooks | getTranscript | install | Notes |
|---------|-------|--------------|---------|-------|
| **gemini-cli** | 10/16 hooks | Yes | Yes | Full adapter via CAAMP normalizer (T161) |
| **codex** | 3/16 hooks | Yes | Yes | Partial adapter via CAAMP normalizer (T162) |
| **kimi** | 0/16 hooks | No | Yes | Install-only adapter, no native hooks (T163) |

### Upgraded Adapters (T158)

| Adapter | Before | After | Method |
|---------|--------|-------|--------|
| **claude-code** | 9 hooks | 14 hooks | CAAMP normalizer (T164) |
| **opencode** | 6 hooks | 10 hooks | CAAMP normalizer (T164) |
| **cursor** | 0 hooks | 10 hooks | Fully implemented via normalizer (T165) |

### Canonical Hook Taxonomy (CAAMP ^1.9.1)

CAAMP 1.9.1 introduces a 16-event canonical taxonomy that normalizes provider-specific hook event names across all adapters:

| Canonical Event | Previous Name (if different) | Notes |
|-----------------|------------------------------|-------|
| `SubagentStart` | `subagentStart` | Camel-case canonical form |
| `SubagentStop` | `subagentStop` | Camel-case canonical form |
| `PreCompact` | `preCompact` | Camel-case canonical form |
| (13 additional events) | — | Full taxonomy in CAAMP 1.9.1 release notes |

All adapter hook registrations MUST use canonical event names. CAAMP provides backward-compatible aliases for renamed events.

### Brain Automation Handlers (T166)

Three hook events now trigger automatic brain observations:

| Hook Event | Brain Action |
|------------|-------------|
| `SubagentStart` | Observe subagent spawn with task context |
| `SubagentStop` | Observe subagent completion with outcome |
| `PreCompact` | Observe session state snapshot before context compaction |

These handlers respect `brain.autoCapture` config flag and are best-effort (no blocking on failure).

### New Dependency

| Package | Version | Change |
|---------|---------|--------|
| `@cleocode/caamp` | `^1.9.1` | Upgraded from `^1.8.1` — adds 16-event canonical taxonomy and `HookNormalizer` |

---

## 9. Document Hierarchy

```
CLEO-API.md (Master)
├── CLEO-NEXUS-API.md (Cross-project layer) — EXISTS
├── CLEO-OPERATION-CONSTITUTION.md (Operation registry) — EXISTS
└── CLEO-WEB-API.md (HTTP transport layer) — PLANNED, not yet written
```

---

**Version**: 3.4.0
**Last Updated**: 2026-03-24
