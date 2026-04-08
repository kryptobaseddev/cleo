# CLEO System Flow Atlas

**Version**: 2026.3.18
**Status**: APPROVED
**Date**: 2026-03-18
**Task**: T5250, T5722

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
| **LOOM** | pipeline | check, orchestrate | Lifecycle management (RCASD-IVTR+C stages), artifact ledger, release orchestration |
| **NEXUS** | nexus | admin | Cross-project coordination, registry, dependency graph, and `nexus.share.*` relay operations |
| **LAFS** | (cross-cutting) | all domains | Progressive disclosure protocol, field selection, envelope verbosity |

### Workshop Vocabulary Mapping

The realm also uses a secondary workshop language for how work is shaped. This language is conceptual and maps onto the existing domains rather than creating new runtime boundaries:

| Term | Primary Domain(s) | Meaning |
|------|-------------------|---------|
| **Sticky Notes** | sticky | Quick project-wide capture before formal classification. Supports conversion to tasks or memory. Stored in brain.db (`brain_sticky_notes`) with optional tags and priority. |
| **Thread** | tasks | A task-level strand of work |
| **Warp** | pipeline, check | The vertical protocol chains (workflow shape + quality gates) that hold the Tapestry together |
| **Loom** | pipeline, tasks | An epic-scale working frame for related Threads |
| **Tapestry** | pipeline, orchestrate | A composed body of work made from multiple Looms |
| **Tessera** | pipeline, orchestrate, tools | A reusable composition pattern for generating Tapestries |
| **Cogs** | tools | Discrete callable capabilities and integrations |
| **Cascade** | pipeline, orchestrate, check | A Tapestry moving through live gates and thresholds |
| **Tome** | memory, nexus | Living readable canon rendered from durable system knowledge |

### Autonomous Workshop Overlay

The live workshop also has named runtime forms for autonomous motion. These names remain overlays on the same ten canonical domains, but they are not all the same kind of thing:

| Term | Runtime Type | Primary Domain(s) | Meaning |
|------|--------------|-------------------|---------|
| **The Hearth** | surface | session, orchestrate, tools | Terminal-facing workshop surface where active sessions, roles, and capabilities gather |
| **The Circle of Ten** | role overlay | all domains | Role overlay mapped 1:1 to the canonical domains: Smiths, Weavers, Conductors, Artificers, Archivists, Scribes, Wardens, Wayfinders, Catchers, Keepers |
| **The Impulse** | motion | orchestrate, pipeline, tasks | Self-propelling motion that advances ready work through governed chains |
| **Conduit** | relay path | orchestrate, session, nexus | Agent relay path using LAFS envelopes and A2A delegation only. `sticky` may hold drafted handoff material, but it is not the live relay lane |
| **Watchers** | patrols | pipeline, orchestrate, check, admin | Long-running Cascades that patrol health, continuity, and gate state |
| **The Sweep** | quality loop | check, pipeline, orchestrate | Quality patrol loop expressed as review, repair, and re-verification |
| **Refinery** | convergence gate | pipeline, check, orchestrate | Convergence gate where changes are proven ready to join and advance |
| **Looming Engine** | decomposition service | pipeline, tasks, orchestrate, tools | Tessera-driven decomposition into Looms, Threads, and executable work paths |
| **Living BRAIN** | memory overlay | memory, session, nexus | Active neural-memory overlay on durable observations, patterns, and retrieval |
| **The Proving** | validation ground | check, pipeline | End-to-end validation of artifacts, gates, provenance, and outcomes |

Zero custom protocols remain canon. Conduit speaks through LAFS envelopes and A2A delegation, and Watchers are long-running Cascades through the pipeline rather than separate daemon domains.

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
| brain.db  |   |tasks.db  | |tasks.db| |nexus.db  |   |
+-----------+   |(pipeline | |        | |(global   |   |
                |Manifest  | +--------+ | XDG)     |   |
                | table)   |            +----------+   |
                +----------+                           |
                                                       |
 +------+----+   +----------+ +--------+ +----------+
 |  tasks    |   | session  | | admin  | |  sticky  |
 |  domain   |   | domain   | | domain | |  domain  |
 |           |   |          | |        | |          |
 | tasks.db  |   |tasks.db  | |config  | |brain.db  |
 +-----------+   |(sessions | |.json   | |(table)   |
                 | table)   | +--------+ +----------+
                 +----------+

 +------+----+   +----------+   +----------+
 |  tools    |   |orchestrate|  |  nexus   |
 |  domain   |   |  domain   |  |  domain  |
 |           |   |           |  |          |
 |.cleo/     |   | tasks.db  |  |nexus.db  |
 |skills/    |   +-----------+  +----------+
 +-----------+
