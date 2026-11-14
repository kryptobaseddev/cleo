# CLEO Operation Constitution

**Version**: 2026.4.42
**Status**: APPROVED
**Date**: 2026-04-14
**Task**: T565 (update); T451 (prior update); T5721 (original)
**Supersedes**: CLEO-OPERATIONS-REFERENCE.md
**ADR**: ADR-042 (conduit domain disposition and registry alignment)

---

## 1. Authority

`packages/cleo/src/dispatch/registry.ts` is the executable single source of truth (SSoT) for all CLEO operations. This document is derived from the registry and MUST stay synchronized with it. When conflicts exist between this document and the registry, the registry wins.

All operations are defined as `OperationDef` entries in the `OPERATIONS` array. No operation exists unless it appears in that array. No legacy alias is honored unless it appears there.

---

## 2. Runtime Scope

CLEO exposes exactly **2 dispatch gateways** following the CQRS (Command Query Responsibility Segregation) pattern:

| Gateway | Purpose |
|---------|---------|
| `query` | Read-only operations. MUST NOT modify state. Safe to retry. |
| `mutate` | State-changing operations. MAY modify data stores, sessions, or configuration. |

All operations are addressed as `{domain}.{operation}` within their gateway. CLI commands route through the dispatch layer:

```
cleo show T123              →  dispatch("query", "tasks", "show", { id: "T123" })
cleo observe "discovered…"  →  dispatch("mutate", "memory", "observe", { text: "..." })
```

---

## 3. Operation Routing Architecture

### Dispatch vs Core

CLEO separates two distinct concerns:

- **`@cleocode/core`** (`packages/core/src/`) — business logic with a direct, typed function API. No string addressing. Usable standalone without the CLI layer.
- **`packages/cleo/src/dispatch/`** — string-addressed routing layer inside `@cleocode/cleo`. Translates CLI requests into typed core function calls. NOT part of `@cleocode/core`.

```
CLI: cleo add "My task" --description "Details"
  → packages/cleo/src/dispatch/engines/task-engine.ts  (routing)
    → @cleocode/core tasks.add()         (business logic)
      → SQLite store                     (persistence)
```

### API Style Contrast

```typescript
// Core API — direct, typed (used by app developers via @cleocode/core):
const cleo = await Cleo.init('./project');
await cleo.tasks.add({ title: 'foo', description: 'bar' });

// Dispatch API — string-addressed (used internally by the CLI gateway):
dispatch('mutate', 'tasks', 'add', { title: 'foo', description: 'bar' });
```

### Package Boundary

`packages/cleo/src/dispatch/` remains inside `@cleocode/cleo` because it is the adapter layer for CLI string-based routing. It is not published as part of `@cleocode/core`. Consumers who import `@cleocode/core` directly call typed functions; they do not go through dispatch.

```
@cleocode/cleo (CLI product)
  ├── packages/cleo/src/cli/       → citty commands → dispatch → core API
  ├── packages/cleo/src/dispatch/ → string-addressed routing → core API  [stays in @cleocode/cleo]
  └── @cleocode/core → typed function API  [standalone kernel]
```

---

## 4. Canonical Domains

CLEO defines exactly **11 canonical domains**. These are the runtime contract. Conceptual systems (BRAIN, LOOM, NEXUS, LAFS) are overlays, not domains.

| Domain | Purpose | Primary Store |
|--------|---------|---------------|
| `tasks` | Task hierarchy, CRUD, dependencies, work tracking | tasks.db |
| `session` | Session lifecycle, decisions, assumptions, context | tasks.db (sessions table) |
| `memory` | Cognitive memory: observations, decisions, patterns, learnings | brain.db |
| `check` | Schema validation, protocol compliance, test execution, grading | tasks.db (audit) |
| `pipeline` | RCASD-IVTR+C lifecycle stages, manifest ledger, release management | tasks.db (pipelineManifest table) |
| `orchestrate` | Multi-agent coordination, wave planning, parallel execution | tasks.db |
| `tools` | Skills, providers, CAAMP catalog | .cleo/skills/ |
| `admin` | Configuration, backup, migration, diagnostics, ADRs, protocol injection | config.json, tasks.db |
| `nexus` | Cross-project coordination, registry, dependency graph | nexus.db |
| `sticky` | Ephemeral project-wide capture, quick notes before formal task creation | brain.db |
| `intelligence` | Predictive quality analysis: risk scoring, gate focus, pattern matching | brain.db + tasks.db |

The canonical domain list is defined in `packages/cleo/src/dispatch/types.ts` as:

```typescript
export const CANONICAL_DOMAINS = [
  'tasks', 'session', 'memory', 'check', 'pipeline',
  'orchestrate', 'tools', 'admin', 'nexus', 'sticky',
  'intelligence',
] as const;
```

---

## 5. Canonical Verbs

All operation names MUST use canonical verbs as defined in `docs/specs/VERB-STANDARDS.md`. The following verbs are approved for use in operation names:

| Verb | Purpose | Example |
|------|---------|---------|
| `add` | Create new entity | `tasks.add` |
| `show` | Read single entity | `tasks.show`, `memory.show` |
| `list` | Read multiple entities | `tasks.list`, `nexus.list` |
| `find` | Search/discover entities | `tasks.find`, `memory.find` |
| `update` | Modify entity | `tasks.update` |
| `delete` | Permanently remove | `tasks.delete` |
| `archive` | Soft-delete | `tasks.archive` |
| `restore` | Restore from terminal state | `tasks.restore` |
| `complete` | Mark work finished | `tasks.complete` |
| `start` | Begin work | `tasks.start`, `session.start` |
| `stop` | Stop work | `tasks.stop` |
| `end` | Terminate session | `session.end` |
| `status` | Check current state | `session.status`, `nexus.status` |
| `record` | Log structured event | `session.record.decision` |
| `resume` | Continue paused work | `session.resume` |
| `suspend` | Pause without ending | `session.suspend` |
| `reset` | Emergency state reset | `pipeline.stage.reset` |
| `init` | Initialize system | `admin.init`, `nexus.init` |
| `backup` | Create backup or restore from backup | `admin.backup` |
| `migrate` | Schema migration | `admin.migrate` |
| `inject` | Protocol injection | `admin.context.inject` |
| `run` | Execute action (compound only) | `check.test.run` |
| `link` | Associate entities | `memory.link` |
| `observe` | Save observation | `memory.observe` |
| `store` | Append-only memory write | `memory.decision.store` |
| `fetch` | Batch retrieve by IDs | `memory.fetch` |
| `plan` | Composite planning view | `tasks.plan` |
| `sync` | Synchronize data | `nexus.sync` |
| `validate` | Validate compliance/schema | `pipeline.stage.validate`, `check.schema` |
| `timeline` | Chronological context retrieval | `memory.timeline` |
| `convert` | Transform entity type | `sticky.convert` |
| `resolve` | Resolve cross-reference query | `nexus.resolve` |
| `ship` | Execute multi-step release | `pipeline.release.ship` |

> **Note**: `convert` on `sticky.convert` is an accepted VERB-STANDARDS exception — the operation converts an ephemeral sticky note into a persistent task, which has no canonical-verb equivalent.

Deprecated verbs (`create`, `get`, `search`, `query` as verb, `enable`, `disable`, `unarchive`, `reopen`) MUST NOT appear in new operations.

---

## 6. Operation Model

Every operation is defined by the `OperationDef` interface:

```typescript
interface OperationDef {
  gateway: 'query' | 'mutate';     // CQRS gateway
  domain: CanonicalDomain;          // One of 11 canonical domains
  operation: string;                // Dot-notation name (e.g. 'stage.validate')
  description: string;              // Brief description
  tier: 0 | 1 | 2;                 // Progressive disclosure tier
  idempotent: boolean;              // Safe to retry?
  sessionRequired: boolean;         // Requires active session?
  requiredParams: string[];         // Keys that MUST be present
  params?: ParamDef[];              // Full parameter descriptors (optional)
  aliases?: string[];               // Backward-compatible aliases
  escalationHint?: string;          // Tier-2 clusters: hint emitted by admin.help
}
```

**Field semantics:**

- **gateway**: Determines which dispatch gateway handles the operation. Query operations MUST NOT modify state.
- **tier**: Controls progressive disclosure. Agents start at tier 0 and escalate. See Section 8.
- **idempotent**: When `true`, the operation is safe to retry on failure without side effects.
- **requiredParams**: The dispatcher validates these are present before routing to the domain handler. Missing params return `E_INVALID_INPUT`.
- **aliases**: Old operation names that still resolve to this definition. Aliases appear in gateway matrices for validation but route to the canonical handler.
- **escalationHint**: Optional. For tier-2 operations with no lower-tier entry point, this string is emitted by `admin.help` in its tier-0/1 response as a "more available" summary.

---

## 7. Domain Operation Tables

### 6.1 tasks (32 operations)

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `show` | Show task details by ID | 0 | `taskId` | Yes |
| query | `list` | List tasks with filters | 1 | -- | Yes |
| query | `find` | Search tasks by keyword | 0 | -- | Yes |
| query | `tree` | Display task hierarchy tree | 1 | -- | Yes |
| query | `blockers` | Show blocking dependencies | 1 | -- | Yes |
| query | `depends` | Show dependency graph | 1 | -- | Yes |
| query | `analyze` | Analyze task metrics | 1 | -- | Yes |
| query | `next` | Suggest next task to work on | 0 | -- | Yes |
| query | `plan` | Composite planning view (epics, ready, blocked, bugs) | 0 | -- | Yes |
| query | `relates` | Show related tasks; accepts `mode:"suggest"\|"discover"` | 1 | `taskId` | Yes |
| query | `complexity.estimate` | Estimate task complexity | 1 | `taskId` | Yes |
| query | `current` | Show currently active task | 0 | -- | Yes |
| query | `history` | Show task work history (time tracked per task) | 1 | -- | Yes |
| query | `label.list` | List all labels; accepts optional `label` filter | 1 | -- | Yes |
| query | `sync.links` | List external task links by provider or task ID | 1 | -- | Yes |
| mutate | `add` | Create new task | 0 | `title` | No |
| mutate | `update` | Modify task properties (`status=done` MUST route to completion semantics) | 0 | `taskId` | No |
| mutate | `complete` | Canonical completion path (deps, acceptance policy, verification gates) | 0 | `taskId` | No |
| mutate | `cancel` | Cancel task (soft terminal state — reversible via `restore`) | 1 | `taskId` | No |
| mutate | `delete` | Permanently remove task | 1 | `taskId` | No |
| mutate | `archive` | Soft-delete task to archive | 1 | -- | No |
| mutate | `restore` | Restore task from terminal state; accepts `from:"done"\|"archive"` | 1 | `taskId` | No |
| mutate | `reparent` | Move task to new parent; `newParentId: null` promotes to top-level | 1 | `taskId` | No |
| mutate | `reorder` | Reorder tasks within parent | 1 | `taskId`, `position` | No |
| mutate | `relates.add` | Add task relationship | 1 | `taskId`, `type` | No |
| mutate | `start` | Begin working on task | 0 | `taskId` | No |
| mutate | `stop` | Stop working on task | 0 | -- | No |
| mutate | `sync.reconcile` | Reconcile external tasks with CLEO as SSoT | 1 | `providerId`, `externalTasks` | No |
| mutate | `sync.links.remove` | Remove all external task links for a provider | 1 | `providerId` | Yes |
| query | `impact` | Predict downstream effects of a change using keyword matching and reverse dependency graph traversal | 1 | -- | Yes |
| mutate | `claim` | Claim a task by assigning it to the current session (multi-agent mutex ownership) | 0 | `taskId` | No |
| mutate | `unclaim` | Unclaim a task by removing the current assignee; pair of `tasks.claim` | 0 | `taskId` | No |

**Canonical additions (ADR-042):**
- `tasks.impact` — blast-radius planning utility for orchestrators; non-substitutable by any existing query
- `tasks.claim` / `tasks.unclaim` — mutex ownership pair for multi-agent parallelism (promoted per T443 audit)

**Merged operations (removed from registry):**
- `tasks.exists` → use `tasks.find {exact:true}` and check `results.length > 0`
- `tasks.reopen` → use `tasks.restore {from:"done"}`
- `tasks.unarchive` → use `tasks.restore {from:"archive"}`
- `tasks.promote` → use `tasks.reparent {newParentId: null}`
- `tasks.relates.find` → use `tasks.relates {mode:"suggest"|"discover"}`
- `tasks.label.show` → use `tasks.label.list {label}`

