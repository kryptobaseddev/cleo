# CLEO Operation Constitution

**Version**: 2026.3.8
**Status**: APPROVED
**Date**: 2026-03-08
**Task**: T5612
**Supersedes**: CLEO-OPERATIONS-REFERENCE.md

---

## 1. Authority

`src/dispatch/registry.ts` is the executable single source of truth (SSoT) for all CLEO operations. This document is derived from the registry and MUST stay synchronized with it. When conflicts exist between this document and the registry, the registry wins.

All operations are defined as `OperationDef` entries in the `OPERATIONS` array. No operation exists unless it appears in that array. No legacy alias is honored unless it appears there.

---

## 2. Runtime Scope

CLEO exposes exactly **2 MCP tools** following the CQRS (Command Query Responsibility Segregation) pattern:

| Tool | Gateway | Purpose |
|------|---------|---------|
| `query` | `query` | Read-only operations. MUST NOT modify state. Safe to retry. |
| `mutate` | `mutate` | State-changing operations. MAY modify data stores, sessions, or configuration. |

All operations are addressed as `{domain}.{operation}` within their gateway:

```
query  { domain: "tasks", operation: "show", params: { id: "T123" } }
mutate { domain: "memory", operation: "observe", params: { text: "..." } }
```

---

## 3. Canonical Domains

CLEO defines exactly **10 canonical domains**. These are the runtime contract. Conceptual systems (BRAIN, LOOM, NEXUS, LAFS) are overlays, not domains.

| Domain | Purpose | Primary Store |
|--------|---------|---------------|
| `tasks` | Task hierarchy, CRUD, dependencies, work tracking | tasks.db |
| `session` | Session lifecycle, decisions, assumptions, context | sessions/ JSON |
| `memory` | Cognitive memory: observations, decisions, patterns, learnings | brain.db |
| `check` | Schema validation, protocol compliance, test execution, grading | tasks.db (audit) |
| `pipeline` | RCSD lifecycle stages, manifest ledger, release management | MANIFEST.jsonl, tasks.db |
| `orchestrate` | Multi-agent coordination, wave planning, parallel execution | tasks.db |
| `tools` | Skills, providers, TodoWrite integration, CAAMP catalog | .cleo/skills/ |
| `admin` | Configuration, backup, migration, diagnostics, ADRs, protocol injection | config.json, tasks.db |
| `nexus` | Cross-project coordination, registry, dependency graph | nexus.db |
| `sticky` | Ephemeral project-wide capture, quick notes before formal task creation | brain.db |

The canonical domain list is defined in `src/dispatch/types.ts` as:

```typescript
export const CANONICAL_DOMAINS = [
  'tasks', 'session', 'memory', 'check', 'pipeline',
  'orchestrate', 'tools', 'admin', 'nexus', 'sticky',
] as const;
```

---

## 4. Canonical Verbs

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

## 5. Operation Model

Every operation is defined by the `OperationDef` interface:

```typescript
interface OperationDef {
  gateway: 'query' | 'mutate';     // CQRS gateway
  domain: CanonicalDomain;          // One of 10 canonical domains
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

- **gateway**: Determines which MCP tool handles the operation. Query operations MUST NOT modify state.
- **tier**: Controls progressive disclosure. Agents start at tier 0 and escalate. See Section 7.
- **idempotent**: When `true`, the operation is safe to retry on failure without side effects.
- **requiredParams**: The dispatcher validates these are present before routing to the domain handler. Missing params return `E_INVALID_INPUT`.
- **aliases**: Old operation names that still resolve to this definition. Aliases appear in gateway matrices for validation but route to the canonical handler.
- **escalationHint**: Optional. For tier-2 operations with no lower-tier entry point, this string is emitted by `admin.help` in its tier-0/1 response as a "more available" summary.

---

## 6. Domain Operation Tables

### 6.1 tasks (21 operations)

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `show` | Show task details by ID | 0 | -- | Yes |
| query | `list` | List tasks with filters | 1 | -- | Yes |
| query | `find` | Search tasks by keyword | 0 | -- | Yes |
| query | `tree` | Display task hierarchy tree | 1 | -- | Yes |
| query | `blockers` | Show blocking dependencies | 1 | -- | Yes |
| query | `depends` | Show dependency graph | 1 | -- | Yes |
| query | `analyze` | Analyze task metrics | 1 | -- | Yes |
| query | `next` | Suggest next task to work on | 0 | -- | Yes |
| query | `plan` | Composite planning view (epics, ready, blocked, bugs) | 0 | -- | Yes |
| query | `relates` | Show related tasks; accepts `mode:"suggest"\|"discover"` | 1 | -- | Yes |
| query | `complexity.estimate` | Estimate task complexity | 1 | -- | Yes |
| query | `current` | Show currently active task | 0 | -- | Yes |
| query | `label.list` | List all labels; accepts optional `label` filter | 1 | -- | Yes |
| query | `history` | Show task work history (time tracked per task) | 1 | -- | Yes |
| mutate | `add` | Create new task | 0 | -- | No |
| mutate | `update` | Modify task properties (`status=done` MUST route to completion semantics) | 0 | -- | No |
| mutate | `complete` | Canonical completion path (deps, acceptance policy, verification gates) | 0 | -- | No |
| mutate | `cancel` | Cancel task (soft terminal state — reversible via `restore`) | 1 | `taskId` | No |
| mutate | `delete` | Permanently remove task | 1 | -- | No |
| mutate | `archive` | Soft-delete task to archive | 1 | -- | No |
| mutate | `restore` | Restore task from terminal state; accepts `from:"done"\|"archive"` | 1 | -- | No |
| mutate | `reparent` | Move task to new parent; `newParentId: null` promotes to top-level | 1 | -- | No |
| mutate | `reorder` | Reorder tasks within parent | 1 | -- | No |
| mutate | `relates.add` | Add task relationship | 1 | -- | No |
| mutate | `start` | Begin working on task | 0 | -- | No |
| mutate | `stop` | Stop working on task | 0 | -- | No |

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

### 6.3 memory (11 operations)

All memory operations target **brain.db** (SQLite with FTS5). The memory domain is the runtime interface to the BRAIN cognitive system.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `find` | Cross-table brain.db FTS5 search | 0 | `query` | Yes |
| query | `timeline` | Chronological context around anchor entry | 1 | `anchor` | Yes |
| query | `fetch` | Batch fetch brain entries by IDs | 1 | `ids` | Yes |
| query | `decision.find` | Search decisions in brain.db | 1 | -- | Yes |
| query | `pattern.find` | Search patterns by type, impact, or keyword | 1 | -- | Yes |
| query | `learning.find` | Search learnings by confidence, actionability, or keyword | 1 | -- | Yes |
| mutate | `observe` | Save observation to brain.db | 0 | `text` | No |
| mutate | `decision.store` | Store decision to brain.db | 1 | `decision`, `rationale` | No |
| mutate | `pattern.store` | Store reusable workflow or anti-pattern | 1 | `pattern`, `context` | No |
| mutate | `learning.store` | Store insight or lesson learned | 1 | `insight`, `source` | No |
| mutate | `link` | Link brain entry to task | 1 | `taskId`, `entryId` | No |

**Removed operations:**
- `memory.show` → use `memory.fetch {ids: [id]}` (single-element array)
- `memory.stats` → not replaced (dashboard metric, not agent workflow)
- `memory.contradictions` → not replaced
- `memory.superseded` → not replaced
- `memory.pattern.stats` → not replaced
- `memory.learning.stats` → not replaced
- `memory.unlink` → not replaced (direct repair via `memory.link` if needed)

**Promoted to tier 0:** `memory.find` and `memory.observe` (both appear in the mandatory efficiency sequence)

### 6.4 check (16 operations)

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
| query | `chain.gate` | Read gate evaluation history for a WarpChain instance | 2 | -- | Yes |
| query | `grade` | Grade agent behavioral session (5-dimension rubric) | 2 | `sessionId` | Yes |
| query | `archive.stats` | Archive statistics and analytics | 1 | -- | Yes |
| mutate | `compliance.record` | Record compliance check result | 1 | -- | No |
| mutate | `test.run` | Execute test suite | 1 | -- | No |
| mutate | `gate.set` | Set or reset verification gate state | 1 | `taskId` | No |

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
- `admin.grade.list` → absorbed into `check.grade {action:"list"}`
- `admin.archive.stats` → `check.archive.stats`

### 6.5 pipeline (26 operations)

The pipeline domain manages RCSD lifecycle stages, the MANIFEST.jsonl artifact ledger, and release orchestration. The entire domain is tier 1 except WarpChain (`chain.*`) which is tier 2.

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
| query | `chain.find` | Search chain definitions | 2 | -- | Yes |
| mutate | `stage.record` | Record lifecycle stage completion | 1 | -- | No |
| mutate | `stage.skip` | Skip a lifecycle stage | 1 | -- | No |
| mutate | `stage.reset` | Reset lifecycle stage (emergency) | 1 | -- | No |
| mutate | `stage.gate.pass` | Mark lifecycle gate as passed | 1 | -- | No |
| mutate | `stage.gate.fail` | Mark lifecycle gate as failed | 1 | -- | No |
| mutate | `manifest.append` | Append entry to MANIFEST.jsonl | 1 | `entry` | No |
| mutate | `manifest.archive` | Archive old manifest entries | 1 | `beforeDate` | No |
| mutate | `release.ship` | Execute release step; accepts `step:"prepare"\|"changelog"\|"commit"\|"tag"\|"push"\|"gates"` | 1 | -- | No |
| mutate | `release.rollback` | Rollback failed release | 1 | -- | No |
| mutate | `release.cancel` | Cancel in-progress release | 1 | -- | No |
| mutate | `phase.set` | Set active phase or advance phase state; `action:"start"\|"complete"` | 1 | `phaseId` | No |
| mutate | `phase.advance` | Complete current phase and start next | 1 | -- | No |
| mutate | `phase.rename` | Rename a phase and update all task references | 1 | `oldName`, `newName` | No |
| mutate | `phase.delete` | Delete a phase with task reassignment protection | 1 | `phaseId` | No |
| mutate | `chain.add` | Store a validated chain definition | 2 | `chain` | No |
| mutate | `chain.instantiate` | Create chain instance for epic | 2 | `chainId`, `epicId` | No |
| mutate | `chain.advance` | Advance instance to next stage | 2 | `instanceId`, `nextStage` | No |
| mutate | `chain.gate.pass` | Mark chain gate as passed | 2 | -- | No |
| mutate | `chain.gate.fail` | Mark chain gate as failed | 2 | -- | No |

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

### 6.6 orchestrate (15 operations)

The entire orchestrate domain is tier 1. All operations are orchestrator-specific and not needed at cold-start.

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

**Merged operations (removed from registry):**
- `orchestrate.critical.path` → use `orchestrate.analyze {mode:"critical-path"}`
- `orchestrate.tessera.show` → use `orchestrate.tessera.list {id}`
- `orchestrate.parallel.start` → use `orchestrate.parallel {action:"start"}`
- `orchestrate.parallel.end` → use `orchestrate.parallel {action:"end"}`

**Removed phantom operations (were never registered):**
- `orchestrate.chain.plan` — dead handler code, not in registry
- `orchestrate.verify` — dead handler code, not in registry

### 6.7 tools (19 operations in registry, 13 after plugin extraction)

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
| mutate | `todowrite.sync` | Synchronize TodoWrite integration (moved from admin) | 1 | -- | No |
| mutate | `todowrite.status` | TodoWrite sync status (moved from admin) | 1 | -- | Yes |
| mutate | `todowrite.clear` | Clear TodoWrite sync state (moved from admin) | 1 | -- | No |

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
- `admin.sync` → `tools.todowrite.sync`
- `admin.sync.status` → `tools.todowrite.status`
- `admin.sync.clear` → `tools.todowrite.clear`

### 6.8 admin (28 operations)

Includes 1 operation moved in from session. Note: actual before-count was 50 ops (not 44).

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
| mutate | `install.global` | Refresh global CLEO setup (providers, MCP configs) | 2 | -- | Yes |
| mutate | `adr.sync` | Sync ADR markdown files; `validate:true` also validates frontmatter | 2 | -- | Yes |
| mutate | `import` | Import tasks; `scope:"snapshot"\|"package"` | 2 | `file` | No |
| mutate | `token` | Token telemetry write; `action:"record"\|"delete"\|"clear"` | 2 | -- | No |
| mutate | `detect` | Refresh project-context.json — re-detect project type and LLM hints | 1 | -- | Yes |
| mutate | `context.inject` | Inject protocol content into context (moved from session) | 1 | `protocolType` | Yes |
| mutate | `health` | Auto-repair failed health checks; `mode:"repair"` | 1 | -- | No |

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
- `admin.sync` → `tools.todowrite.sync`
- `admin.sync.status` → `tools.todowrite.status`
- `admin.sync.clear` → `tools.todowrite.clear`
- `admin.grade` → `check.grade`
- `admin.grade.list` → absorbed into `check.grade {action:"list"}`
- `admin.archive.stats` → `check.archive.stats`

**Moved in from session:**
- `session.context.inject` → `admin.context.inject`

### 6.9 nexus (17 operations)

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

### Summary Counts

| Domain | Query | Mutate | Total |
|--------|-------|--------|-------|
| tasks | 15 | 11 | 26 |
| session | 9 | 6 | 15 |
| memory | 6 | 5 | 11 |
| check | 13 | 3 | 16 |
| pipeline | 15 | 19 | 34 |
| orchestrate | 9 | 6 | 15 |
| tools | 15 | 7 | 22 |
| admin | 15 | 13 | 28 |
| nexus | 12 | 8 | 20 |
| sticky | 2 | 4 | 6 |
| **Total** | **111** | **82** | **193** |

> Note: The table above counts all operations in each domain's section, including tier-2 ops and cross-domain moves. The consolidated rationalized core total (excluding 6 plugin-extracted ops from tools) is **164 operations** (97 query + 67 mutate) per the T5609 decision matrix. Discrepancy from table vs T5609 count reflects that some merged entries are listed as unified ops with multiple param forms counted once in T5609 but appear as rows above. The registry (`src/dispatch/registry.ts`) is the authoritative count.

---

## 7. Progressive Disclosure Contract

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

| Operation | Why mandatory |
|-----------|---------------|
| `query session status` | Step 1 of mandatory efficiency sequence |
| `query admin dash` | Step 2 of mandatory efficiency sequence |
| `query tasks current` | Step 3 of mandatory efficiency sequence |
| `query tasks next` | Step 4 of mandatory efficiency sequence |
| `query tasks show` | Step 5 of mandatory efficiency sequence |
| `mutate session start` | Agent work loop begin |
| `mutate tasks complete` | Agent work loop end |
| `query memory find` | Memory protocol read (3-layer step 1) |
| `mutate memory observe` | Memory protocol write |
| `query admin help` | Escalation path entry point |

### Tier 1 -- Extended

Memory, manifest, and advanced query operations. Agents escalate here when they need cognitive memory, lifecycle operations, or research artifact access.

**Domains**: memory, session (extended), tasks (extended), session, check, pipeline, orchestrate, tools, admin (extended), sticky, nexus (entry points: status, list)

### Tier 2 -- Full System

Cross-project coordination, WarpChain operations, advanced tooling, and administrative functions. Used by orchestrator agents and system administrators.

**Domains**: nexus (core operations) plus advanced operations across admin, tools, pipeline (chain), and check (chain)

### Tier Escalation

An agent discovers tier 1+ operations via `admin.help`:

```
query { domain: "admin", operation: "help" }                  -- tier 0 ops
query { domain: "admin", operation: "help", params: { tier: 1 } }  -- + tier 1
query { domain: "admin", operation: "help", params: { tier: 2 } }  -- all ops
```

---

## 8. Injection Contract

Protocol injection is performed via `admin.context.inject` (mutate gateway):

```
mutate {
  domain: "admin",
  operation: "context.inject",
  params: {
    protocolType: "research",    // required
    taskId: "T123",              // optional
    variant: "default"           // optional
  }
}
```

Valid `protocolType` values are defined by the CAAMP catalog and skill registry. Common types include `research`, `orchestrator`, `lifecycle`, and `validator`.

> **Note**: `admin.context.inject` was previously `session.context.inject`. The operation reads protocol files from the filesystem — it is a bootstrap/admin utility, not a session state operation.

---

## 9. CLI/MCP Parity Rules

1. The same `{domain}.{operation}` semantics apply to both CLI and MCP.
2. CLI commands map 1:1 to MCP operations where possible: `cleo show T123` = `query tasks.show { id: "T123" }`.
3. CLI MAY provide aliases for convenience (e.g., `cleo done` for `tasks.complete`).
4. MCP operations are the canonical names; CLI aliases are cosmetic.
5. Both interfaces route through the shared dispatch layer (`src/dispatch/`) to `src/core/`.

---

## 10. Cross-Domain Moves and Plugin Boundaries

### Cross-Domain Moves (T5517 rationalization)

Operations moved between domains as part of the 268→164 rationalization. These are semantically correct relocations, not removals.

| Old operation | New operation | Direction | Rationale |
|---------------|---------------|-----------|-----------|
| `session.context.inject` | `admin.context.inject` | session → admin | Reads filesystem protocol files; bootstrap utility, not session state |
| `admin.sync` | `tools.todowrite.sync` | admin → tools | TodoWrite is an external integration; belongs with tools |
| `admin.sync.status` | `tools.todowrite.status` | admin → tools | Same rationale |
| `admin.sync.clear` | `tools.todowrite.clear` | admin → tools | Same rationale |
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

## 11. Tier Gate Invariant

No tier-2 gate may exist without an explicit escalation path surfaced at tier 0.

### Rationale

When operations are hidden at tier 2 without visible escalation paths, agents silently fall back to direct filesystem reads (e.g., reading `~/.cleo/projects-registry.json` instead of using nexus MCP operations). This defeats the purpose of progressive disclosure and bypasses all validation and atomic operation guarantees that CLEO provides.

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
| check (chain) | `chain.validate`, `chain.gate` | `admin.help --tier 2` via `escalationHint` |
| admin (token) | `admin.token` query + mutate | `admin.stats` at tier 1 hints at token tracking |
| admin (export) | `admin.export`, `admin.import` | `admin.backup` at tier 1 hints at data portability |
| admin (ADR) | `admin.adr.show` | `admin.adr.find` at tier 1 |
| check (grade) | `check.grade` | `admin.help --tier 2` via `escalationHint` |

---

## 12. Validation and CI Enforcement

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

## 13. Change Control

### Adding Operations

1. Add `OperationDef` entry to `OPERATIONS` array in `src/dispatch/registry.ts`.
2. Implement handler in the appropriate domain handler (`src/dispatch/domains/`).
3. Wire core logic in `src/core/`.
4. Update this document (Section 6 tables).
5. Add tests for the new operation.
6. Verify the operation satisfies the five challenge questions (Section 12).

### Removing Operations

1. Remove from `OPERATIONS` array in registry.
2. Old operation names return `E_INVALID_OPERATION` at runtime.
3. Update this document to remove the operation and add migration path to Merged/Removed notes.

### Renaming Operations

1. Add new name to registry.
2. Add old name as `aliases` entry on the new definition.
3. Update this document to reflect the rename.

---

## 14. Appendix A: Error Codes

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

## 15. Appendix B: Field Naming Conventions

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

## 16. Appendix C: Migration Reference (268→164 Rationalization)

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
| `admin.sync` | `tools.todowrite.sync` (domain changed) |
| `admin.sync.status` | `tools.todowrite.status` (domain changed) |
| `admin.sync.clear` | `tools.todowrite.clear` (domain changed) |
| `nexus.query` | `nexus.resolve` (renamed; `query` is a prohibited verb) |
| `nexus.critical-path` | `nexus.path.show` (alias removed) |
| `nexus.blocking` | `nexus.blockers.show` (alias removed) |
| `nexus.orphans` | `nexus.orphans.list` (alias removed) |
| `nexus.sync.all` | `nexus.sync` (without `name` param syncs all) |

---

## References

- `src/dispatch/registry.ts` -- Executable SSoT
- `src/dispatch/types.ts` -- Type definitions
- `docs/specs/VERB-STANDARDS.md` -- Canonical verb standards
- `docs/specs/MCP-SERVER-SPECIFICATION.md` -- MCP server contract
- `docs/specs/MCP-AGENT-INTERACTION-SPEC.md` -- Progressive disclosure patterns
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md` -- Visual architecture guide
- `.cleo/adrs/ADR-030-operation-model-rationalization.md` -- Rationalization ADR (T5611)
- `.cleo/agent-outputs/CLEO-OPERATIONS-CONSOLIDATION-DECISION.md` -- Full decision matrix (T5609)
- `.cleo/agent-outputs/T5608-tier-audit.md` -- Tier assignment audit
