# CLEO System Flow Atlas

**Version**: 2026.3.3
**Status**: APPROVED
**Date**: 2026-03-03
**Task**: T5241

---

## 1. Purpose

This document provides a visual, human-readable map of how CLEO's four conceptual systems (BRAIN, LOOM, NEXUS, LAFS) map to the 10 runtime domains, and how requests flow through the architecture. It is the companion to the normative Operation Constitution (`docs/specs/CLEO-OPERATION-CONSTITUTION.md`).

Use this document to understand:
- How conceptual systems relate to runtime domains.
- How a request travels from user input to data store and back.
- Where data lives and which domain owns it.
- How the distillation pipeline connects artifacts to cognitive memory.

---

## 2. The Four Systems and Their Domain Mapping

CLEO's architecture is organized around four conceptual systems. These systems are **overlays**, not runtime boundaries. The 10 canonical domains are the runtime contract.

| System | Primary Domain(s) | Supporting Domains | Purpose |
|--------|-------------------|-------------------|---------|
| **BRAIN** | memory | tasks, session | Cognitive memory -- observations, decisions, patterns, learnings |
| **LOOM** | pipeline | check, orchestrate | Lifecycle management (RCSD stages), artifact ledger, release orchestration |
| **NEXUS** | nexus, sharing | admin | Cross-project coordination, registry, dependency graph |
| **LAFS** | (cross-cutting) | all domains | Progressive disclosure protocol, field selection, envelope verbosity |

### System-to-Domain Mapping Detail

```
+------------------------------------------------------------------+
|                    CONCEPTUAL SYSTEMS                             |
|                                                                  |
|   BRAIN              LOOM              NEXUS         LAFS        |
|   (cognitive         (lifecycle +      (cross-       (protocol   |
|    memory)            artifacts)        project)      disclosure) |
+------+---------------+-------+---------+------+------+------+----+
       |               |       |         |      |      |
       v               v       v         v      v      |
+------+----+   +------+--+ +--+------+ ++---------+   | (cuts
|  memory   |   | pipeline | | check  | |  nexus   |   |  across
|  domain   |   | domain   | | domain | |  domain  |   |  all
|           |   |          | |        | |          |   |  domains)
| brain.db  |   |MANIFEST  | |tasks.db| |nexus.db  |   |
+-----------+   |.jsonl    | |        | |          |   |
                |tasks.db  | +--------+ +----------+   |
                +----------+                           |
                                                       |
+------+----+   +----------+ +--------+ +----------+   |
|  tasks    |   | session  | | admin  | | sharing  |   |
|  domain   |   | domain   | | domain | | domain   |   |
|           |   |          | |        | |          |<--+
| tasks.db  |   |sessions/ | |config  | |.cleo/    |
+-----------+   +----------+ |tasks.db| |sharing/  |
                              +--------+ +----------+

+------+----+
|  tools    |   +----------+
|  domain   |   |orchestrate|
|           |   |  domain   |
|.cleo/     |   | tasks.db  |
|skills/    |   +----------+
+-----------+
```

---

## 3. End-to-End Request Flow

Every CLEO operation follows the same path through the dispatch architecture:

```
User Input
    |
    v
+--------+     +--------+
|  CLI   |     |  MCP   |    <-- Adapter layer (parses input, builds DispatchRequest)
+---+----+     +---+----+
    |              |
    v              v
+---+--------------+----+
|   Gateway Router      |    <-- Routes to query or mutate gateway
| (cleo_query/mutate)   |
+-----------+-----------+
            |
            v
+-----------+-----------+
|  Dispatch Registry    |    <-- Resolves domain + operation to OperationDef
|  (registry.ts)        |    <-- Validates required params
+-----------+-----------+
            |
            v
+-----------+-----------+
|   Middleware Pipeline  |   <-- Rate limiting, session binding, LAFS field selection
+-----------+-----------+
            |
            v
+-----------+-----------+
|    Domain Handler     |    <-- src/dispatch/domains/{domain}.ts
|  (query or mutate)    |    <-- Routes to specific engine function
+-----------+-----------+
            |
            v
+-----------+-----------+
|    Engine Layer       |    <-- src/dispatch/engines/{engine}.ts
|  (params -> core)     |    <-- Translates params, calls core functions
+-----------+-----------+
            |
            v
+-----------+-----------+
|    Core Business      |    <-- src/core/{module}/
|      Logic            |    <-- Pure business logic, no I/O concerns
+-----------+-----------+
            |
            v
+-----------+-----------+
|     Store Layer       |    <-- src/store/
| (atomic.ts, json.ts)  |   <-- Atomic write: temp -> validate -> backup -> rename
+-----------+-----------+
            |
            v
+---+-------+-------+--+
|   |       |       |   |
v   v       v       v   v
tasks.db  brain.db  MANIFEST  sessions/  config.json
                    .jsonl
```