```

---

## 3. Package Boundary

`@cleocode/core` is the standalone business logic kernel. The `@cleocode/cleo` product assembles it together with the `cleo` CLI and the dispatch routing layer. The CLI is the sole runtime surface:

```
+-----------------------------------------------------------+
|                   @cleocode/cleo                          |
|  (the cleo CLI product, published on npm)                 |
|                                                           |
|  +--------------------------------------------+           |
|  |  packages/cleo/src/cli/                    |           |
|  |  citty entry (index.ts:411-420)            |           |
|  |  ~89 command handlers under commands/      |           |
|  +---------------------+----------------------+           |
|                        |                                  |
|                        v   dispatchRaw(gateway,           |
|                            domain, op, params)            |
|                                                           |
|  +---------------------+----------------------+           |
|  |  packages/cleo/src/dispatch/               |           |
|  |  adapters/cli.ts -> middleware -> registry |           |
|  |  -> domain handler -> engine               |           |
|  |  (internal CQRS tag: query | mutate)       |           |
|  +---------------------+----------------------+           |
|                        |                                  |
|  +---------------------+------------------------------+   |
|  |                @cleocode/core                      |   |
|  |  (standalone package -- installable independently) |   |
|  |                                                    |   |
|  |  The four canonical systems implemented as modules:|   |
|  |  BRAIN -> memory/          LOOM -> lifecycle/      |   |
|  |  NEXUS -> nexus/ (partial) LAFS -> output.ts       |   |
|  |                                                    |   |
|  |  Domains: tasks, sessions, memory, orchestration,  |   |
|  |           lifecycle, release, admin + 30+ modules  |   |
|  |                                                    |   |
|  |  Imports NOTHING from packages/cleo/src/{cli,dispatch}/ |
|  |  @cleocode/contracts (types only, zero runtime deps)|  |
|  +----------------------------------------------------+   |
|                                                           |
|  +------------------------------------------------------+ |
|  |  Bundled Store Layer  (SQLite via Drizzle ORM)       | |
|  |  packages/core/src/store/                             | |
|  |  tasks.db   brain.db   signaldock.db   nexus.db (XDG)| |
|  +------------------------------------------------------+ |
+-----------------------------------------------------------+
```

### Consumer Patterns for @cleocode/core

Consumers who install `@cleocode/core` directly (without `@cleocode/cleo`) can use it three ways:

```typescript
// Facade pattern
const cleo = await Cleo.init('./project');
await cleo.tasks.add({ title: 'foo', description: 'bar' });
await cleo.sessions.start({ name: 'sess', scope: 'T123' });

// Tree-shaking pattern
import { addTask, startSession, observeBrain } from '@cleocode/core';

// Custom store pattern
import { Cleo } from '@cleocode/core';
import type { DataAccessor } from '@cleocode/core';
const cleo = await Cleo.init('./project', { store: myAccessor });
```

See `docs/specs/CORE-PACKAGE-SPEC.md` for the normative contract.

---

## 4. End-to-End Request Flow

Every CLEO operation follows the same path through the dispatch architecture. The CLI is the sole runtime surface; programmatic consumers bypass it by importing `@cleocode/core` directly.

```
User Input  (shell, agent, script)
    |
    v