### 6.2 session (15 operations)

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `status` | Show current session status | 0 | -- | Yes |
| query | `list` | List sessions | 1 | -- | Yes |
| query | `show` | Show session details; accepts `include:["debrief","history"]` | 1 | -- | Yes |
| query | `decision.log` | Show session decision log | 1 | -- | Yes |
| query | `context.drift` | Detect context drift in session | 1 | -- | Yes |
| query | `handoff.show` | Show handoff data from most recent ended session | 0 | -- | Yes |
| query | `briefing.show` | Composite session-start context briefing | 0 | -- | Yes |
| query | `find` | Lightweight session discovery | 1 | -- | Yes |
| mutate | `start` | Begin new session | 0 | -- | No |
| mutate | `end` | End current session | 0 | -- | No |
| mutate | `resume` | Resume suspended session | 1 | -- | No |
| mutate | `suspend` | Suspend session without ending | 1 | -- | No |
| mutate | `gc` | Garbage-collect stale sessions | 1 | -- | No |
| mutate | `record.decision` | Record a decision in current session | 1 | -- | No |
| mutate | `record.assumption` | Record an assumption in current session | 1 | -- | No |

**Merged operations (removed from registry):**
- `session.history` → use `session.show {include:["history"]}` if implemented, or audit log query
- `session.chain.show` → navigate via `session.show` → `previousSessionId`/`nextSessionId`
- `session.debrief.show` → use `session.show {include:["debrief"]}`

**Moved operations:**
- `session.context.inject` → moved to `admin.context.inject` (reads protocol files from filesystem; correct admin home)

### 6.3 memory (18 operations)

All memory operations target **brain.db** (SQLite with FTS5). The memory domain is the runtime interface to the BRAIN cognitive system.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `find` | Cross-table brain.db FTS5 search | 0 | `query` | Yes |
| query | `timeline` | Chronological context around anchor entry | 1 | `anchor` | Yes |
| query | `fetch` | Batch fetch brain entries by IDs | 1 | `ids` | Yes |
| query | `decision.find` | Search decisions in brain.db | 1 | -- | Yes |
| query | `pattern.find` | Search patterns by type, impact, or keyword | 1 | -- | Yes |
| query | `learning.find` | Search learnings by confidence, actionability, or keyword | 1 | -- | Yes |
| query | `graph.show` | Show knowledge graph structure | 1 | -- | Yes |
| query | `graph.neighbors` | Find neighboring entries in the knowledge graph | 1 | -- | Yes |
| query | `reason.why` | Explain reasoning chain for a decision or pattern | 1 | -- | Yes |
| query | `reason.similar` | Find similar reasoning patterns | 1 | -- | Yes |
| query | `search.hybrid` | Hybrid search combining FTS5 and graph traversal | 1 | -- | Yes |
| mutate | `observe` | Save observation to brain.db | 0 | `text` | No |
| mutate | `decision.store` | Store decision to brain.db | 1 | `decision`, `rationale` | No |
| mutate | `pattern.store` | Store reusable workflow or anti-pattern | 1 | `pattern`, `context` | No |
| mutate | `learning.store` | Store insight or lesson learned | 1 | `insight`, `source` | No |
| mutate | `link` | Link brain entry to task | 1 | `taskId`, `entryId` | No |
| mutate | `graph.add` | Add edge to knowledge graph | 1 | -- | No |
| mutate | `graph.remove` | Remove edge from knowledge graph | 1 | -- | No |

**Removed operations:**
- `memory.show` → use `memory.fetch {ids: [id]}` (single-element array)
- `memory.stats` → not replaced (dashboard metric, not agent workflow)
- `memory.contradictions` → not replaced
- `memory.superseded` → not replaced
- `memory.pattern.stats` → not replaced
- `memory.learning.stats` → not replaced
- `memory.unlink` → not replaced (direct repair via `memory.link` if needed)

**Promoted to tier 0:** `memory.find` and `memory.observe` (both appear in the mandatory efficiency sequence)

### 6.4 check (18 operations)

Includes 3 operations moved in from admin.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `schema` | Validate data against JSON Schema | 1 | -- | Yes |
| query | `protocol` | Check protocol compliance; accepts `protocolType` param | 1 | -- | Yes |
| query | `task` | Validate task data integrity | 1 | -- | Yes |
| query | `manifest` | Validate manifest entries | 1 | -- | Yes |
| query | `output` | Validate command output format | 1 | -- | Yes |
| query | `compliance.summary` | Compliance summary report; `detail:true` includes violations | 1 | -- | Yes |
| query | `coherence` | Check cross-data coherence (renamed from `coherence.check`) | 1 | -- | Yes |
| query | `test` | Show test suite status or coverage; accepts `format:"status"\|"coverage"` | 1 | -- | Yes |
| query | `gate.status` | Read-only view of verification gate state | 1 | `taskId` | Yes |
| query | `chain.validate` | Validate a WarpChain definition | 2 | `chain` | Yes |
| query | `grade` | Grade agent behavioral session (5-dimension rubric) | 2 | `sessionId` | Yes |
| query | `grade.list` | List grade history | 2 | -- | Yes |
| query | `archive.stats` | Archive statistics and analytics | 1 | -- | Yes |
| mutate | `compliance.record` | Record compliance check result | 1 | -- | No |
| mutate | `compliance.sync` | Sync project compliance metrics to global | 1 | -- | No |
| mutate | `test.run` | Execute test suite | 1 | -- | No |
| mutate | `gate.set` | Set or reset verification gate state | 1 | `taskId` | No |
| query | `workflow.compliance` | WF-001..WF-005 compliance dashboard: AC rate, session rate, gate rate (cross-session aggregate metrics) | 1 | -- | Yes |

**Canonical additions (ADR-042):**
- `check.workflow.compliance` — T065 agent workflow compliance telemetry; distinct schema-level behavior not covered by any existing check operation

**Merged operations (removed from registry):**
- `check.compliance.violations` → use `check.compliance.summary {detail:true}`
- `check.coherence.check` → renamed to `check.coherence`
- `check.test.status` + `check.test.coverage` → unified as `check.test {format:"status"|"coverage"}`
- `check.protocol.consensus` → use `check.protocol {protocolType:"consensus"}`
- `check.protocol.contribution` → use `check.protocol {protocolType:"contribution"}`
- `check.protocol.decomposition` → use `check.protocol {protocolType:"decomposition"}`
- `check.protocol.implementation` → use `check.protocol {protocolType:"implementation"}`
- `check.protocol.specification` → use `check.protocol {protocolType:"specification"}`
- `check.gate.verify` → split into `check.gate.status` (query) + `check.gate.set` (mutate)

**Moved in from admin:**
- `admin.grade` → `check.grade`
- `admin.grade.list` → `check.grade.list`
- `admin.archive.stats` → `check.archive.stats`

### 6.5 pipeline (32 operations)

The pipeline domain manages RCASD-IVTR+C lifecycle stages, the pipelineManifest table in tasks.db, and release orchestration. The entire domain is tier 1 except WarpChain (`chain.*`) which is tier 2.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `stage.validate` | Validate lifecycle stage prerequisites (includes prerequisites in response) | 1 | -- | Yes |
| query | `stage.status` | Show lifecycle stage status; `include:["gates"]` returns gate definitions | 1 | -- | Yes |
| query | `stage.history` | Show lifecycle stage history | 1 | -- | Yes |
| query | `manifest.show` | Get manifest entry by ID | 1 | `entryId` | Yes |
| query | `manifest.list` | List manifest entries; `filter:"pending"` returns pending items | 1 | -- | Yes |
| query | `manifest.find` | Search manifest entries by text | 1 | `query` | Yes |
| query | `manifest.stats` | Manifest statistics | 1 | -- | Yes |
| query | `release.list` | List releases | 1 | -- | Yes |
| query | `release.show` | Show release details | 1 | -- | Yes |
| query | `release.channel.show` | Show branch-to-channel mapping | 1 | -- | Yes |
| query | `phase.show` | Show phase details by slug or current phase | 1 | -- | Yes |
| query | `phase.list` | List all phases with status and task counts | 1 | -- | Yes |
| query | `chain.show` | Get chain definition by ID | 2 | `chainId` | Yes |
| query | `chain.list` | List all chain definitions | 2 | -- | Yes |
| mutate | `stage.record` | Record lifecycle stage completion | 1 | -- | No |
| mutate | `stage.skip` | Skip a lifecycle stage | 1 | -- | No |
| mutate | `stage.reset` | Reset lifecycle stage (emergency) | 1 | -- | No |
| mutate | `stage.gate.pass` | Mark lifecycle gate as passed | 1 | -- | No |
| mutate | `stage.gate.fail` | Mark lifecycle gate as failed | 1 | -- | No |
| mutate | `manifest.append` | Append entry to pipelineManifest table | 1 | `entry` | No |
| mutate | `manifest.archive` | Archive old manifest entries | 1 | `beforeDate` | No |
| mutate | `phase.set` | Set the active phase; absorbs `phase.start` and `phase.complete` via action param | 1 | `phaseId` | No |
| mutate | `phase.advance` | Complete current phase and start next | 1 | -- | No |
| mutate | `phase.rename` | Rename a phase and update all task references | 1 | `oldName`, `newName` | No |
| mutate | `phase.delete` | Delete a phase with task reassignment protection | 1 | `phaseId` | No |
| mutate | `release.ship` | Execute release step; accepts `step:"prepare"\|"changelog"\|"commit"\|"tag"\|"push"\|"gates"` | 1 | -- | No |
| mutate | `release.rollback` | Rollback failed release | 1 | -- | No |
| mutate | `release.cancel` | Cancel in-progress release | 1 | -- | No |
| mutate | `chain.add` | Store a validated chain definition | 2 | `chain` | No |
| mutate | `chain.instantiate` | Create chain instance for epic | 2 | `chainId`, `epicId` | No |
| mutate | `chain.advance` | Advance instance to next stage | 2 | `instanceId`, `nextStage` | No |
| query | `stage.guidance` | Stage-aware LLM prompt guidance; Pi extensions shell out to this on `before_agent_start` (ADR-035) | 1 | -- | Yes |

**Canonical additions (ADR-042):**
- `pipeline.stage.guidance` — active Pi harness usage on agent start; removing it would break a mandatory workflow

**Merged operations (removed from registry):**
- `pipeline.stage.gates` → use `pipeline.stage.status {include:["gates"]}`
- `pipeline.stage.prerequisites` → always included in `pipeline.stage.validate` response
- `pipeline.manifest.pending` → use `pipeline.manifest.list {filter:"pending"}`
- `pipeline.release.prepare` → use `pipeline.release.ship {step:"prepare"}`
- `pipeline.release.changelog` → use `pipeline.release.ship {step:"changelog"}`
- `pipeline.release.commit` → use `pipeline.release.ship {step:"commit"}`
- `pipeline.release.tag` → use `pipeline.release.ship {step:"tag"}`
- `pipeline.release.push` → use `pipeline.release.ship {step:"push"}`
- `pipeline.release.gates.run` → use `pipeline.release.ship {step:"gates"}`
- `pipeline.phase.start` → use `pipeline.phase.set {action:"start"}`
- `pipeline.phase.complete` → use `pipeline.phase.set {action:"complete"}`
- `pipeline.chain.find` → removed from registry
- `pipeline.chain.gate.pass` → removed from registry
- `pipeline.chain.gate.fail` → removed from registry

### 6.6 orchestrate (19 canonical operations)

The core orchestrate operations are tier 1. CleoOS dispatch ops (`classify`, `fanout`, `fanout.status`) are tier 2. All operations are orchestrator-specific and not needed at cold-start.