### Request Lifecycle

1. **Parse**: CLI adapter or MCP adapter parses user input into a `DispatchRequest`.
2. **Route**: Gateway router sends request to the appropriate gateway (query or mutate).
3. **Resolve**: Registry looks up `OperationDef` by domain + operation. Returns `E_INVALID_OPERATION` if not found.
4. **Validate**: Required params are checked. Returns `E_INVALID_INPUT` if missing.
5. **Middleware**: Request passes through middleware pipeline (rate limit, session, LAFS).
6. **Handle**: Domain handler dispatches to the appropriate engine function.
7. **Execute**: Engine calls core business logic.
8. **Store**: Core writes to data store using atomic operations.
9. **Respond**: `DispatchResponse` is constructed and returned through the chain.

---

## 4. Domain Interaction Graph

Domains interact with each other through core business logic, not directly. The following shows the primary data flow relationships:

```
                    +----------+
                    |  admin   |
                    | (config, |
                    |  backup) |
                    +----+-----+
                         |
            config reads |
            backup all   |
                    +----+-----+
           +------->  tasks    <-------+
           |        | (CRUD,   |       |
           |        |  deps)   |       |
           |        +----+-----+       |
           |             |             |
     task  |     task    | task        | task
     refs  |     status  | hierarchy  | deps
           |             |            |
    +------+--+   +------+---+  +-----+------+
    | session |   | pipeline |  | orchestrate|
    | (life-  |   | (stages, |  | (waves,    |
    |  cycle) |   |  release)|  |  agents)   |
    +----+----+   +----+-----+  +------------+
         |             |
   context|     manifest|
   inject |     distill |
         |             |
    +----+----+        |
    | memory  |<-------+
    | (brain  |  distillation
    |  .db)   |  (future)
    +---------+

    +----------+    +----------+
    |  nexus   |    | sharing  |
    | (cross-  |    | (multi-  |
    |  project)|    |  contrib)|
    +----------+    +----------+

    +----------+    +----------+
    |  check   |    |  tools   |
    | (valid-  |    | (skills, |
    |  ation)  |    |  issues) |
    +----------+    +----------+
```

### Key Interaction Patterns

- **session -> memory**: `session.context.inject` reads protocol content via memory/CAAMP.
- **session -> tasks**: Sessions track which tasks are being worked on.
- **pipeline -> tasks**: Lifecycle stages reference task epic IDs.
- **pipeline -> memory**: Manifest entries MAY be distilled into brain.db observations (LOOM distillation, future).
- **orchestrate -> tasks**: Wave planning reads task dependencies and blockers.
- **check -> tasks**: Validation checks task data integrity.
- **admin -> all**: Backup and migration affect all data stores.
- **nexus -> tasks**: Cross-project queries resolve task references.

---

## 5. Data Stores and Ownership Boundaries