+------------------------------+
|   cleo CLI (citty runMain)   |    packages/cleo/src/cli/index.ts:411-420
|   ~89 command handlers       |    packages/cleo/src/cli/commands/*.ts
+--------------+---------------+
               |
               v   dispatchRaw(gateway, domain, operation, params)
               |
+--------------+---------------+
|  CLI dispatch adapter        |    packages/cleo/src/dispatch/adapters/cli.ts:246-276
|  builds DispatchRequest      |    source = 'cli'  (types.ts: Source = 'cli' only)
+--------------+---------------+
               |
               v
+--------------+---------------+
|  Middleware pipeline         |    adapters/cli.ts:95-106
|  sessionResolver -> sanitizer|
|  -> fieldFilter -> audit     |
+--------------+---------------+
               |
               v
+--------------+---------------+
|  Dispatch Registry           |    packages/cleo/src/dispatch/registry.ts
|  resolves domain + operation |    each OperationDef carries an internal
|  -> OperationDef             |    CQRS tag: gateway = 'query' | 'mutate'
+--------------+---------------+
               |
               v
+--------------+---------------+
|  Domain Handler              |    packages/cleo/src/dispatch/domains/{domain}.ts
|  handler.query() or          |    routes to a specific engine function
|  handler.mutate()            |
+--------------+---------------+
               |
               v
+--------------+---------------+
|  Engine Layer                |    packages/cleo/src/dispatch/engines/{engine}.ts
|  translates params, calls    |
|  typed core functions        |
+--------------+---------------+
               |
               v
+--------------+---------------+
|  @cleocode/core              |    packages/core/src/{module}/
|  standalone business logic   |    imports NOTHING from cli/ or dispatch/
+--------------+---------------+
               |
               v
+--------------+---------------+
|  Store Layer                 |    packages/core/src/store/
|  atomic.ts, drizzle adapters |    atomic writes, SQLite transactions
+--------------+---------------+
               |
               v
  +-----------+-------+-----------+-----------+
  |           |       |           |           |
  v           v       v           v           v
tasks.db  brain.db  signaldock   nexus.db    config.json /
                      .db         (global     project-info.json
(per-project)                     XDG)        (per-project JSON)
```

### Request Lifecycle

1. **Invoke**: User runs `cleo <command>`. citty parses arguments and dispatches to a command handler under `packages/cleo/src/cli/commands/`.
2. **Dispatch**: The command handler calls `dispatchRaw(gateway, domain, operation, params)` (`packages/cleo/src/dispatch/adapters/cli.ts:246-276`). The CLI is the only place `Source = 'cli'` is set.
3. **Middleware**: Request flows through `sessionResolver -> sanitizer -> fieldFilter -> audit` (`adapters/cli.ts:95-106`).
4. **Resolve**: Registry looks up `OperationDef` by `domain + operation` (`packages/cleo/src/dispatch/registry.ts`). Returns `E_INVALID_OPERATION` if not found. The registry entry's internal `gateway` tag (`query` or `mutate`) determines which handler method is called.
5. **Validate**: Required params are checked. Returns `E_INVALID_INPUT` if missing.
6. **Handle**: Domain handler (`packages/cleo/src/dispatch/domains/{domain}.ts`) routes to the appropriate engine function via `handler.query()` or `handler.mutate()`.
7. **Execute**: Engine (`packages/cleo/src/dispatch/engines/{engine}.ts`) calls typed functions in `@cleocode/core`. For tasks, `tasks.update` with `status=done` routes to `tasks.complete` semantics.
8. **Store**: Core writes to SQLite (or reads, for queries) using atomic operations and Drizzle ORM.
9. **Respond**: `DispatchResponse` is constructed and returned through the chain. The CLI adapter serializes to LAFS JSON or human output per `--human` flag.

In autonomous operation, the same path may be entered from The Hearth, advanced by The Impulse, and revisited by Watchers and The Sweep. The runtime path does not change the contract.

---

## 5. Domain Interaction Graph

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
    |  nexus   |    |  sticky  |
    | (cross-  |    | (quick   |
    |  project)|    |  capture)|
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

## 6. Data Stores and Ownership Boundaries

CLEO runs on four SQLite databases. Sessions and pipeline manifests live in **tables inside `tasks.db`**, not in JSON files or `.jsonl` ledgers. The only surviving `.jsonl` ledger in the tree is `.cleo/agent-outputs/MANIFEST.jsonl` (orchestrator output ledger, unrelated to the pipeline manifest table).

### SQLite Databases

| Store | Owner Domain(s) | Location | Purpose |
|-------|-----------------|----------|---------|
| `tasks.db` | tasks, session, pipeline, admin, check | `.cleo/tasks.db` (per-project) | Task hierarchy + status, `sessions` table (session lifecycle and handoff data -- see `packages/core/src/store/session-store.ts` and `packages/core/src/store/tasks-schema.ts:141-182`), `pipelineManifest` table (research artifact ledger -- see `packages/core/src/memory/pipeline-manifest-sqlite.ts`), audit log, ADRs, compliance data |
| `brain.db` | memory, sticky | `.cleo/brain.db` (per-project) | Observations, decisions, patterns, learnings, memory links, FTS5 search, vector similarity, `brain_sticky_notes` table |
| `signaldock.db` | orchestrate, tools | `.cleo/signaldock.db` (per-project) | ~22-table agent messaging substrate |
| `nexus.db` | nexus | `~/.local/share/cleo/nexus.db` (**global XDG**) | Cross-project registry, dependency graph, and `nexus.share.*` relay state. Guarded to the global tier by `packages/core/src/store/nexus-sqlite.ts` |

### Project-Local Files (per-project, flat on disk)

| Path | Owner | Purpose |
|------|-------|---------|
| `.cleo/config.json` | admin | Project configuration |
| `.cleo/project-info.json` | admin | Project identity + git remote + detection info |
| `.cleo/project-context.json` | admin | Runtime context for LLM hints (toolchain, conventions) |
| `.cleo/memory-bridge.md` | memory | Static seed file injected into provider context (auto-refreshed) |
| `.cleo/metrics/` | check | Compliance data, grades (`GRADES.jsonl`), telemetry |
| `.cleo/backups/` | admin | Recovery backup store (`sqlite/`, `snapshot/`, `safety/`, `archive/`, `migration/`) |
| `.cleo/logs/` | admin | Runtime logs |
| `.cleo/rcasd/` | pipeline | RCASD stage artifacts |
| `.cleo/adrs/` | pipeline | Architecture Decision Records |
| `.cleo/agent-outputs/MANIFEST.jsonl` | orchestrate | Orchestrator output ledger (distinct from the `pipelineManifest` table) |
| `.cleo/skills/` | tools | Skill definitions and configuration |

### Global XDG Files (`~/.local/share/cleo/`)

| Path | Purpose |
|------|---------|
| `nexus.db` | Global cross-project registry (SQLite) -- see above |
| `templates/` | Shared templates (CLEO-INJECTION.md, adapter manifests, etc.) |

### Ownership Rules

- Each store has primary owner domains that perform writes.
- Other domains MAY read from stores they do not own.
- Cross-domain writes MUST go through the owning domain's operations.
- All writes use atomic patterns: temp file -> validate -> backup -> rename for JSON, SQLite transactions for databases.

---

## 7. LOOM Distillation Flow

LOOM is the conceptual system that manages the lifecycle pipeline and artifact ledger. The distillation flow describes how artifacts in the `pipelineManifest` table (inside `tasks.db`) feed into `brain.db` observations.

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
| pipelineManifest |    <-- Append-only artifact ledger, INSIDE tasks.db
|  table (in       |    <-- See packages/core/src/memory/pipeline-manifest-sqlite.ts
|  tasks.db)       |    <-- Entries: { type, content, taskId, timestamp, ... }
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

## 8. Query/Mutate Flow Examples

The `query` and `mutate` terms below refer to the internal CQRS tag on each registry operation. Every invocation is entered the same way: a `cleo <command>` shell call.

### Example 1: memory.find (internal tag: query)

Search for cognitive memory entries matching a keyword.

```
User runs:
  cleo memory find "atomic"

Flow:
  CLI (citty command handler: packages/cleo/src/cli/commands/memory.ts)
    -> CLI dispatch adapter: dispatchRaw("query", "memory", "find", { query: "atomic" })
    -> Middleware: sessionResolver -> sanitizer -> fieldFilter -> audit
    -> Registry: resolve("memory", "find") -> OperationDef (tier 1, gateway: 'query')
    -> Validate: requiredParams ["query"] -> present
    -> Domain Handler: packages/cleo/src/dispatch/domains/memory.ts :: query("find", params)
    -> Engine: packages/cleo/src/dispatch/engines/engine-compat.ts :: searchBrainCompact()
    -> Core: packages/core/src/memory/brain-search.ts :: searchBrainCompact("atomic")
    -> Store: brain.db FTS5 query across observations, decisions, patterns, learnings
    -> Response: { success: true, data: { results: [...], count: N } }
```

### Example 2: pipeline.manifest.append (internal tag: mutate)

Append a research artifact to the pipeline manifest ledger.

```
User / agent runs:
  cleo pipeline manifest append --type research --content "..."

Flow:
  CLI (citty command handler: packages/cleo/src/cli/commands/pipeline.ts)
    -> CLI dispatch adapter: dispatchRaw("mutate", "pipeline", "manifest.append", { entry: { type: "research", content: "..." } })
    -> Middleware: sessionResolver -> sanitizer -> fieldFilter -> audit
    -> Registry: resolve("pipeline", "manifest.append") -> OperationDef (tier 1, gateway: 'mutate')
    -> Validate: requiredParams ["entry"] -> present
    -> Domain Handler: packages/cleo/src/dispatch/domains/pipeline.ts :: mutate("manifest.append", params)
    -> Engine: packages/cleo/src/dispatch/engines/pipeline-manifest-compat.ts :: appendManifestEntry()
    -> Core: packages/core/src/memory/pipeline-manifest-sqlite.ts :: append row
    -> Store: INSERT into pipelineManifest table in tasks.db via SQLite transaction
    -> Response: { success: true, data: { entryId: "M-abc123" } }
```

### Example 3: session.context.inject (internal tag: mutate)

Inject a protocol's context into the current session.

```
User / agent runs:
  cleo session context inject --protocol research --task T5241

Flow:
  CLI (citty command handler: packages/cleo/src/cli/commands/session.ts)
    -> CLI dispatch adapter: dispatchRaw("mutate", "session", "context.inject", { protocolType: "research", taskId: "T5241" })
    -> Middleware: sessionResolver -> sanitizer -> fieldFilter -> audit
    -> Registry: resolve("session", "context.inject") -> OperationDef (tier 1, gateway: 'mutate')
    -> Validate: requiredParams ["protocolType"] -> present
    -> Domain Handler: packages/cleo/src/dispatch/domains/session.ts :: mutate("context.inject", params)
    -> Engine: loads protocol content from CAAMP catalog
    -> Response: { success: true, data: { protocol: "research", content: "..." } }
```

---

## 9. Progressive Disclosure in Practice

Progressive disclosure minimizes the cognitive load on agents by starting with a small operation set and expanding on demand.

### Scenario: Agent Discovers Memory Operations

```
Step 1: Agent starts session (tier 0)
  cleo session start --scope T5241
  -> Agent sees: tasks, session, check, pipeline, orchestrate, tools, admin ops

Step 2: Agent needs to recall past decisions
  cleo help --tier 1
  -> Agent now sees: + memory domain (17 ops), + manifest ops, + session advanced

Step 3: Agent searches brain.db
  cleo memory find "authentication"
  -> Returns matching observations, decisions, patterns, learnings

Step 4: Agent stores a new learning
  cleo memory learning store --insight "JWT tokens require refresh" --source T5241
```

### Tier Budget

| Tier | Operations | % of Total | Typical User |
|------|-----------|------------|--------------|
| 0 | 135 | 65% | All agents |
| 1 | 36 | 17% | Agents needing memory/manifest |
| 2 | 36 | 17% | Orchestrators, admins |

---

## 10. Failure and Recovery Paths

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
    +-- E_DEPENDENCY_ERROR / E_GATE_DEPENDENCY -> Caller resolves dependencies or verification gates before retry
    |
    +-- E_LIFECYCLE_GATE_FAILED -> Caller satisfies strict lifecycle/verification gate requirements
    |
    +-- E_INTERNAL -> Check audit log, restore from backup if needed
    |
    +-- E_RATE_LIMITED -> Wait for resetMs, retry
```

---

## 11. Observability and Audit Trails

### Audit Log

Every mutate operation appends to the audit log in `tasks.db`. The audit log is append-only and captures:

- Operation name (domain.operation)
- Timestamp
- Parameters (sanitized)
- Result (success/failure)
- Session ID (if bound)

### Session History

Session lifecycle events are recorded in the `sessions` table in `tasks.db` (see `packages/core/src/store/session-store.ts` and `packages/core/src/store/tasks-schema.ts:141-182`). Each session tracks:

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
    "source": "cli",
    "requestId": "req-abc123",
    "sessionId": "S-001"
  }
}
```

The `gateway` field here is the internal CQRS tag on the registry operation (`query` or `mutate`). The `source` field is always `"cli"` because the CLI is the sole runtime surface (`packages/cleo/src/dispatch/types.ts` declares `Source = 'cli'`).

---

## 12. Canonical Invariants

These rules MUST always hold true in a correct CLEO installation:

1. **Registry is SSoT**: `packages/cleo/src/dispatch/registry.ts` defines all valid operations. No operation exists outside this array.
2. **Atomic writes**: All store mutations use the temp -> validate -> backup -> rename pattern. No direct file overwrites.
3. **Old names fail**: Removed operation names return `E_INVALID_OPERATION`. There is no silent fallback.
4. **CQRS separation**: Query operations MUST NOT modify state. Mutate operations MAY modify state.
5. **Schema validation**: All data writes are validated against JSON Schema before commit.
6. **Anti-hallucination**: Task operations enforce uniqueness, completeness, and temporal validity.
7. **Domain ownership**: Each data store has exactly one owning domain. Cross-domain writes go through the owner.
8. **Append-only audit**: The audit log in tasks.db is append-only. Entries are never modified or deleted.
9. **Canonical verbs**: All operation names use verbs from `docs/specs/VERB-STANDARDS.md`. No `search`, `create`, `get` in new operations.
10. **10 domains**: The domain list is fixed at 10. New functionality maps to existing domains.
11. **Completion consistency**: `tasks.complete` is canonical for `done`; `tasks.update status=done` MUST route through the same completion enforcement path.
12. **Verification default**: Task completion verification enforcement is default-on and only disabled by explicit project config (`verification.enabled=false`).

---

## 13. Glossary

| Term | Definition |
|------|-----------|
| **BRAIN** | Cognitive memory system backed by brain.db. Stores observations, decisions, patterns, learnings. |
| **CQRS** | Command Query Responsibility Segregation. Reads (query) and writes (mutate) are separate gateways. |
| **Dispatch** | The central routing layer that resolves domain + operation to a handler. |
| **Domain** | One of 10 canonical runtime boundaries (tasks, session, memory, etc.). |
| **Engine** | Adapter layer between domain handlers and core business logic. |
| **FTS5** | SQLite Full-Text Search extension, version 5. Used by brain.db for text search. |
| **Gateway** | Internal CQRS tag attached to every registry operation: `query` (read) or `mutate` (write). The dispatcher uses the tag to route to `handler.query()` vs `handler.mutate()`. It is not a public protocol. |
| **LAFS** | Progressive disclosure protocol. Controls which operations and fields are visible. |
| **LOOM** | Lifecycle management system. Pipeline domain + manifest + release orchestration. |
| **pipelineManifest** | Append-only artifact ledger owned by the pipeline domain. Stored as a table inside `tasks.db` (see `packages/core/src/memory/pipeline-manifest-sqlite.ts`). |
| **NEXUS** | Cross-project coordination system backed by nexus.db. |
| **OperationDef** | TypeScript interface defining a single dispatchable operation. |
| **RCASD-IVTR+C** | Research, Consensus, Architecture Decision, Specification, Decomposition, Implementation, Validation, Testing, Release + Contribution -- the lifecycle stage model. |
| **SSoT** | Single Source of Truth. For operations, this is registry.ts. |
| **Tier** | Progressive disclosure level (0=basic, 1=extended, 2=full). |
| **brain.db** | SQLite database with FTS5 storing cognitive memory (5 tables). |
| **tasks.db** | SQLite database storing task hierarchy, audit log, lifecycle pipelines. |

---

## References

- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` -- Normative operation reference
- `docs/specs/CORE-PACKAGE-SPEC.md` -- @cleocode/core standalone package contract
- `docs/specs/VERB-STANDARDS.md` -- Canonical verb standards
- `docs/specs/CLEO-BRAIN-SPECIFICATION.md` -- BRAIN capability specification
- `packages/cleo/src/cli/index.ts` -- citty CLI entry (`runMain(defineCommand(...))` at lines 411-420)
- `packages/cleo/src/dispatch/adapters/cli.ts` -- CLI dispatch adapter, `dispatchRaw` at lines 246-276
- `packages/cleo/src/dispatch/registry.ts` -- Executable SSoT for operations
- `packages/cleo/src/dispatch/types.ts` -- Canonical type definitions (`Source = 'cli'` only)
- `packages/core/src/store/session-store.ts` + `packages/core/src/store/tasks-schema.ts:141-182` -- Sessions table inside tasks.db
- `packages/core/src/memory/pipeline-manifest-sqlite.ts` -- Pipeline manifest table inside tasks.db
- `packages/core/src/store/nexus-sqlite.ts` -- Global XDG guard for nexus.db