> **Note (T964 — supersedes ADR-042 Decision 1)**: The five `conduit.*`
> operations formerly nested under this domain were promoted to the canonical
> `conduit` domain (see Section 6.12). The `cleo orchestrate conduit-*`
> subcommands remain as backward-compatible CLI aliases.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `status` | Orchestration status | 1 | -- | Yes |
| query | `next` | Next orchestration action | 1 | -- | Yes |
| query | `ready` | Check orchestration readiness | 1 | -- | Yes |
| query | `analyze` | Analyze orchestration state; `mode:"critical-path"` for critical path analysis | 1 | -- | Yes |
| query | `context` | Orchestration context for handoff injection | 1 | -- | Yes |
| query | `waves` | Parallel execution wave plan | 1 | -- | Yes |
| query | `bootstrap` | Orchestration bootstrap info | 1 | -- | Yes |
| query | `unblock.opportunities` | Find unblock opportunities | 1 | -- | Yes |
| query | `tessera.list` | List all Tessera templates; optional `id` param for single template | 1 | -- | Yes |
| mutate | `start` | Start orchestration | 1 | -- | No |
| mutate | `spawn` | Spawn sub-agent | 1 | -- | No |
| mutate | `spawn.execute` | Execute spawn for task using adapter registry | 1 | `taskId` | No |
| mutate | `validate` | Validate orchestration state | 1 | -- | No |
| mutate | `parallel` | Begin or end parallel execution wave; `action:"start"\|"end"` | 1 | -- | No |
| mutate | `handoff` | Composite handoff (context.inject -> session.end -> spawn) | 1 | `taskId`, `protocolType` | No |
| mutate | `tessera.instantiate` | Instantiate a Tessera template into a chain instance | 1 | `templateId`, `epicId` | No |
| query | `classify` | Classify a request against CANT team registry to route to correct team, lead, and protocol | 2 | -- | Yes |
| mutate | `fanout` | Fan out N spawn requests in parallel via `Promise.allSettled` (RCASD wave execution) | 2 | -- | No |
| query | `fanout.status` | Get status of a running fanout by its manifest entry ID; polling complement to `orchestrate.fanout` | 2 | -- | Yes |

**Canonical additions (ADR-042):**
- `orchestrate.classify` — core CANT-based request routing primitive; non-substitutable
- `orchestrate.fanout` — workhorse of multi-agent parallel dispatch (RCASD waves)
- `orchestrate.fanout.status` — polling complement to `fanout`; forms an atomic pair

**T964 — conduit promoted out:** The 5 `conduit.*` operations formerly listed
under orchestrate have been relocated to the canonical `conduit` domain (see
Section 6.12). See also `.cleo/agent-outputs/T910-reconciliation/conduit-collision-research.md`.

**Merged operations (removed from registry):**
- `orchestrate.critical.path` → use `orchestrate.analyze {mode:"critical-path"}`
- `orchestrate.tessera.show` → use `orchestrate.tessera.list {id}`
- `orchestrate.parallel.start` → use `orchestrate.parallel {action:"start"}`
- `orchestrate.parallel.end` → use `orchestrate.parallel {action:"end"}`

**Removed phantom operations (were never registered):**
- `orchestrate.chain.plan` — dead handler code, not in registry
- `orchestrate.verify` — dead handler code, not in registry

### 6.7 tools (25 operations)

The tools domain aggregates skills, providers, and the CAAMP catalog. Six `issue.*` operations have been extracted to the `ct-github-issues` plugin and are not counted in core.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `issue.diagnostics` | CLEO install integrity check (not GitHub-specific) | 1 | -- | Yes |
| query | `skill.list` | List installed skills | 0 | -- | Yes |
| query | `skill.show` | Show skill details | 1 | -- | Yes |
| query | `skill.find` | Search skills | 1 | -- | Yes |
| query | `skill.dispatch` | Dispatch skill execution | 1 | -- | Yes |
| query | `skill.verify` | Verify skill frontmatter | 1 | -- | Yes |
| query | `skill.dependencies` | Show skill dependencies | 1 | -- | Yes |
| query | `skill.spawn.providers` | List spawn-capable providers by capability | 1 | -- | Yes |
| query | `skill.catalog` | CAAMP catalog lookup; `type:"protocols"\|"profiles"\|"resources"\|"info"` | 2 | -- | Yes |
| query | `skill.precedence` | Skill precedence mapping; `action:"show"\|"resolve"` | 1 | -- | Yes |
| query | `provider.list` | List registered providers | 0 | -- | Yes |
| query | `provider.detect` | Detect available providers | 0 | -- | Yes |
| query | `provider.inject.status` | Provider injection status | 1 | -- | Yes |
| query | `provider.supports` | Check if provider supports capability | 1 | -- | Yes |
| query | `provider.hooks` | List providers by hook event support | 1 | -- | Yes |
| mutate | `skill.install` | Install skill | 1 | -- | No |
| mutate | `skill.uninstall` | Uninstall skill | 1 | -- | No |
| mutate | `skill.refresh` | Refresh skill catalog | 1 | -- | No |
| mutate | `provider.inject` | Inject provider configuration | 1 | -- | No |
| query | `adapter.list` | List all discovered provider adapters | 2 | -- | Yes |
| query | `adapter.show` | Show details for a specific adapter | 2 | `id` | Yes |
| query | `adapter.detect` | Detect active providers in current environment | 2 | -- | Yes |
| query | `adapter.health` | Health status for adapters | 2 | -- | Yes |
| mutate | `adapter.activate` | Load and activate a provider adapter | 2 | `id` | No |
| mutate | `adapter.dispose` | Dispose one or all adapters | 2 | -- | Yes |

**Extracted to `ct-github-issues` plugin (6 ops removed from core):**
- `tools.issue.templates` — reads `.github/ISSUE_TEMPLATE/`; GitHub coupling
- `tools.issue.validate.labels` — validates against GitHub label set
- `tools.issue.add.bug` — creates GitHub issues via template
- `tools.issue.add.feature` — creates GitHub issues via template
- `tools.issue.add.help` — creates GitHub issues via template
- `tools.issue.generate.config` — removed entirely (stub with no real behavior)

**Removed operations (VERB-STANDARDS violations or stubs):**
- `tools.skill.enable` → use `tools.skill.install`
- `tools.skill.disable` → use `tools.skill.uninstall`
- `tools.skill.configure` → removed (returned `{configured:true}` stub with no real behavior)

**Merged operations:**
- `tools.skill.catalog.protocols`, `tools.skill.catalog.profiles`, `tools.skill.catalog.resources`, `tools.skill.catalog.info` → unified as `tools.skill.catalog {type}`
- `tools.skill.precedence.show`, `tools.skill.precedence.resolve` → unified as `tools.skill.precedence {action}`

**Moved in from admin:**
- `admin.sync` / `admin.sync.status` / `admin.sync.clear` → Removed (TodoWrite system replaced by provider-agnostic reconciliation engine in `@cleocode/core`)

### 6.8 admin (37 canonical operations; 39 in registry including 2 experimental)

Includes 1 operation moved in from session. ADR-042 added 7 canonical ops. `admin.map` (query and mutate forms) are experimental and excluded from the canonical count — they remain in the registry for development use.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `version` | Show CLEO version | 0 | -- | Yes |
| query | `health` | System health check; `mode:"check"\|"diagnose"` | 0 | -- | Yes |
| query | `config.show` | Show configuration value | 1 | -- | Yes |
| query | `stats` | Project statistics | 1 | -- | Yes |
| query | `context` | Project context info | 1 | -- | Yes |
| query | `runtime` | Runtime environment info | 1 | -- | Yes |
| query | `job` | Background job status or list; `action:"status"\|"list"` | 1 | -- | Yes |
| query | `dash` | Dashboard overview | 0 | -- | Yes |
| query | `log` | Read audit log | 1 | -- | Yes |
| query | `sequence` | Show sequence counter state | 1 | -- | Yes |
| query | `help` | Operations list and guidance (progressive disclosure) | 0 | -- | Yes |
| query | `adr.find` | Fuzzy search ADRs; absent query = list all | 1 | -- | Yes |
| query | `adr.show` | Retrieve single ADR by ID with frontmatter | 2 | `adrId` | Yes |
| query | `export` | Export tasks; `scope:"snapshot"\|"package"` | 2 | -- | Yes |
| query | `token` | Token telemetry; `action:"summary"\|"list"\|"show"` | 2 | -- | Yes |
| mutate | `init` | Initialize CLEO project | 1 | -- | No |
| mutate | `config.set` | Set configuration value | 1 | -- | No |
| mutate | `backup` | Create backup or restore; `action:"create"\|"restore"\|"file-restore"` | 1 | -- | No |
| mutate | `migrate` | Run schema migrations | 1 | -- | No |
| mutate | `cleanup` | Clean up stale data | 1 | -- | No |
| mutate | `job.cancel` | Cancel background job | 1 | -- | No |
| mutate | `safestop` | Graceful shutdown with state preservation | 1 | -- | No |
| mutate | `inject.generate` | Generate injection content | 1 | -- | No |
| mutate | `install.global` | Refresh global CLEO setup (providers, CLI configs) | 2 | -- | Yes |
| mutate | `adr.sync` | Sync ADR markdown files; `validate:true` also validates frontmatter | 2 | -- | Yes |
| mutate | `import` | Import tasks; `scope:"snapshot"\|"package"` | 2 | `file` | No |
| mutate | `token` | Token telemetry write; `action:"record"\|"delete"\|"clear"` | 2 | -- | No |
| mutate | `detect` | Refresh project-context.json — re-detect project type and LLM hints | 1 | -- | Yes |
| mutate | `context.inject` | Inject protocol content into context (moved from session) | 1 | `protocolType` | Yes |
| mutate | `health` | Auto-repair failed health checks; `mode:"repair"` | 1 | -- | No |
| query | `paths` | Report all CleoOS paths (project + global hub) and scaffolding status | 1 | -- | Yes |
| query | `smoke` | Operational smoke test: one read-only query per domain; validates all domains reachable in a single call | 0 | -- | Yes |
| mutate | `scaffold-hub` | Create CleoOS Hub directories (global-recipes, pi-extensions, cant-workflows, agents) and seed starter justfile (ADR-035) | 1 | -- | Yes |
| query | `config.presets` | List all strictness presets with descriptions and values; companion to `admin.config.set-preset` | 1 | -- | Yes |
| mutate | `config.set-preset` | Apply a named strictness preset (strict, standard, minimal); non-substitutable by `admin.config.set` | 1 | -- | Yes |
| query | `hooks.matrix` | Cross-provider hook support matrix using CAAMP canonical taxonomy | 1 | -- | Yes |
| query | `backup` | List available backups (read-only); use `admin.backup` mutate to create or restore | 1 | -- | Yes |

**Canonical additions (ADR-042):**
- `admin.paths` — diagnostic utility for agents troubleshooting installation or path issues
- `admin.smoke` — lightweight domain-reachability check; essential for CI and post-upgrade verification (tier 0)
- `admin.scaffold-hub` — bootstrapping operation for Hub architecture; absence forces manual directory creation
- `admin.config.presets` — read-only companion required before any `config.set-preset` call
- `admin.config.set-preset` — prescribed preset-profile application; non-substitutable by `config.set`
- `admin.hooks.matrix` — cross-provider hook visibility for agents selecting execution environments
- `admin.backup` (query) — list-backups companion to the existing mutate form; previously undocumented gateway

**Merged operations (removed from registry):**
- `admin.doctor` → use `admin.health {mode:"diagnose"}`
- `admin.fix` → use `admin.health {mode:"repair"}` (mutate gateway)
- `admin.restore` → use `admin.backup {action:"restore"}`
- `admin.backup.restore` → use `admin.backup {action:"file-restore"}`
- `admin.job.list` → use `admin.job {action:"list"}`
- `admin.adr.list` → use `admin.adr.find` with no query parameter
- `admin.adr.validate` → use `admin.adr.sync {validate:true}`
- `admin.snapshot.export` → use `admin.export {scope:"snapshot"}`
- `admin.export.tasks` → use `admin.export {scope:"package"}`
- `admin.snapshot.import` → use `admin.import {scope:"snapshot"}`
- `admin.import.tasks` → use `admin.import {scope:"package"}`
- `admin.token.list` → use `admin.token {action:"list"}`
- `admin.token.show` → use `admin.token {action:"show"}`
- `admin.token.delete` → use `admin.token {action:"delete"}` (mutate)
- `admin.token.clear` → use `admin.token {action:"clear"}` (mutate)
- `admin.token.record` → use `admin.token {action:"record"}` (mutate)
- `admin.sequence` (mutate form) → removed; use `admin.config.set` if needed

**Moved out:**
- `admin.sync` / `admin.sync.status` / `admin.sync.clear` → Removed (TodoWrite system replaced by provider-agnostic reconciliation engine in `@cleocode/core`)
- `admin.grade` → `check.grade`
- `admin.grade.list` → absorbed into `check.grade {action:"list"}`
- `admin.archive.stats` → `check.archive.stats`