| Store | Owner Domain | Format | Location | Purpose |
|-------|-------------|--------|----------|---------|
| `tasks.db` | tasks | SQLite | `.cleo/tasks.db` | Task hierarchy, status, audit log, lifecycle pipelines |
| `brain.db` | memory | SQLite (FTS5) | `.cleo/brain.db` | Observations, decisions, patterns, learnings, memory links |
| `MANIFEST.jsonl` | pipeline | JSONL | `.cleo/MANIFEST.jsonl` | Research artifact ledger (append-only) |
| `sessions/` | session | JSON files | `.cleo/sessions/` | Session lifecycle state, handoff data |
| `config.json` | admin | JSON | `.cleo/config.json` | Project configuration |
| `nexus.db` | nexus | SQLite | `~/.cleo/nexus.db` | Cross-project registry (global) |
| `.cleo/skills/` | tools | YAML/JSON | `.cleo/skills/` | Skill definitions and configuration |
| `.cleo/sharing/` | sharing | JSON | `.cleo/sharing/` | Sharing remotes and sync state |
| `.cleo/metrics/` | check | JSONL | `.cleo/metrics/` | Compliance data, grades, telemetry |

### Ownership Rules

- Each store has exactly one owner domain that performs writes.
- Other domains MAY read from stores they do not own.
- Cross-domain writes MUST go through the owning domain's operations.
- All writes use the atomic pattern: temp file -> validate -> backup -> rename.

---

## 6. LOOM Distillation Flow

LOOM is the conceptual system that manages the lifecycle pipeline and artifact ledger. The distillation flow describes how artifacts in `MANIFEST.jsonl` feed into brain.db observations.

```
Research / Implementation Work
         |
         v
+--------+---------+
| pipeline.manifest|    <-- Agent appends artifact entry
|    .append       |
+--------+---------+
         |
         v
+--------+---------+
|  MANIFEST.jsonl  |    <-- Append-only artifact ledger
|  (pipeline owns) |    <-- Entries: { type, content, taskId, timestamp, ... }
+--------+---------+
         |
         | (distillation -- triggered by session.end or manual)
         v
+--------+---------+
| memory.observe   |    <-- Distilled into observation
| memory.decision  |    <-- Or stored as decision
|    .store        |
| memory.pattern   |    <-- Or stored as pattern
|    .store        |
| memory.learning  |    <-- Or stored as learning
|    .store        |
+--------+---------+
         |
         v
+--------+---------+
|    brain.db      |    <-- Persistent cognitive memory
| (memory owns)    |    <-- FTS5 searchable, linked to tasks
+------------------+
```

### Distillation Rules

1. Manifest entries are raw artifacts: research notes, implementation decisions, validation results.
2. Distillation extracts the durable insight from an artifact and stores it in the appropriate brain.db table.
3. Observations capture factual findings.
4. Decisions capture choices with rationale.
5. Patterns capture reusable workflows or anti-patterns.
6. Learnings capture insights with confidence levels.
7. Memory links connect brain entries back to their source tasks.

---

## 7. Query/Mutate Flow Examples

### Example 1: memory.find (query)

Search for cognitive memory entries matching a keyword.

```
Agent calls:
  cleo_query { domain: "memory", operation: "find", params: { query: "atomic" } }

Flow:
  MCP Adapter
    -> Gateway: query
    -> Registry: resolve("query", "memory", "find") -> OperationDef (tier 1)
    -> Validate: requiredParams ["query"] -> present
    -> Middleware: rate limit check, LAFS field selection
    -> Domain Handler: src/dispatch/domains/memory.ts :: query("find", params)
    -> Engine: src/dispatch/engines/engine-compat.ts :: searchBrainCompact()
    -> Core: src/core/memory/brain-search.ts :: searchBrainCompact("atomic")
    -> Store: brain.db FTS5 query across observations, decisions, patterns, learnings
    -> Response: { success: true, data: { results: [...], count: N } }
```

### Example 2: pipeline.manifest.append (mutate)

Append a research artifact to the manifest ledger.

```
Agent calls:
  cleo_mutate { domain: "pipeline", operation: "manifest.append",
                params: { entry: { type: "research", content: "..." } } }

Flow:
  MCP Adapter
    -> Gateway: mutate
    -> Registry: resolve("mutate", "pipeline", "manifest.append") -> OperationDef (tier 1)
    -> Validate: requiredParams ["entry"] -> present
    -> Middleware: rate limit, session binding
    -> Domain Handler: src/dispatch/domains/pipeline.ts :: mutate("manifest.append", params)
    -> Engine: src/dispatch/engines/pipeline-manifest-compat.ts :: appendManifestEntry()
    -> Core: src/core/research/manifest.ts :: append to MANIFEST.jsonl
    -> Store: atomic write to .cleo/MANIFEST.jsonl
    -> Response: { success: true, data: { entryId: "M-abc123" } }
```

### Example 3: session.context.inject (mutate)

Inject a protocol's context into the current session.

```
Agent calls:
  cleo_mutate { domain: "session", operation: "context.inject",
                params: { protocolType: "research", taskId: "T5241" } }

Flow:
  MCP Adapter
    -> Gateway: mutate
    -> Registry: resolve("mutate", "session", "context.inject") -> OperationDef (tier 1)
    -> Validate: requiredParams ["protocolType"] -> present
    -> Middleware: rate limit, session binding
    -> Domain Handler: src/dispatch/domains/session.ts :: mutate("context.inject", params)
    -> Engine: loads protocol content from CAAMP catalog
    -> Response: { success: true, data: { protocol: "research", content: "..." } }
```

---

## 8. Progressive Disclosure in Practice

Progressive disclosure minimizes the cognitive load on agents by starting with a small operation set and expanding on demand.

### Scenario: Agent Discovers Memory Operations

```
Step 1: Agent starts session (tier 0)
  cleo_mutate { domain: "session", operation: "start", params: { scope: "T5241" } }
  -> Agent sees: tasks, session, check, pipeline, orchestrate, tools, admin ops

Step 2: Agent needs to recall past decisions
  cleo_query { domain: "admin", operation: "help", params: { tier: 1 } }
  -> Agent now sees: + memory domain (17 ops), + manifest ops, + session advanced

Step 3: Agent searches brain.db
  cleo_query { domain: "memory", operation: "find", params: { query: "authentication" } }
  -> Returns matching observations, decisions, patterns, learnings

Step 4: Agent stores a new learning
  cleo_mutate { domain: "memory", operation: "learning.store",
                params: { insight: "JWT tokens require refresh", source: "T5241" } }
```

### Tier Budget

| Tier | Operations | % of Total | Typical User |
|------|-----------|------------|--------------|
| 0 | 151 | 75% | All agents |
| 1 | 28 | 14% | Agents needing memory/manifest |
| 2 | 22 | 11% | Orchestrators, admins |

---

## 9. Failure and Recovery Paths

### Atomic Write Pattern

All write operations follow the same safety pattern:

```
1. Write data to temporary file (.tmp)
2. Validate against JSON Schema
3. Create backup of original file
4. Atomic rename: temp -> original

If step 2 fails: temp file is deleted, original is untouched
If step 4 fails: backup is available for manual recovery
```

### Backup System (Two-Tier)

```
Tier 1: Operational Backups (.cleo/.backups/)
  - Automatic on every atomic write
  - Last 10 per file
  - Immediate rollback capability

Tier 2: Recovery Backups (.cleo/backups/{type}/)
  - Types: snapshot, safety, archive, migration
  - Manual or pre-destructive-operation
  - Metadata, checksums, retention policies
```

### Error Recovery Flow

```
Operation Fails
    |
    +-- E_VALIDATION_FAILED -> Caller fixes input, retries
    |
    +-- E_CONCURRENT_MODIFICATION -> Caller re-reads, retries with new checksum
    |
    +-- E_NOT_FOUND -> Caller verifies entity exists
    |
    +-- E_INTERNAL -> Check audit log, restore from backup if needed
    |
    +-- E_RATE_LIMITED -> Wait for resetMs, retry
```

---

## 10. Observability and Audit Trails

### Audit Log

Every mutate operation appends to the audit log in `tasks.db`. The audit log is append-only and captures:

- Operation name (domain.operation)
- Timestamp
- Parameters (sanitized)
- Result (success/failure)
- Session ID (if bound)