**Moved in from session:**
- `session.context.inject` → `admin.context.inject`

### 6.9 nexus (22 operations)

`nexus.status` and `nexus.list` are promoted to tier 1 as the discovery entry points. All other nexus operations are tier 2.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `status` | Overall NEXUS health status | 1 | -- | Yes |
| query | `list` | List all registered NEXUS projects | 1 | -- | Yes |
| query | `show` | Show specific project by name or hash | 2 | `name` | Yes |
| query | `resolve` | Resolve cross-project `project:taskId` reference (renamed from `nexus.query`) | 2 | `query` | Yes |
| query | `deps` | Cross-project dependency analysis | 2 | `query` | Yes |
| query | `graph` | Global dependency graph across all projects | 2 | -- | Yes |
| query | `path.show` | Show critical dependency path across projects | 2 | -- | Yes |
| query | `blockers.show` | Show blocking impact for a task query | 2 | `query` | Yes |
| query | `orphans.list` | List orphaned cross-project dependencies | 2 | -- | Yes |
| query | `discover` | Discover related tasks across registered projects | 2 | `query` | Yes |
| query | `search` | Search for patterns across registered projects | 2 | `query` | Yes |
| query | `share.status` | Sharing status | 2 | -- | Yes |
| mutate | `init` | Initialize NEXUS (creates registry and directories) | 2 | -- | Yes |
| mutate | `register` | Register a project in NEXUS | 2 | `path` | No |
| mutate | `unregister` | Remove a project from NEXUS | 2 | `name` | No |
| mutate | `sync` | Sync project metadata; absent `name` syncs all projects | 2 | -- | Yes |
| mutate | `permission.set` | Update project permissions | 2 | `name`, `level` | Yes |
| mutate | `reconcile` | Reconcile project identity with global nexus registry | 2 | -- | Yes |
| mutate | `share.snapshot.export` | Export project snapshot | 2 | -- | No |
| mutate | `share.snapshot.import` | Import project snapshot | 2 | -- | No |
| query | `transfer.preview` | Preview a cross-project task transfer without committing; required safety step before `nexus.transfer` | 2 | `taskIds`, `sourceProject`, `targetProject` | Yes |
| mutate | `transfer` | Transfer tasks between NEXUS projects (cross-DB operation) | 2 | `taskIds`, `sourceProject`, `targetProject` | No |

**Canonical additions (ADR-042):**
- `nexus.transfer.preview` — mandatory safety check before any cross-project transfer; no existing op covers it
- `nexus.transfer` — cross-project task handoff capability; non-substitutable by any existing nexus operation

**Removed operations:**
- `nexus.critical-path` — exact alias for `nexus.path.show` (same handler)
- `nexus.blocking` — exact alias for `nexus.blockers.show` (same handler)
- `nexus.orphans` — exact alias for `nexus.orphans.list` (same handler)
- `nexus.share.remotes` — git CLI wrapper (`git remote -v`); no CLEO logic
- `nexus.share.sync.status` — git CLI wrapper; no CLEO logic
- `nexus.share.sync.gitignore` — text append to .gitignore; no CLEO logic
- `nexus.share.remote.add` — wraps `git remote add`
- `nexus.share.remote.remove` — wraps `git remote remove`
- `nexus.share.push` — wraps `git push`
- `nexus.share.pull` — wraps `git pull`
- `nexus.sync.all` → use `nexus.sync` without `name` param

**Renamed operations:**
- `nexus.query` → `nexus.resolve` (`query` is a prohibited verb per VERB-STANDARDS)

**Tier reclassifications:**
- `nexus.status` promoted from tier 2 to tier 1 (nexus filesystem fallback fix)
- `nexus.list` promoted from tier 2 to tier 1 (nexus filesystem fallback fix)
- `nexus.reconcile` demoted from tier 1 to tier 2 (setup/maintenance op)

### 6.10 sticky (6 operations)

All sticky operations are tier 1. Sticky notes are lightweight capture entries that can be converted to tasks or memory.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `list` | List sticky notes | 1 | -- | Yes |
| query | `show` | Show sticky note details | 1 | `stickyId` | Yes |
| mutate | `add` | Create new sticky note | 1 | `content` | No |
| mutate | `convert` | Convert sticky to task or memory | 1 | `stickyId`, `targetType` | No |
| mutate | `archive` | Archive sticky note | 1 | `stickyId` | No |
| mutate | `purge` | Permanently delete sticky notes | 1 | `stickyId` | Yes |

**Tier reclassification:** Entire domain demoted from tier 0 to tier 1. Sticky notes are a convenience layer, not cold-start essentials.

### 6.11 intelligence (5 operations)

The intelligence domain exposes predictive quality analysis functions from `@cleocode/core`. It reads from brain.db and tasks.db to produce risk scores, gate-focus recommendations, and pattern matches. The mutate gateway is unsupported — intelligence writes happen via hooks, not direct dispatch calls.

All 5 operations are tier 1. This domain was introduced in T549 (epic T5149) and first registered alongside the memory architecture v2 initiative.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `predict` | Calculate risk score for a task, or predict validation outcome for a lifecycle stage when `stage` param is provided | 1 | `taskId` | Yes |
| query | `suggest` | Suggest which verification gate(s) to focus on for a task based on historical failure patterns | 1 | `taskId` | Yes |
| query | `learn-errors` | Extract recurring failure patterns from task history and brain.db; optional `limit` param | 1 | -- | Yes |
| query | `confidence` | Score verification confidence for a task based on current gate state and historical evidence | 1 | `taskId` | Yes |
| query | `match` | Match known brain patterns against a task to surface relevant historical context | 1 | `taskId` | Yes |

**Query/mutate split:** Query-only. All 5 operations are read-only against brain.db and tasks.db. No mutate operations exist — writes are performed by the hook system after task completion or session end.

**Escalation path:** All operations are tier 1; reachable via `cleo help --tier 1`. No tier-0 escalation is required since these operations are not part of the cold-start mandatory sequence.

### Summary Counts

> **Canon rule (ADR-044, v2026.4.65)**: The operation count is a **living variable**. The numbers in this section reflect a point-in-time snapshot; `packages/cleo/src/dispatch/registry.ts` is the authoritative source. Future canon writers MUST NOT hard-code a count without anchoring it to a version or date. Drift on the count alone is NOT a drift incident; drift on structure (domain list, system list, taxonomy) IS. See `docs/adr/adr-044-canon-reconciliation.md`.

> **T565 update (v2026.4.42)**: `intelligence` domain added as the 11th canonical domain with 5 query-only operations. 7 experimental operations (`orchestrate.conduit.*` ×5, `admin.map` ×2) remain excluded from this count pending CLI surface and workflow documentation. Registry total is 248 (as of v2026.4.42); constitutional canonical total is 229; 7 experimental ops remain undocumented by design. Current registry count continues to move — run `grep -c "gateway:" packages/cleo/src/dispatch/registry.ts` for the live number.

> **ADR-042 update (v2026.4.24)**: 17 canonical operations added across 6 domains. Registry total was 231; constitutional canonical total was 224 prior to this update.

| Domain | Query | Mutate | Total |
|--------|-------|--------|-------|
| tasks | 16 | 16 | 32 |
| session | 8 | 7 | 15 |
| memory | 11 | 7 | 18 |
| check | 14 | 4 | 18 |
| pipeline | 15 | 17 | 32 |
| orchestrate | 11 | 8 | 19 |
| tools | 19 | 6 | 25 |
| admin | 20 | 17 | 37 |
| nexus | 13 | 9 | 22 |
| sticky | 2 | 4 | 6 |
| intelligence | 5 | 0 | 5 |
| **Total** | **134** | **95** | **229** |

> Orchestrate counts no longer include the 5 `conduit.*` operations — T964 promoted them to the canonical `conduit` domain (see Section 6.12 / `ADR-042` superseded). Admin counts exclude `admin.map` (query and mutate forms) which are experimental. The registry is the authoritative source of truth for the current operation count.

---

## 8. Progressive Disclosure Contract

Operations are organized into 3 tiers. Agents SHOULD start at tier 0 and escalate only when needed:

### Tier 0 -- Core (24 operations minimum)

Available to all agents from session start. Contains only operations an agent reasonably needs before it has any project context.

| Domain | Tier 0 ops | Operations |
|--------|-----------|------------|
| tasks | 10 | show, find, next, plan, current, add, update, complete, start, stop |
| session | 5 | status, handoff.show, briefing.show, start, end |
| memory | 2 | find, observe |
| admin | 4 | version, health, dash, help |
| tools | 3 | skill.list, provider.list, provider.detect |

All other domains have 0 ops at tier 0. The gap between 24 and the ≤90 soft target is intentional headroom. Additional ops may be promoted to tier 0 as operational data confirms their cold-start utility.

**Mandatory tier 0 ops (non-negotiable — appear in the mandatory efficiency sequence):**

| CLI Command | Operation | Why mandatory |
|-------------|-----------|---------------|
| `cleo session status` | `session.status` | Step 1 of mandatory efficiency sequence |
| `cleo dash` | `admin.dash` | Step 2 of mandatory efficiency sequence |
| `cleo current` | `tasks.current` | Step 3 of mandatory efficiency sequence |
| `cleo next` | `tasks.next` | Step 4 of mandatory efficiency sequence |
| `cleo show <id>` | `tasks.show` | Step 5 of mandatory efficiency sequence |
| `cleo session start` | `session.start` | Agent work loop begin |
| `cleo complete <id>` | `tasks.complete` | Agent work loop end |
| `cleo memory find <q>` | `memory.find` | Memory protocol read (3-layer step 1) |
| `cleo observe <text>` | `memory.observe` | Memory protocol write |
| `cleo help` | `admin.help` | Escalation path entry point |

### Tier 1 -- Extended

Memory, manifest, and advanced query operations. Agents escalate here when they need cognitive memory, lifecycle operations, or research artifact access.

**Domains**: memory, session (extended), tasks (extended), session, check, pipeline, orchestrate, tools, admin (extended), sticky, nexus (entry points: status, list)

### Tier 2 -- Full System

Cross-project coordination, WarpChain operations, advanced tooling, and administrative functions. Used by orchestrator agents and system administrators.

**Domains**: nexus (core operations) plus advanced operations across admin, tools, pipeline (chain), and check (chain)

### Tier Escalation

An agent discovers tier 1+ operations via `cleo help`:

```
cleo help              -- tier 0 ops
cleo help --tier 1     -- + tier 1
cleo help --tier 2     -- all ops
```

---

## 9. Injection Contract

Protocol injection is performed via `admin.context.inject` (mutate gateway):

```
cleo context inject --protocol research --task T123 --variant default
```

Dispatch equivalent:

```typescript
dispatch('mutate', 'admin', 'context.inject', {
  protocolType: 'research',    // required
  taskId: 'T123',              // optional
  variant: 'default',          // optional
});
```

Valid `protocolType` values are defined by the CAAMP catalog and skill registry. Common types include `research`, `orchestrator`, `lifecycle`, and `validator`.

> **Note**: `admin.context.inject` was previously `session.context.inject`. The operation reads protocol files from the filesystem — it is a bootstrap/admin utility, not a session state operation.

---

## 10. CLI Dispatch Rules

1. The CLI is the sole interface for CLEO operations. All operations are addressed as `{domain}.{operation}` within their gateway.
2. CLI commands map 1:1 to dispatch operations: `cleo show T123` dispatches to `query tasks.show { id: "T123" }`.
3. CLI MAY provide aliases for convenience (e.g., `cleo done` for `tasks.complete`).
4. Dispatch operation names (`{domain}.{operation}`) are canonical; CLI aliases are cosmetic.
5. All CLI commands route through the shared dispatch layer (`packages/cleo/src/dispatch/`) to `packages/core/src/`.

---

## 11. Cross-Domain Moves and Plugin Boundaries

### Cross-Domain Moves (T5517 rationalization)

Operations moved between domains as part of the 268→195 rationalization. These are semantically correct relocations, not removals.

| Old operation | New operation | Direction | Rationale |
|---------------|---------------|-----------|-----------|
| `session.context.inject` | `admin.context.inject` | session → admin | Reads filesystem protocol files; bootstrap utility, not session state |
| `admin.sync` / `admin.sync.status` / `admin.sync.clear` | Removed | admin → removed | TodoWrite replaced by provider-agnostic reconciliation engine in `@cleocode/core` |
| `admin.grade` | `check.grade` | admin → check | Behavioral grading is a compliance/quality check |
| `admin.grade.list` | `check.grade {action:"list"}` | admin → check | Grade history; same rationale |
| `admin.archive.stats` | `check.archive.stats` | admin → check | Archive analytics; reporting/compliance |

### Plugin Extraction: `ct-github-issues`

Six operations extracted from the core `tools` domain into the `ct-github-issues` plugin. These are no longer counted in the core registry:

| Operation | Reason |
|-----------|--------|
| `tools.issue.templates` | Reads `.github/ISSUE_TEMPLATE/`; GitHub-specific |
| `tools.issue.validate.labels` | Validates against GitHub label set |
| `tools.issue.add.bug` | Creates GitHub issues via template |
| `tools.issue.add.feature` | Creates GitHub issues via template |
| `tools.issue.add.help` | Creates GitHub issues via template |
| `tools.issue.generate.config` | Removed entirely — stub with no real behavior |

`tools.issue.diagnostics` remains in core: it checks CLEO install integrity, not GitHub-specific state.

**Plugin boundary criteria**: An operation belongs in a plugin when (a) it requires an external platform API or SDK, (b) it reads platform-specific configuration files not managed by CLEO, and (c) removing it from core would not break any mandatory agent workflow.

---

## 12. Tier Gate Invariant

No tier-2 gate may exist without an explicit escalation path surfaced at tier 0.

### Rationale

When operations are hidden at tier 2 without visible escalation paths, agents silently fall back to direct filesystem reads (e.g., reading `~/.cleo/projects-registry.json` instead of using nexus CLI operations). This defeats the purpose of progressive disclosure and bypasses all validation and atomic operation guarantees that CLEO provides.

### Enforcement

- Every tier-2 domain MUST have at least one tier-0 or tier-1 escalation path
- The escalation path MUST be discoverable via `admin.help` (tier 0)
- Direct filesystem fallback is never acceptable
- The `escalationHint` field on tier-2 `OperationDef` entries is emitted by `admin.help` in its tier-0/1 response as a "more available at tier 2" section

### Current Escalation Paths

| Domain | Tier-2 ops | Escalation at Tier 0/1 |
|--------|-----------|------------------------|
| nexus | core analysis, setup, sharing ops | `nexus.status` + `nexus.list` at tier 1 (promoted in T5517) |
| pipeline (chain) | `chain.*` (5 ops) | `admin.help --tier 2` via `escalationHint` |
| check (chain) | `chain.validate` | `admin.help --tier 2` via `escalationHint` |
| admin (token) | `admin.token` query + mutate | `admin.stats` at tier 1 hints at token tracking |
| admin (export) | `admin.export`, `admin.import` | `admin.backup` at tier 1 hints at data portability |
| admin (ADR) | `admin.adr.show` | `admin.adr.find` at tier 1 |
| check (grade) | `check.grade` | `admin.help --tier 2` via `escalationHint` |

---

## 13. Validation and CI Enforcement

### Request Validation

1. The dispatcher validates `domain` against `CANONICAL_DOMAINS`.
2. The dispatcher validates `operation` against the registry for the resolved domain.
3. Required parameters are validated via `validateRequiredParams()`.
4. Invalid domain returns `E_INVALID_DOMAIN`.
5. Invalid operation returns `E_INVALID_OPERATION`.
6. Missing required params returns `E_INVALID_INPUT`.

### Schema Validation

All write operations (mutate gateway) validate data against JSON Schema before committing. Validation failures return `E_VALIDATION_FAILED`.

### Anti-Hallucination Checks

Task operations enforce:
- Both `title` AND `description` MUST be present and different.
- Status MUST be a valid enum value.
- IDs MUST be unique across active and archived tasks.
- Timestamps MUST NOT be in the future.
- No duplicate task descriptions.
- `tasks.complete` is the canonical state transition to `done`; `tasks.update status=done` MUST be treated as the same completion flow, not a bypass.
- Completion dependency semantics treat dependency states `done` and `cancelled` as satisfied.
- Acceptance policy is config-driven (`enforcement.acceptance.mode`, `enforcement.acceptance.requiredForPriorities`) and MAY block completion.
- Verification enforcement is default-on (`verification.enabled` defaults true, explicit false disables) and required gates are config-driven (`verification.requiredGates`).
- In strict lifecycle mode, verification gate failures on completion MUST return lifecycle gate failure semantics.

### Registry Admission Gate

New operations added to the registry MUST satisfy the five challenge questions from ADR-030:

1. Is this operation's use case covered by an existing operation with a parameter?
2. Does removing this operation force agents to use the CLI or filesystem instead?
3. Is this operation documented in at least one real agent workflow or mandatory sequence?
4. Does this operation have distinct schema-level behavior (not just a renamed alias for the same handler)?
5. Would a new CLEO user discover this operation naturally via `admin.help` progressive disclosure?

Operations failing questions 1, 4, or 5 without compensating answers to 2 or 3 MUST NOT be admitted to the registry.

---

## 14. Change Control

### Adding Operations

1. Add `OperationDef` entry to `OPERATIONS` array in `packages/cleo/src/dispatch/registry.ts`.
2. Implement handler in the appropriate domain handler (`packages/cleo/src/dispatch/domains/`).
3. Wire core logic in `packages/core/src/`.
4. Update this document (Section 7 tables).
5. Add tests for the new operation.
6. Verify the operation satisfies the five challenge questions (Section 13).

### Removing Operations

1. Remove from `OPERATIONS` array in registry.
2. Old operation names return `E_INVALID_OPERATION` at runtime.
3. Update this document to remove the operation and add migration path to Merged/Removed notes.

### Renaming Operations

1. Add new name to registry.
2. Add old name as `aliases` entry on the new definition.
3. Update this document to reflect the rename.

---

## 15. Appendix A: Error Codes

| Code | Meaning |
|------|---------|
| `E_INVALID_OPERATION` | Domain or operation not found in registry |
| `E_INVALID_INPUT` | Missing required parameters or invalid parameter values |
| `E_NOT_FOUND` | Requested entity does not exist |
| `E_VALIDATION_FAILED` | Schema or anti-hallucination validation failed |
| `E_INTERNAL` | Unexpected internal error |
| `E_NOT_IMPLEMENTED` | Operation is registered but handler is a stub |
| `E_SESSION_REQUIRED` | Operation requires an active session |
| `E_CONCURRENT_MODIFICATION` | Optimistic concurrency conflict |
| `E_RATE_LIMITED` | Rate limit exceeded |

Error responses include machine-readable `code`, human-readable `message`, optional `fix` command, and optional `alternatives` array.

---

## 16. Appendix B: Field Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Operation params | camelCase | `taskId`, `entryId`, `protocolType` |
| Sub-operations | Dot-notation | `stage.validate`, `manifest.show` |
| Domain names | lowercase | `tasks`, `memory`, `pipeline` |
| Gateway names | lowercase | `query`, `mutate` |
| Error codes | UPPER_SNAKE with E_ prefix | `E_NOT_FOUND` |
| JSON response keys | camelCase | `schemaVersion`, `requestId` |
| Metadata keys | _prefixed camelCase | `_meta`, `_fields`, `_mvi` |

---

## 17. Appendix C: Migration Reference (268→195 Rationalization)

Quick reference for agents and code calling removed operations.

| Removed operation | Replacement |
|-------------------|-------------|
| `tasks.exists` | `tasks.find {exact:true}` — check `results.length > 0` |
| `tasks.reopen` | `tasks.restore {taskId, from:"done"}` |
| `tasks.unarchive` | `tasks.restore {taskId, from:"archive"}` |
| `tasks.promote` | `tasks.reparent {taskId, newParentId: null}` |
| `tasks.relates.find` | `tasks.relates {taskId, mode:"suggest"\|"discover"}` |
| `tasks.label.show` | `tasks.label.list {label}` |
| `session.history` | `session.show {id, include:["history"]}` (if implemented) or audit log |
| `session.chain.show` | Navigate via `session.show` → `previousSessionId`/`nextSessionId` |
| `session.debrief.show` | `session.show {id, include:["debrief"]}` |
| `session.context.inject` | `admin.context.inject` (domain changed) |
| `memory.show` | `memory.fetch {ids: [id]}` |
| `memory.stats` | Not replaced — dashboard metric, not agent workflow |
| `memory.unlink` | Not replaced — use `memory.link` for repair |
| `check.compliance.violations` | `check.compliance.summary {detail:true}` |
| `check.coherence.check` | `check.coherence` (renamed) |
| `check.test.status` | `check.test {format:"status"}` |
| `check.test.coverage` | `check.test {format:"coverage"}` |
| `check.protocol.consensus` | `check.protocol {protocolType:"consensus"}` |
| `check.protocol.contribution` | `check.protocol {protocolType:"contribution"}` |
| `check.protocol.decomposition` | `check.protocol {protocolType:"decomposition"}` |
| `check.protocol.implementation` | `check.protocol {protocolType:"implementation"}` |
| `check.protocol.specification` | `check.protocol {protocolType:"specification"}` |
| `check.gate.verify` | `check.gate.status` (query) or `check.gate.set` (mutate) |
| `pipeline.stage.gates` | `pipeline.stage.status {include:["gates"]}` |
| `pipeline.stage.prerequisites` | Always included in `pipeline.stage.validate` response |
| `pipeline.manifest.pending` | `pipeline.manifest.list {filter:"pending"}` |
| `pipeline.release.prepare` | `pipeline.release.ship {step:"prepare"}` |
| `pipeline.release.changelog` | `pipeline.release.ship {step:"changelog"}` |
| `pipeline.release.commit` | `pipeline.release.ship {step:"commit"}` |
| `pipeline.release.tag` | `pipeline.release.ship {step:"tag"}` |
| `pipeline.release.push` | `pipeline.release.ship {step:"push"}` |
| `pipeline.release.gates.run` | `pipeline.release.ship {step:"gates"}` |
| `pipeline.phase.start` | `pipeline.phase.set {action:"start"}` |
| `pipeline.phase.complete` | `pipeline.phase.set {action:"complete"}` |
| `orchestrate.critical.path` | `orchestrate.analyze {mode:"critical-path"}` |
| `orchestrate.tessera.show` | `orchestrate.tessera.list {id}` |
| `orchestrate.parallel.start` | `orchestrate.parallel {action:"start"}` |
| `orchestrate.parallel.end` | `orchestrate.parallel {action:"end"}` |
| `tools.skill.enable` | `tools.skill.install` |
| `tools.skill.disable` | `tools.skill.uninstall` |
| `tools.skill.configure` | Not replaced — was a stub returning `{configured:true}` |
| `tools.skill.catalog.protocols` | `tools.skill.catalog {type:"protocols"}` |
| `tools.skill.catalog.profiles` | `tools.skill.catalog {type:"profiles"}` |
| `tools.skill.catalog.resources` | `tools.skill.catalog {type:"resources"}` |
| `tools.skill.catalog.info` | `tools.skill.catalog {type:"info"}` |
| `tools.skill.precedence.show` | `tools.skill.precedence {action:"show"}` |
| `tools.skill.precedence.resolve` | `tools.skill.precedence {action:"resolve"}` |
| `tools.issue.add.bug` | `ct-github-issues` plugin (after publication) |
| `tools.issue.add.feature` | `ct-github-issues` plugin (after publication) |
| `tools.issue.add.help` | `ct-github-issues` plugin (after publication) |
| `admin.doctor` | `admin.health {mode:"diagnose"}` |
| `admin.fix` | `admin.health {mode:"repair"}` (mutate gateway) |
| `admin.restore` | `admin.backup {action:"restore"}` |
| `admin.backup.restore` | `admin.backup {action:"file-restore"}` |
| `admin.job.list` | `admin.job {action:"list"}` |
| `admin.adr.list` | `admin.adr.find` with no query param |
| `admin.adr.validate` | `admin.adr.sync {validate:true}` |
| `admin.snapshot.export` | `admin.export {scope:"snapshot"}` |
| `admin.export.tasks` | `admin.export {scope:"package"}` |
| `admin.snapshot.import` | `admin.import {scope:"snapshot"}` |
| `admin.import.tasks` | `admin.import {scope:"package"}` |
| `admin.token.list` | `admin.token {action:"list"}` |
| `admin.token.show` | `admin.token {action:"show"}` |
| `admin.token.record` | `admin.token {action:"record"}` |
| `admin.token.delete` | `admin.token {action:"delete"}` |
| `admin.token.clear` | `admin.token {action:"clear"}` |
| `admin.grade` | `check.grade` (domain changed) |
| `admin.grade.list` | `check.grade {action:"list"}` (domain changed) |
| `admin.archive.stats` | `check.archive.stats` (domain changed) |
| `admin.sync` / `admin.sync.status` / `admin.sync.clear` | Removed — use `@cleocode/core` reconciliation engine |
| `nexus.query` | `nexus.resolve` (renamed; `query` is a prohibited verb) |
| `nexus.critical-path` | `nexus.path.show` (alias removed) |
| `nexus.blocking` | `nexus.blockers.show` (alias removed) |
| `nexus.orphans` | `nexus.orphans.list` (alias removed) |
| `nexus.sync.all` | `nexus.sync` (without `name` param syncs all) |