### Session History

Session lifecycle events are recorded in session JSON files under `.cleo/sessions/`. Each session tracks:

- Start/end timestamps
- Tasks worked on
- Decisions recorded
- Assumptions recorded
- Handoff data for the next session

### Response Metadata

Every `DispatchResponse` includes `_meta` with:

```json
{
  "_meta": {
    "gateway": "query",
    "domain": "memory",
    "operation": "find",
    "timestamp": "2026-03-03T12:00:00Z",
    "duration_ms": 42,
    "source": "mcp",
    "requestId": "req-abc123",
    "sessionId": "S-001"
  }
}
```

---

## 11. Canonical Invariants

These rules MUST always hold true in a correct CLEO installation:

1. **Registry is SSoT**: `src/dispatch/registry.ts` defines all valid operations. No operation exists outside this array.
2. **Atomic writes**: All store mutations use the temp -> validate -> backup -> rename pattern. No direct file overwrites.
3. **Old names fail**: Removed operation names return `E_INVALID_OPERATION`. There is no silent fallback.
4. **CQRS separation**: Query operations MUST NOT modify state. Mutate operations MAY modify state.
5. **Schema validation**: All data writes are validated against JSON Schema before commit.
6. **Anti-hallucination**: Task operations enforce uniqueness, completeness, and temporal validity.
7. **Domain ownership**: Each data store has exactly one owning domain. Cross-domain writes go through the owner.
8. **Append-only audit**: The audit log in tasks.db is append-only. Entries are never modified or deleted.
9. **Canonical verbs**: All operation names use verbs from `docs/specs/VERB-STANDARDS.md`. No `search`, `create`, `get` in new operations.
10. **10 domains**: The domain list is fixed at 10. New functionality maps to existing domains.

---

## 12. Glossary

| Term | Definition |
|------|-----------|
| **BRAIN** | Cognitive memory system backed by brain.db. Stores observations, decisions, patterns, learnings. |
| **CQRS** | Command Query Responsibility Segregation. Reads (query) and writes (mutate) are separate gateways. |
| **Dispatch** | The central routing layer that resolves domain + operation to a handler. |
| **Domain** | One of 10 canonical runtime boundaries (tasks, session, memory, etc.). |
| **Engine** | Adapter layer between domain handlers and core business logic. |
| **FTS5** | SQLite Full-Text Search extension, version 5. Used by brain.db for text search. |
| **Gateway** | One of two MCP tools: `cleo_query` (read) or `cleo_mutate` (write). |
| **LAFS** | Progressive disclosure protocol. Controls which operations and fields are visible. |
| **LOOM** | Lifecycle management system. Pipeline domain + manifest + release orchestration. |
| **MANIFEST.jsonl** | Append-only artifact ledger owned by the pipeline domain. |
| **NEXUS** | Cross-project coordination system backed by nexus.db. |
| **OperationDef** | TypeScript interface defining a single dispatchable operation. |
| **RCSD** | Research, Construction, Stabilization, Deployment -- the lifecycle stage model. |
| **SSoT** | Single Source of Truth. For operations, this is registry.ts. |
| **Tier** | Progressive disclosure level (0=basic, 1=extended, 2=full). |
| **brain.db** | SQLite database with FTS5 storing cognitive memory (5 tables). |
| **tasks.db** | SQLite database storing task hierarchy, audit log, lifecycle pipelines. |

---

## References

- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` -- Normative operation reference
- `docs/specs/VERB-STANDARDS.md` -- Canonical verb standards
- `docs/specs/CLEO-BRAIN-SPECIFICATION.md` -- BRAIN capability specification
- `docs/specs/MCP-SERVER-SPECIFICATION.md` -- MCP server contract
- `.cleo/adrs/ADR-009-BRAIN-cognitive-architecture.md` -- BRAIN architecture decision
- `src/dispatch/registry.ts` -- Executable SSoT for operations
- `src/dispatch/types.ts` -- Canonical type definitions