---

## References

- `packages/cleo/src/dispatch/registry.ts` -- Executable SSoT
- `packages/cleo/src/dispatch/types.ts` -- Type definitions
- `docs/specs/VERB-STANDARDS.md` -- Canonical verb standards
- `docs/specs/CLEO-OPERATIONS-REFERENCE.md` -- CLI operations reference
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md` -- Visual architecture guide
- `docs/adr/adr-030-operation-model-rationalization.md` -- Rationalization ADR (T5611)
- `.cleo/agent-outputs/CLEO-OPERATIONS-CONSOLIDATION-DECISION.md` -- Full decision matrix (T5609)
- `.cleo/agent-outputs/T5608-tier-audit.md` -- Tier assignment audit

<!-- merged from `cleo-api-authority-superseded` by cleo docs modernize -->

## From `cleo-api-authority-superseded`

# CLEO API Authority

**Version**: 2.0.0
**Status**: AUTHORITY — pointer document, cite on disagreement
**Scope**: All CLEO dispatch operations, HTTP surfaces, and wire-format contracts
**Style model**: `docs/specs/SCHEMA-AUTHORITY.md`
**Target release**: v2026.4.97 (T962 Wave A+B+D0)

This document defines the authority chain for the CLEO API. When any other
document disagrees with the sources listed here, the sources win. This file is
itself a pointer — it does NOT duplicate content from the canonical sources; it
tells you where to look and in what order.

> **Normative language**: Requirements in this document use RFC 2119 terms
> (MUST, MUST NOT, SHOULD, MAY). Every factual claim carries a
> `file:line` citation.

> **Companion specs**:
> - `docs/specs/CLEO-TASKS-API-SPEC.md` — narrative spec for the TASKS domain
> - `docs/specs/CLEO-STUDIO-HTTP-SPEC.md` — current + proposed HTTP surface
> - `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` — Studio `/tasks` UI contract
> - `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — per-op reference tables

---

## 1. Authority Chain

```
┌────────────────────────────────────────────────────────────────────────────┐
│ LAYER 1 · CODE SSoT (binding)                                              │
│   packages/contracts/src/operations/*.ts     ← wire-format types           │
│   packages/contracts/src/{brain,conduit,lafs,task,session,...}.ts ← shapes │
│   packages/cleo/src/dispatch/registry.ts     ← runtime op registration     │
│   packages/cleo/src/dispatch/domains/*.ts    ← dispatch handlers (LAFS)    │
│   packages/cleo/src/dispatch/adapters/typed.ts ← TypedDomainHandler<O>     │
│   packages/brain/src/                         ← @cleocode/brain (T969)     │
│                                                                            │
│   RULE: when code and docs disagree, code wins.                            │
└────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ LAYER 2 · POINTER (this file)                                              │
│   docs/specs/CLEO-API-AUTHORITY.md                                         │
│                                                                            │
│   RULE: names files, not facts. Update when a new layer-1 file or layer-3  │
│   narrative spec lands.                                                    │
└────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ LAYER 3 · NARRATIVE SPECS (human-readable, cite code)                      │
│   docs/specs/CLEO-TASKS-API-SPEC.md          ← per-domain                  │
│   docs/specs/CLEO-STUDIO-HTTP-SPEC.md        ← HTTP surface                │
│   docs/specs/CLEO-TASK-DASHBOARD-SPEC.md     ← UI-level contract           │
│   docs/specs/CLEO-OPERATION-CONSTITUTION.md  ← full op catalogue           │
│   docs/specs/CLEO-NEXUS-ARCHITECTURE.md      ← NEXUS                       │
│   docs/specs/memory-architecture-spec.md     ← memory (brain.db)           │
│   docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md   ← CONDUIT IPC                 │
│                                                                            │
│   RULE: narrative MUST cite the Layer-1 file:line for every factual claim. │
└────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ LAYER 4 · AUTO-GENERATED                                                   │
│   docs/generated/typescript-api.md  (renamed from api-reference.md)        │
│     — forge-ts dump of TypeScript exports; NOT a dispatch op catalogue     │
│   docs/generated/llms-full.txt · llms.txt · SKILL-monorepo/                │
│                                                                            │
│   RULE: never hand-edit. Regenerate via forge-ts. See §6 for rename.       │
└────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Files | Authority | Update path |
|-------|-------|-----------|-------------|
| 1 — Code SSoT | `packages/contracts/src/operations/*.ts`, `packages/cleo/src/dispatch/registry.ts`, `packages/cleo/src/dispatch/domains/*.ts`, `packages/cleo/src/dispatch/adapters/typed.ts`, `packages/brain/src/` | Binding | Code change + tests |
| 2 — Pointer | `docs/specs/CLEO-API-AUTHORITY.md` (this file) | Non-binding | PR when a Layer-1 or Layer-3 file lands |
| 3 — Narrative | `docs/specs/CLEO-*-SPEC.md`, `CLEO-OPERATION-CONSTITUTION.md` | Non-binding; cites Layer 1 | PR after Layer-1 change |
| 4 — Generated | `docs/generated/typescript-api.md`, `llms-full.txt`, `SKILL-monorepo/` | Non-binding; regenerated | `forge-ts` CI job |

---

## 2. Domain Directory

Every CLEO operation lives at an intersection of (contract file, implementation,
dispatch domain handler, HTTP route prefix, narrative spec). The table below is
the single map from domain to all five.

The canonical domain set is defined at
`packages/cleo/src/dispatch/types.ts:54-70` and contains **15 domains** as of
T964 (v2026.4.97). CONDUIT was promoted from `orchestrate.conduit.*` subops to
a first-class domain in commit `90534e50c`, superseding ADR-042 Decision 1.
A 16th domain slot — `brain` — is RESERVED for the unified-graph super-domain
(T968 contracts shipped; dispatch wire-up is PLANNED, see §2.2).

Citations use absolute paths rooted at the monorepo.

### 2.1 Shipped domains (15 canonical)

| Domain | Contract file | Implementation | Dispatch domain handler | HTTP route prefix | Narrative spec |
|--------|---------------|----------------|-------------------------|-------------------|----------------|
| **tasks** | `packages/contracts/src/operations/tasks.ts` | `packages/core/src/tasks/` | `packages/cleo/src/dispatch/domains/tasks.ts` | `/api/tasks/*` (Studio, read-only today) | `docs/specs/CLEO-TASKS-API-SPEC.md` |
| **session** | `packages/contracts/src/operations/session.ts` | `packages/core/src/sessions/` | `packages/cleo/src/dispatch/domains/session.ts` | *(none)* — PROPOSED `/api/sessions/*` | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.2 |
| **memory** | `packages/contracts/src/operations/memory.ts` (31 ops, renamed from `brain.ts` per T965 at commit `7413b6562`) | `packages/core/src/memory/` | `packages/cleo/src/dispatch/domains/memory.ts` | `/api/brain/*` today — PLANNED `/api/memory/*` per T970 (see §5) | `docs/specs/memory-architecture-spec.md` + `docs/specs/stdp-wire-up-spec.md` |
| **check** | `packages/contracts/src/operations/validate.ts` | `packages/core/src/validation/` | `packages/cleo/src/dispatch/domains/check.ts` | *(none)* | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.11 + `docs/specs/T832-gate-integrity-spec.md` |
| **pipeline** | `packages/contracts/src/operations/release.ts` + `operations/lifecycle.ts` | `packages/core/src/release/` + `packages/cleo/src/dispatch/engines/release-engine.ts` | `packages/cleo/src/dispatch/domains/pipeline.ts` (lifecycle + release route here) | *(none)* | `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md` + `docs/specs/T832-gate-integrity-spec.md` |
| **orchestrate** | `packages/contracts/src/operations/orchestrate.ts` | `packages/core/src/orchestration/` + `packages/cleo/src/dispatch/domains/orchestrate.ts` | `packages/cleo/src/dispatch/domains/orchestrate.ts` | *(none)* — PROPOSED `/api/orchestrate/*` | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.6 + `docs/adr/ADR-052-sdk-consolidation.md` + `docs/adr/ADR-053-playbook-runtime.md` |
| **tools** | `packages/contracts/src/operations/skills.ts` + `operations/issues.ts` + `operations/research.ts` | `packages/skills/`, `packages/core/src/issues/`, `packages/core/src/research/` | `packages/cleo/src/dispatch/domains/tools.ts` | *(none)* | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.7-6.8 + §6.12 |
| **admin** | `packages/contracts/src/operations/system.ts` | `packages/core/src/system/` | `packages/cleo/src/dispatch/domains/admin.ts` | `/api/health` (partial) | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.10 |
| **nexus** | `packages/contracts/src/operations/nexus.ts` (22 ops, T963) | `packages/nexus/src/` | `packages/cleo/src/dispatch/domains/nexus.ts` | `/api/nexus/*` + `/api/search` (Studio, read) + `/api/project/*` (Studio, CLI-backed write) | `docs/specs/CLEO-NEXUS-ARCHITECTURE.md` |
| **sticky** | *(shape types only)* | `packages/core/src/sticky/` | `packages/cleo/src/dispatch/domains/sticky.ts` | *(none)* | `docs/specs/STICKY-NOTES-SPEC.md` |
| **intelligence** | *(undocumented in Constitution)* | `packages/cleo/src/dispatch/domains/intelligence.ts` | `packages/cleo/src/dispatch/domains/intelligence.ts` | *(none)* | *(none)* |
| **diagnostics** | *(shape types only)* | `packages/core/src/diagnostics/` | `packages/cleo/src/dispatch/domains/diagnostics.ts` | *(none)* | *(none)* |
| **docs** | *(shape types only)* | `packages/core/src/docs/` | `packages/cleo/src/dispatch/domains/docs.ts` | *(none)* | *(none — PROPOSED)* |
| **playbook** | `packages/contracts/src/playbook.ts` | `packages/playbooks/` | `packages/cleo/src/dispatch/domains/playbook.ts` | *(none)* | `docs/adr/ADR-053-playbook-runtime.md` |
| **conduit** | `packages/contracts/src/operations/conduit.ts` (5 ops) + `packages/contracts/src/conduit.ts` | `packages/core/src/conduit/` | `packages/cleo/src/dispatch/domains/conduit.ts` (promoted T964, commit `90534e50c`) | *(none)* | `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` |

### 2.2 Reserved / planned

| Domain | Contract file | Implementation | Dispatch status | HTTP route prefix |
|--------|---------------|----------------|-----------------|-------------------|
| **brain** (unified-graph super-domain) | `packages/contracts/src/operations/brain.ts` (8 ops, T968 at commit `62bcdc25e`) | `packages/brain/src/` (T969, extracted from `packages/studio/src/lib/server/living-brain/`) | PLANNED — no registry entries yet; the 8 ops today are served by the `/api/living-brain/*` SvelteKit routes as a separate HTTP surface | `/api/living-brain/*` today — PLANNED `/api/brain/*` per T971 |

The 8 BRAIN ops defined at `packages/contracts/src/operations/brain.ts`:

| Op | Params type | Location |
|----|-------------|----------|
| `brain.query` | `BrainQueryParams` | `brain.ts:211` |
| `brain.node` | `BrainNodeParams` | `brain.ts:253` |
| `brain.substrate` | `BrainSubstrateParams` | `brain.ts:293` |
| `brain.stream` | `BrainStreamParams` | `brain.ts:385` |
| `brain.bridges` | `BrainBridgesParams` | `brain.ts:429` |
| `brain.neighborhood` | `BrainNeighborhoodParams` | `brain.ts:472` |
| `brain.search` | `BrainSearchParams` | `brain.ts:532` |
| `brain.stats` | `BrainStatsParams` | `brain.ts:587` |

**Cross-references (sibling Node IDs are substrate-prefixed** —
`"task:T949"`, `"memory:O-abc"`, `"nexus:pkg/file.ts::Symbol"`; see
`packages/contracts/src/operations/brain.ts:62-79`).

---

## 3. BRAIN vs memory — Terminology

The distinction between BRAIN and memory MUST be preserved in all new
documentation; the two have been conflated historically and this is the
single-line disambiguation.

- **BRAIN** (super-domain) = unified cross-substrate graph. Wraps
  `memory + nexus + tasks + conduit + signaldock` into a single super-graph.
  Served at `/api/brain/*` (post-T971 rename; today at `/api/living-brain/*`).
  Implemented in `@cleocode/brain` (`packages/brain/src/`, T969). Wire-format
  contracts at `packages/contracts/src/operations/brain.ts:1-32` (8 ops).

- **memory** (subdomain of BRAIN) = cognitive memory store: observations,
  patterns, decisions, learnings, references + memory tiers
  (`short | medium | long`). Served at `/api/memory/*` (planned post-T970
  rename; today at `/api/brain/*` as the legacy name of the memory tables
  endpoint). Implemented in `packages/core/src/memory/` (lifecycle, retrieval,
  search, STDP, consolidator, plasticity) + `packages/core/src/store/memory-*.ts`
  (renamed from `store/brain-*.ts` per T966 at commit `d4ef8be47`).
  Wire-format contracts at `packages/contracts/src/operations/memory.ts` (31
  ops; renamed from `operations/brain.ts` per T965 at commit `7413b6562`).

- **"Deferred"** (Studio UI label) = `status='cancelled'` epics projected to
  the UI. It is NOT a DB field; the column remains `status` on the
  `tasks` table. Rename the label to "Cancelled epics" pending a UI polish
  task (out of scope for T984).

### Citations for the taxonomy

| Claim | Source |
|-------|--------|
| memory subdomain lives in `packages/core/src/memory/` | `.cleo/agent-outputs/T910-reconciliation/brain-memory-reconciliation.md` §7 |
| memory has 31 ops | `packages/contracts/src/operations/memory.ts:1-6` (header TSDoc) |
| BRAIN super-domain has 8 ops | `packages/contracts/src/operations/brain.ts:1-4` (header TSDoc) |
| BRAIN substrates are `memory | nexus | tasks | conduit | signaldock` | `packages/contracts/src/operations/brain.ts:50` |
| BRAIN today lives under `/api/living-brain/*` | `packages/studio/src/routes/api/living-brain/{+server.ts,node/[id],stream,substrate/[name]}` |
| memory today lives under `/api/brain/*` (legacy name) | `packages/studio/src/routes/api/brain/{observations,decisions,graph,quality,tier-stats}/+server.ts` |
| Node IDs are substrate-prefixed | `packages/contracts/src/operations/brain.ts:62-79` |
| `@cleocode/brain` is extracted from `packages/studio/src/lib/server/living-brain/` | Commit `725fc4231` (T969) |
| memory command file renamed to `memory.ts` | Commit `85c9be327` (T967) — `packages/cleo/src/cli/commands/memory.ts` |

---

## 4. `@cleocode/brain` Package

As of T969 (commit `725fc4231`), the BRAIN super-graph machinery has been
extracted into a standalone workspace package. Before T969, the substrate
adapters, the `LBNode`/`LBEdge`/`LBGraph` types, and the `getAllSubstrates()`
merger lived inside `packages/studio/src/lib/server/living-brain/`. They now
live in `packages/brain/src/` and `@cleocode/studio` consumes them via a
`workspace:*` dependency.

### 4.1 Package metadata

- **Name**: `@cleocode/brain` (`packages/brain/package.json:2`)
- **Version**: `2026.4.96` (`packages/brain/package.json:3`) — shipping as
  `2026.4.97` with T962 close.
- **Description**: "CLEO unified-graph Brain substrate — BRAIN + NEXUS +
  TASKS + CONDUIT + SIGNALDOCK projection" (`packages/brain/package.json:6`)
- **Exports**: root + `./adapters` (`packages/brain/package.json:9-18`)
- **Dependencies**: `@cleocode/contracts` only (`packages/brain/package.json:50-52`)
- **Studio wire**: `@cleocode/brain: "workspace:*"`
  (`packages/studio/package.json:18`)

### 4.2 Five substrates

Every request against the BRAIN super-domain runs five per-substrate adapters
in parallel and merges their outputs via substrate-prefixed IDs:

| Substrate | Adapter source | DB |
|-----------|----------------|-----|
| `memory` | `packages/brain/src/adapters/brain.ts` (projects `brain.db` typed memory tables) | `.cleo/brain.db` |
| `nexus` | `packages/brain/src/adapters/nexus.ts` | `~/.local/share/cleo/nexus.db` (global) |
| `tasks` | `packages/brain/src/adapters/tasks.ts` | `.cleo/tasks.db` |
| `conduit` | `packages/brain/src/adapters/conduit.ts` | `.cleo/conduit.db` |
| `signaldock` | `packages/brain/src/adapters/signaldock.ts` | `~/.local/share/cleo/signaldock.db` (global) |

> **Note on the substrate-name collision.** The `memory` substrate name in
> `BrainSubstrateName` (`packages/contracts/src/operations/brain.ts:50`)
> refers to the **brain.db-backed memory store**, distinct from the `memory`
> dispatch domain (§2). This matches the T965 rename and is documented in
> `packages/contracts/src/operations/brain.ts:41-48`.

Full architecture audit: `.cleo/agent-outputs/T910-reconciliation/living-brain-architecture.md`
(including the 27-test bridge synthesis coverage, SSE stream events, and the
5 cross-substrate edge mechanisms).

---

## 5. Dispatch Adapter Layer — `TypedDomainHandler<O>`

The legacy `DomainHandler` interface accepts `Record<string, unknown>` params
on every operation. The T910 audit
(`.cleo/agent-outputs/T910-reconciliation/dispatch-cast-audit.md`) enumerated
**579** `params?.foo as string` casts across 14 domain handlers — latent
schema drift with zero compile-time enforcement against the typed `*Params`
contracts that already live in `packages/contracts/src/operations/`.

### 5.1 The adapter (T974)

Commit `16f29c3a8` introduced `packages/cleo/src/dispatch/adapters/typed.ts`,
a single-point cast boundary that bridges typed per-op contracts and the
untyped registry surface.

The module exports four primitives:

| Export | Purpose | Source |
|--------|---------|--------|
| `TypedOpRecord` | `Record<string, readonly [Params, Result]>` — op-map generic | `adapters/typed.ts:66` |
| `TypedDomainHandler<O>` | Typed handler interface (domain + per-op fn map) | `adapters/typed.ts:88-98` |
| `typedDispatch<O, K>` | Single-cast bridge from `unknown` → `O[K][0]` | `adapters/typed.ts:135-164` |
| `defineTypedHandler<O>` | Convenience builder | `adapters/typed.ts:190-195` |
| `lafsSuccess` / `lafsError` | LAFS envelope constructors for typed handlers | `adapters/typed.ts:231-272` |

The cast on `adapters/typed.ts:163` is the **documented trust boundary**: the
registry upstream guarantees `op` exists on the handler; the contracts package
defines the typed Params shape. Every downstream call site sees the narrowed
`O[K][0]` type.

### 5.2 Scope — this module MUST NOT

- Replace `DomainHandler` (handler migrations are Wave D, T975-T983, and are a
  separate epic).
- Perform runtime validation. Runtime zod schemas layered on top of this
  module are a follow-up (see `adapters/typed.ts:150-162` for the documented
  placeholder).

### 5.3 Migration status

| Wave | Scope | Status |
|------|-------|--------|
| Wave A (T963) | Resync contract↔impl drift (5 sampled ops fixed) | SHIPPED — commit `0119a6518` |
| Wave B (T965-T969) | File renames, new contracts, `@cleocode/brain` extraction | SHIPPED — see §3-4 |
| Wave D0 (T974) | `TypedDomainHandler` + `typedDispatch` foundation | SHIPPED — commit `16f29c3a8` |
| Wave D1-D3 (T975-T983) | Per-domain handler migrations + zod runtime guard | PLANNED — follow-up epic |
| T970 | `/api/brain/*` → `/api/memory/*` HTTP rename | PLANNED |
| T971 | `/api/living-brain/*` → `/api/brain/*` HTTP rename | PLANNED |

---

## 6. How to Add a New Operation

This is the authority walk-through. Every contributor MUST follow it in this
order.

### Step 1 — Author the contract

Edit the domain's contract file under `packages/contracts/src/operations/`.
Add a `{OpName}Params` and `{OpName}Result` type pair. Reuse existing shared
types from `packages/contracts/src/status-registry.ts`, `task.ts`, `session.ts`,
`brain.ts`, etc. — never redeclare.

```ts
// packages/contracts/src/operations/tasks.ts
export interface TasksFooBarParams {
  taskId: string;
  flavor?: 'plain' | 'spicy';
}
export interface TasksFooBarResult {
  task: TaskOp;
  sideEffects: string[];
}
```

Re-export from `packages/contracts/src/operations/index.ts` if that domain is
already barrel-exported. Do NOT introduce a new operation type without tests.

### Step 2 — Implement the core logic

Write the pure business function in `packages/core/src/<domain>/<op>.ts`. Core
MUST be transport-agnostic: no envelopes, no HTTP, no argv. It accepts the
`*Params` shape and returns the `*Result` shape (or throws a domain error).

### Step 3 — Register in the dispatch domain

Add the handler in `packages/cleo/src/dispatch/domains/<domain>.ts`. Wire it
into `packages/cleo/src/dispatch/registry.ts` under the correct
`CANONICAL_DOMAINS` entry with `{ name, tag: 'query' | 'mutate', gateway,
tier, requiredParams }`. Registry is the binding SSoT for op existence.

New handlers SHOULD use the `TypedDomainHandler<O>` pattern (§5.1) for
compile-time enforcement against the typed `*Params` contracts; legacy
handlers MAY continue to implement the untyped `DomainHandler` interface
during the Wave D migration window.

### Step 4 — (Optional) Expose via HTTP

If the operation should be reachable over the wire, add a handler in
`packages/studio/src/routes/api/<domain>/<op>/+server.ts`. Per
`docs/specs/CLEO-STUDIO-HTTP-SPEC.md` §4, handlers MUST be thin adapters that
call the same Dispatcher used by the CLI. This guarantees the HTTP response
envelope is identical to the CLI response envelope (LAFS).

**Route prefix discipline** (post T962):

| Domain | Canonical HTTP prefix | Notes |
|--------|----------------------|-------|
| `memory` | `/api/memory/*` (planned T970) | Legacy `/api/brain/*` routes remain until the rename ships |
| `brain` (super-graph) | `/api/brain/*` (planned T971) | Today at `/api/living-brain/*` |
| `tasks` | `/api/tasks/*` | read-only today |
| `nexus` | `/api/nexus/*` + `/api/search` + `/api/project/*` | |
| `conduit` | *(none)* — CLI only | |

### Step 5 — Document in the narrative spec

Add one row to the relevant per-domain table in
`docs/specs/CLEO-<DOMAIN>-API-SPEC.md`:

- CLI verb
- HTTP verb + path (or `(CLI only)`)
- Request type (`{OpName}Params`)
- Response type (`{OpName}Result`)
- Error codes (from `packages/contracts/src/exit-codes.ts`)
- Idempotent? (Y/N + reason)
- One-line description

If the operation crosses an ADR gate (e.g. ADR-051 evidence),
cite the ADR file:line on the same row.

Update `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.x op table. Constitution
entries MUST match the registry. See §8 for the drift gate.

---

## 7. Envelopes and Errors

All CLEO operations MUST return LAFS envelopes
(`packages/contracts/src/lafs.ts:52-299`). The shape is:

```ts
// Success
{ success: true, data: T, _meta?: { gateway, domain, durationMs, ... } }
// Error
{ success: false, error: { code, category, message, fix?, details? }, _meta? }
```

HTTP callers derive status code from `error.code` via the mapping in
`packages/contracts/src/exit-codes.ts` + `docs/specs/CLEO-STUDIO-HTTP-SPEC.md`
§3. Canonical pairs:

| CLI ExitCode | HTTP status | Meaning |
|--------------|-------------|---------|
| `SUCCESS` (0) | 200 / 201 | OK |
| `NO_DATA` (100), `NO_CHANGE` (102) | 200 | idempotent no-op |
| `NOT_FOUND` (4) | 404 | |
| `PARENT_NOT_FOUND` (10), `SESSION_NOT_FOUND` (31) | 404 | |
| `INVALID_INPUT` (2), `VALIDATION_ERROR` (6), `INVALID_GATE` (42) | 400 | |
| `LIFECYCLE_GATE_FAILED` (80), `AUDIT_MISSING` (81) | 422 | |
| `HAS_CHILDREN` (16), `HAS_DEPENDENTS` (19), `TASK_CLAIMED` (35) | 409 | |
| `LOCK_TIMEOUT` (7) | 423 (Locked) | |
| `NEXUS_PERMISSION_DENIED` (72) | 403 | |
| other | 500 | |

ExitCode name MUST always be echoed into `error.code` so REST callers map
identically to CLI callers.

Evidence atoms (`commit:`, `files:`, `tool:`, `test-run:`, `note:`,
`url:`) for gate verification are specified in
`docs/specs/T832-gate-integrity-spec.md` (ADR-051 normative).

---

## 8. SSoT Drift Detection

The Constitution (`docs/specs/CLEO-OPERATION-CONSTITUTION.md`) is human-
maintained but derived from `packages/cleo/src/dispatch/registry.ts`. Drift is
inevitable unless enforced.

**Existing controls:**

- `packages/cleo/src/__tests__/` — runtime registry tests verify every registry
  entry has a contract counterpart.
- Constitution file itself states "When conflicts exist between this document
  and the registry, the registry wins." (`CLEO-OPERATION-CONSTITUTION.md:14`).
- T963 (commit `0119a6518`) resynced 5 sampled ops where contract drifted
  from implementation (`tasks.create`, `tasks.update`, `orchestrate.spawn`,
  `brain.observe` → `memory.observe`, `nexus.context`).

**Proposed drift gate (not yet shipped — @HITL):**

- CI check that walks `CANONICAL_DOMAINS` in
  `packages/cleo/src/dispatch/types.ts:54-70`, extracts op names per domain,
  and compares against:
  - Constitution §6.x op tables (warn on mismatch, fail on missing)
  - Narrative per-domain specs (warn on mismatch)
  - `docs/specs/CLEO-API-AUTHORITY.md` §2 (warn on new domain not listed)

Ticket: `@HITL` Q1 — owner confirmation on severity (warn vs fail) and
tolerance window ("re-sync within 7 days of registry change").

---

## 9. Generated Artifacts — Naming and Rename Notice

### Rename: `api-reference.md` → `typescript-api.md`

The file at `/mnt/projects/cleocode/docs/generated/api-reference.md` (3.1 MB,
128,485 lines, last regenerated 2026-04-06) is **not** a dispatch API
reference. It is a forge-ts dump of TypeScript exports across all 15 packages.
None of the canonical Tasks ops, memory ops, BRAIN ops, or NEXUS ops appear in
it by their dispatch name.

Keeping the file under the name `api-reference.md` is misleading. Action per
T910:

1. Rename `docs/generated/api-reference.md` → `docs/generated/typescript-api.md`.
2. Rename sibling `api-reference.mdx` → `typescript-api.mdx`.
3. Update `docs/generated/llms.txt` to point at the new paths.
4. Regenerate on the next forge-ts run (currently stale as of 2026-04-17).

The Constitution remains the human-readable op catalogue. The new
`typescript-api.md` name correctly advertises its content.

### Generated files inventory (for auditability)

Per `docs/guide/cleo-documentation-sop.md`, generated content lives under
`docs/generated/`:

| File | Kind | Generator | Update cadence |
|------|------|-----------|----------------|
| `docs/generated/typescript-api.md` | TS export dump | forge-ts | CI on merge to main |
| `docs/generated/typescript-api.mdx` | MDX variant | forge-ts | same |
| `docs/generated/llms-full.txt` | LLM context | forge-ts | same |
| `docs/generated/llms.txt` | index pointer | forge-ts | same |
| `docs/generated/packages/*/api/{functions,types,examples,index}.mdx` | per-package TS API | forge-ts | same |
| `docs/generated/SKILL-monorepo/{SKILL.md,references/*.md}` | skill surface | forge-ts | same |

**None of these are Layer-1 SSoT.** They are downstream of the code layer and
never authoritative on op contracts.

---

## 10. ADR Cross-References

### Superseded

- `docs/adr/adr-042-cli-system-integrity-conduit-alignment.md` — **SUPERSEDED-BY
  T962 / T964** (v2026.4.97). Decision 1 (fold `conduit` under `orchestrate` to
  preserve a 10-domain invariant) was a rule-enforcement patch, not a
  semantic decision. The invariant had already lapsed (count reached 14 with
  `intelligence`, `diagnostics`, `docs`, `playbook`); CONDUIT is now
  domain #15 at `packages/cleo/src/dispatch/types.ts:69`. Full rationale:
  `.cleo/agent-outputs/T910-reconciliation/conduit-collision-research.md`.

### Binding

- `docs/adr/ADR-051-programmatic-gate-integrity.md` (T832) — evidence atoms
  for gate verification; `cleo verify --all` without `--evidence` is REJECTED
  with `E_EVIDENCE_MISSING`.
- `docs/adr/ADR-052-sdk-consolidation.md` — SDK-backed spawn providers
  (Claude Agent SDK, OpenAI Agents SDK, LangGraph).
- `docs/adr/ADR-053-playbook-runtime.md` — playbook DSL runtime and
  `playbook` domain.

### Pending (authored after T962 Wave A+B+D0 ships)

- **ADR-054 — CONDUIT as canonical domain #15**. Formalizes the T964
  supersession of ADR-042 Decision 1. Draft rationale lives in
  `.cleo/agent-outputs/T910-reconciliation/conduit-collision-research.md` §4.
- **ADR-055 — `@cleocode/brain` package + BRAIN vs memory taxonomy**.
  Formalizes T965/T968/T969 together: the `operations/brain.ts` →
  `operations/memory.ts` rename, the new `operations/brain.ts` super-domain
  contracts, and the `@cleocode/brain` extraction. Draft rationale lives in
  `.cleo/agent-outputs/T910-reconciliation/brain-memory-reconciliation.md` and
  `.cleo/agent-outputs/T910-reconciliation/living-brain-architecture.md`.

---

## 11. Relationship to Other Authorities

- `docs/specs/SCHEMA-AUTHORITY.md` owns storage-layer SSoT (DB schemas,
  migrations, status enums).
- `docs/specs/VERB-STANDARDS.md` owns verb canonicalisation.
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` owns the per-op summary tables
  for every canonical domain.
- `docs/specs/CLEO-API-AUTHORITY.md` (this file) owns the **authority chain**
  and **domain directory** — who is SSoT for what.

When editing any of these, the others MUST be re-read for consistency.

---

## 12. Contributor Checklist

Before marking API work complete:

- [ ] Contract types in `packages/contracts/src/operations/<domain>.ts` exist
  and are re-exported from `index.ts`.
- [ ] Dispatch registration in `packages/cleo/src/dispatch/registry.ts` lists
  the op with correct tag / gateway / tier / requiredParams.
- [ ] Dispatch handler in `packages/cleo/src/dispatch/domains/<domain>.ts`
  returns a LAFS envelope via `packages/lafs/`. New handlers SHOULD use
  `TypedDomainHandler<O>` (§5.1).
- [ ] `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.x table updated.
- [ ] Per-domain narrative spec (if it exists) updated with a new row.
- [ ] `docs/specs/CLEO-API-AUTHORITY.md` domain directory entry updated if a
  new row is needed.
- [ ] Tests added: unit + dispatch registration assertions.
- [ ] HTTP handler (if exposed) added to `docs/specs/CLEO-STUDIO-HTTP-SPEC.md`
  §2 endpoint table.
- [ ] `pnpm run build && pnpm run test && pnpm biome check --write .` green.

---

## References (from `cleo-api-authority-superseded`)

- `packages/cleo/src/dispatch/registry.ts` — executable dispatch SSoT
- `packages/cleo/src/dispatch/types.ts:54-70` — CANONICAL_DOMAINS (15 entries)
- `packages/cleo/src/dispatch/adapters/typed.ts` — TypedDomainHandler + typedDispatch (T974)
- `packages/contracts/src/operations/` — per-domain wire types
  (`brain.ts`, `conduit.ts`, `index.ts`, `issues.ts`, `lifecycle.ts`,
  `memory.ts`, `nexus.ts`, `orchestrate.ts`, `params.ts`, `release.ts`,
  `research.ts`, `session.ts`, `skills.ts`, `system.ts`, `tasks.ts`,
  `validate.ts`)
- `packages/contracts/src/lafs.ts` — envelope contract
- `packages/contracts/src/exit-codes.ts` — error → status mapping source
- `packages/brain/` — `@cleocode/brain` unified-graph package (T969)
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — derived per-op tables
- `docs/specs/SCHEMA-AUTHORITY.md` — companion, storage-layer authority
- `docs/specs/VERB-STANDARDS.md` — verb canonicalisation (ADR-017)
- `docs/guide/cleo-documentation-sop.md` — docs organisation and naming rule
- `docs/adr/adr-042-cli-system-integrity-conduit-alignment.md` (SUPERSEDED)
- `docs/adr/adr-051-programmatic-gate-integrity.md`
- `docs/adr/ADR-052-sdk-consolidation.md`
- `docs/adr/ADR-053-playbook-runtime.md`
- T910 evidence base: `.cleo/agent-outputs/T910-reconciliation/`
  - `brain-memory-reconciliation.md`
  - `conduit-collision-research.md`
  - `dispatch-cast-audit.md`
  - `living-brain-architecture.md`
  - `type-safety-audit.md`
- T910 docs-audit base: `.cleo/agent-outputs/T910-docs-audit/`
  - `api-docs-inventory.md`
  - `http-endpoint-inventory.md`
  - `task-schema-audit.md`
  - `studio-tasks-ui-audit.md`
  - `studio-tasks-architecture.md`

### T962 shipped commits (feat/t942-sentient-foundations → v2026.4.97)

| Commit | Task | Title |
|--------|------|-------|
| `0119a6518` | T963 | Resync contract↔impl drift (5 ops fixed) |
| `7413b6562` | T965 | `operations/brain.ts` → `operations/memory.ts` |
| `85c9be327` | T967 | `memory-brain.ts` CLI command → `memory.ts` |
| `d4ef8be47` | T966 | `store/brain-*.ts` → `store/memory-*.ts` importers |
| `90534e50c` | T964 | Promote CONDUIT to domain #15 (supersedes ADR-042) |
| `62bcdc25e` | T968 | `operations/brain.ts` — 8 unified-graph BRAIN ops |
| `725fc4231` | T969 | Extract `@cleocode/brain` from studio/living-brain |
| `16f29c3a8` | T974 | `TypedDomainHandler` + `typedDispatch` adapter |
| `0cb9f1100` | T962 | Straggler cleanup — blank-line + test docstring + lockfile sync |

---

## Open Questions (HITL)

- **Q1**: Drift-gate severity and window — should the CI check be warn-only,
  warn-with-7-day-window, or fail-closed?
- **Q2**: `/api/brain/*` → `/api/memory/*` and `/api/living-brain/*` →
  `/api/brain/*` route renames (T970/T971): ship atomically with a deprecation
  window, or flip in one release? External Studio consumers would see breakage.
- **Q3**: Wave D1-D3 ordering for `TypedDomainHandler` migration — session +
  nexus + tasks first (typed contracts already published), then memory,
  then admin (the 107-cast flagship)?
- **Q4**: ADR-054 / ADR-055 authorship — gate them on T984 close, or fold
  rationale into a single combined ADR?

---

**End.** Report new issues via `cleo issues create bug --title "..."` and
link to this file.
