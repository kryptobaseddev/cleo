# CLEO Operation Constitution

**Version**: 2026.3.4
**Status**: APPROVED
**Date**: 2026-03-04
**Task**: T5250
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
| `check` | Schema validation, protocol compliance, test execution | tasks.db (audit) |
| `pipeline` | RCSD lifecycle stages, manifest ledger, release management | MANIFEST.jsonl, tasks.db |
| `orchestrate` | Multi-agent coordination, wave planning, parallel execution | tasks.db |
| `tools` | Skills, providers, issues, CAAMP catalog | .cleo/skills/ |
| `admin` | Configuration, backup, migration, diagnostics, ADRs | config.json, tasks.db |
| `nexus` | Cross-project coordination, registry, dependency graph, sharing operations | nexus.db |
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
| `restore` | Restore from terminal state | `tasks.restore`, `admin.restore` |
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
| `enable` / `disable` | Feature toggle | `tools.skill.enable` |
| `backup` | Create backup | `admin.backup` |
| `migrate` | Schema migration | `admin.migrate` |
| `inject` | Protocol injection | `session.context.inject` |
| `run` | Execute action (compound only) | `check.test.run` |
| `link` | Associate entities | `memory.link` |
| `observe` | Save observation | `memory.observe` |
| `store` | Append-only memory write | `memory.decision.store` |
| `fetch` | Batch retrieve by IDs | `memory.fetch` |
| `plan` | Composite planning view | `tasks.plan` |
| `sync` | Synchronize data | `admin.sync`, `nexus.sync` |
| `check` | Check system liveness/health | `admin.health`, `check.coherence.check` |
| `verify` | Verify artifact gates/frontmatter | `tools.skill.verify` |
| `validate` | Validate compliance/schema | `pipeline.stage.validate`, `check.schema` |
| `timeline` | Chronological context retrieval | `memory.timeline` |
| `convert` | Transform entity type | `sticky.convert` |
| `unlink` | Dissociate entities | `memory.unlink` |
| `compute` | Compute derived values | Reserved — not yet in registry |

> **Note**: `unlink` and `compute` are spec-ahead -- documented in the Constitution for completeness, not yet in registry.

Deprecated verbs (`create`, `get`, `search`, `query` as verb) MUST NOT appear in new operations.

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
}
```

**Field semantics:**

- **gateway**: Determines which MCP tool handles the operation. Query operations MUST NOT modify state.
- **tier**: Controls progressive disclosure. Agents start at tier 0 and escalate. See Section 7.
- **idempotent**: When `true`, the operation is safe to retry on failure without side effects.
- **requiredParams**: The dispatcher validates these are present before routing to the domain handler. Missing params return `E_INVALID_INPUT`.
- **aliases**: Old operation names that still resolve to this definition. Aliases appear in gateway matrices for validation but route to the canonical handler.

---

## 6. Domain Operation Tables

### 6.1 tasks (32 operations)

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `show` | Show task details by ID | 0 | -- | Yes |
| query | `list` | List tasks with filters | 0 | -- | Yes |
| query | `find` | Search tasks by keyword | 0 | -- | Yes |
| query | `exists` | Check if task ID exists | 0 | -- | Yes |
| query | `tree` | Display task hierarchy tree | 0 | -- | Yes |
| query | `blockers` | Show blocking dependencies | 0 | -- | Yes |
| query | `depends` | Show dependency graph | 0 | -- | Yes |
| query | `analyze` | Analyze task metrics | 0 | -- | Yes |
| query | `next` | Suggest next task to work on | 0 | -- | Yes |
| query | `plan` | Composite planning view (epics, ready, blocked, bugs) | 0 | -- | Yes |
| query | `relates` | Show related tasks | 0 | -- | Yes |
| query | `complexity.estimate` | Estimate task complexity | 0 | -- | Yes |
| query | `current` | Show currently active task | 0 | -- | Yes |
| query | `label.list` | List all labels with task counts | 1 | -- | Yes |
| query | `label.show` | Show tasks with a specific label | 1 | `label` | Yes |
| mutate | `add` | Create new task | 0 | -- | No |
| mutate | `update` | Modify task properties (`status=done` MUST route to completion semantics) | 0 | -- | No |
| mutate | `complete` | Canonical completion path (deps, acceptance policy, verification gates) | 0 | -- | No |
| mutate | `cancel` | Cancel task (soft terminal state — reversible via `restore`) | 0 | `taskId` | No |
| mutate | `delete` | Permanently remove task | 0 | -- | No |
| mutate | `archive` | Soft-delete task to archive | 0 | -- | No |
| mutate | `restore` | Restore task from terminal state | 0 | -- | No |
| mutate | `reparent` | Move task to new parent | 0 | -- | No |
| mutate | `promote` | Promote subtask to top-level | 0 | -- | No |
| mutate | `reorder` | Reorder tasks within parent | 0 | -- | No |
| mutate | `relates.add` | Add task relationship | 0 | -- | No |
| mutate | `start` | Begin working on task | 0 | -- | No |
| mutate | `stop` | Stop working on task | 0 | -- | No |
| query | `relates.find` | Find suggested and discovered task relationships | 1 | `taskId` | Yes |
| query | `history` | Show task work history (time tracked per task) | 1 | -- | Yes |
| mutate | `reopen` | tasks.reopen (mutate) - reopen completed tasks | 0 | `taskId` | No |
| mutate | `unarchive` | tasks.unarchive (mutate) - restore archived tasks | 0 | `taskId` | No |

### 6.2 session (19 operations)

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `status` | Show current session status | 0 | -- | Yes |
| query | `list` | List sessions | 0 | -- | Yes |
| query | `show` | Show session details | 0 | -- | Yes |
| query | `history` | Show session history | 0 | -- | Yes |
| query | `decision.log` | Show session decision log | 0 | -- | Yes |
| query | `context.drift` | Detect context drift in session | 0 | -- | Yes |
| query | `handoff.show` | Show handoff data from most recent ended session | 0 | -- | Yes |
| query | `briefing.show` | Composite session-start context briefing | 0 | -- | Yes |
| query | `debrief.show` | Read session rich debrief data | 1 | `sessionId` | Yes |
| query | `chain.show` | Show session chain linked via previous/next | 1 | `sessionId` | Yes |
| query | `find` | Lightweight session discovery | 0 | -- | Yes |
| mutate | `start` | Begin new session | 0 | -- | No |
| mutate | `end` | End current session | 0 | -- | No |
| mutate | `resume` | Resume suspended session | 0 | -- | No |
| mutate | `suspend` | Suspend session without ending | 0 | -- | No |
| mutate | `gc` | Garbage-collect stale sessions | 0 | -- | No |
| mutate | `record.decision` | Record a decision in current session | 0 | -- | No |
| mutate | `record.assumption` | Record an assumption in current session | 0 | -- | No |
| mutate | `context.inject` | Inject protocol content into session context | 1 | `protocolType` | Yes |

### 6.3 memory (18 operations)

All memory operations target **brain.db** (SQLite with FTS5). The memory domain is the runtime interface to the BRAIN cognitive system.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `show` | Look up brain.db entry by ID | 1 | `entryId` | Yes |
| query | `find` | Cross-table brain.db FTS5 search | 1 | `query` | Yes |
| query | `timeline` | Chronological context around anchor entry | 1 | `anchor` | Yes |
| query | `fetch` | Batch fetch brain entries by IDs | 1 | `ids` | Yes |
| query | `stats` | Brain.db aggregate statistics | 1 | -- | Yes |
| query | `contradictions` | Find contradictory entries in brain.db | 1 | -- | Yes |
| query | `superseded` | Find superseded entries in brain.db | 1 | -- | Yes |
| query | `decision.find` | Search decisions in brain.db | 1 | -- | Yes |
| query | `pattern.find` | Search patterns by type, impact, or keyword | 1 | -- | Yes |
| query | `pattern.stats` | Pattern memory statistics (counts by type and impact) | 1 | -- | Yes |
| query | `learning.find` | Search learnings by confidence, actionability, or keyword | 1 | -- | Yes |
| query | `learning.stats` | Learning memory statistics (counts by confidence band) | 1 | -- | Yes |
| mutate | `observe` | Save observation to brain.db | 1 | `text` | No |
| mutate | `decision.store` | Store decision to brain.db | 1 | `decision`, `rationale` | No |
| mutate | `pattern.store` | Store reusable workflow or anti-pattern | 1 | `pattern`, `context` | No |
| mutate | `learning.store` | Store insight or lesson learned | 1 | `insight`, `source` | No |
| mutate | `link` | Link brain entry to task | 1 | `taskId`, `entryId` | No |
| mutate | `unlink` | Remove link between brain entry and task | 1 | `taskId`, `entryId` | Yes |

### 6.4 check (19 operations)

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `schema` | Validate data against JSON Schema | 0 | -- | Yes |
| query | `protocol` | Check protocol compliance | 0 | -- | Yes |
| query | `task` | Validate task data integrity | 0 | -- | Yes |
| query | `manifest` | Validate manifest entries | 0 | -- | Yes |
| query | `output` | Validate command output format | 0 | -- | Yes |
| query | `compliance.summary` | Compliance summary report | 0 | -- | Yes |
| query | `compliance.violations` | List compliance violations | 0 | -- | Yes |
| query | `test.status` | Show test suite status | 0 | -- | Yes |
| query | `test.coverage` | Show test coverage metrics | 0 | -- | Yes |
| query | `coherence.check` | Check cross-data coherence | 0 | -- | Yes |
| mutate | `compliance.record` | Record compliance check result | 0 | -- | No |
| mutate | `test.run` | Execute test suite | 0 | -- | No |
| query | `protocol.consensus` | check.protocol.consensus (query) - Validate consensus protocol compliance | 0 | -- | Yes |
| query | `protocol.contribution` | check.protocol.contribution (query) - Validate contribution protocol compliance | 0 | -- | Yes |
| query | `protocol.decomposition` | check.protocol.decomposition (query) - Validate decomposition protocol compliance | 0 | -- | Yes |
| query | `protocol.implementation` | check.protocol.implementation (query) - Validate implementation protocol compliance | 0 | -- | Yes |
| query | `protocol.specification` | check.protocol.specification (query) - Validate specification protocol compliance | 0 | -- | Yes |
| query | `gate.verify` | check.gate.verify (query) - View or modify verification gates | 0 | `taskId` | No |
| query | `chain.validate` | check.chain.validate (query) — validate a WarpChain definition | 2 | `chain` | Yes |

### 6.5 pipeline (37 operations)

The pipeline domain manages RCSD lifecycle stages, the MANIFEST.jsonl artifact ledger, and release orchestration.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `stage.validate` | Validate lifecycle stage prerequisites | 0 | -- | Yes |
| query | `stage.status` | Show lifecycle stage status | 0 | -- | Yes |
| query | `stage.history` | Show lifecycle stage history | 0 | -- | Yes |
| query | `stage.gates` | Show lifecycle gate definitions | 0 | -- | Yes |
| query | `stage.prerequisites` | Show stage prerequisite checks | 0 | -- | Yes |
| query | `manifest.show` | Get manifest entry by ID | 1 | `entryId` | Yes |
| query | `manifest.list` | List manifest entries with filters | 1 | -- | Yes |
| query | `manifest.find` | Search manifest entries by text | 1 | `query` | Yes |
| query | `manifest.pending` | Get pending manifest items | 1 | -- | Yes |
| query | `manifest.stats` | Manifest statistics | 1 | -- | Yes |
| mutate | `stage.record` | Record lifecycle stage completion | 0 | -- | No |
| mutate | `stage.skip` | Skip a lifecycle stage | 0 | -- | No |
| mutate | `stage.reset` | Reset lifecycle stage (emergency) | 0 | -- | No |
| mutate | `stage.gate.pass` | Mark lifecycle gate as passed | 0 | -- | No |
| mutate | `stage.gate.fail` | Mark lifecycle gate as failed | 0 | -- | No |
| mutate | `manifest.append` | Append entry to MANIFEST.jsonl | 1 | `entry` | No |
| mutate | `manifest.archive` | Archive old manifest entries | 1 | `beforeDate` | No |
| mutate | `release.prepare` | Prepare release (bump version, checks) | 0 | -- | No |
| mutate | `release.changelog` | Generate release changelog | 0 | -- | No |
| mutate | `release.commit` | Create release commit | 0 | -- | No |
| mutate | `release.tag` | Tag release in git | 0 | -- | No |
| mutate | `release.push` | Push release to remote | 0 | -- | No |
| mutate | `release.gates.run` | Run release gate checks | 0 | -- | No |
| mutate | `release.rollback` | Rollback failed release | 0 | -- | No |
| query | `phase.show` | Show phase details by slug or current phase (query) | 1 | -- | Yes |
| query | `phase.list` | List all phases with status and task counts (query) | 1 | -- | Yes |
| query | `chain.show` | pipeline.chain.show (query) — get chain definition by ID | 2 | `chainId` | Yes |
| query | `chain.list` | pipeline.chain.list (query) — list all chain definitions | 2 | -- | Yes |
| mutate | `phase.set` | Set the active phase | 1 | `phaseId` | No |
| mutate | `phase.start` | Start a phase (pending -> active) | 1 | `phaseId` | No |
| mutate | `phase.complete` | Complete a phase (active -> completed) | 1 | `phaseId` | No |
| mutate | `phase.advance` | Complete current phase and start next | 1 | -- | No |
| mutate | `phase.rename` | Rename a phase and update all task references | 1 | `oldName`, `newName` | No |
| mutate | `phase.delete` | Delete a phase with task reassignment protection | 1 | `phaseId` | No |
| mutate | `chain.add` | pipeline.chain.add (mutate) — store a validated chain definition | 2 | `chain` | No |
| mutate | `chain.instantiate` | pipeline.chain.instantiate (mutate) — create chain instance for epic | 2 | `chainId`, `epicId` | No |
| mutate | `chain.advance` | pipeline.chain.advance (mutate) — advance instance to next stage | 2 | `instanceId`, `nextStage` | No |

### 6.6 orchestrate (19 operations)

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `status` | Orchestration status | 0 | -- | Yes |
| query | `next` | Next orchestration action | 0 | -- | Yes |
| query | `ready` | Check orchestration readiness | 0 | -- | Yes |
| query | `analyze` | Analyze orchestration state | 0 | -- | Yes |
| query | `context` | Orchestration context | 0 | -- | Yes |
| query | `waves` | Parallel execution wave plan | 0 | -- | Yes |
| query | `bootstrap` | Orchestration bootstrap info | 0 | -- | Yes |
| query | `unblock.opportunities` | Find unblock opportunities | 0 | -- | Yes |
| query | `critical.path` | Critical path analysis | 0 | -- | Yes |
| mutate | `start` | Start orchestration | 0 | -- | No |
| mutate | `spawn` | Spawn sub-agent | 0 | -- | No |
| mutate | `spawn.execute` | Execute spawn for task using adapter registry | 0 | `taskId` | No |
| mutate | `validate` | Validate orchestration state | 0 | -- | No |
| mutate | `parallel.start` | Begin parallel execution wave | 0 | -- | No |
| mutate | `parallel.end` | End parallel execution wave | 0 | -- | No |
| mutate | `handoff` | orchestrate.handoff (mutate) — composite handoff (context.inject -> session.end -> spawn) | 1 | `taskId`, `protocolType` | No |
| query | `tessera.show` | orchestrate.tessera.show (query) — show a Tessera template by ID | 0 | `id` | Yes |
| query | `tessera.list` | orchestrate.tessera.list (query) — list all registered Tessera templates | 0 | -- | Yes |
| mutate | `tessera.instantiate` | orchestrate.tessera.instantiate (mutate) — instantiate a Tessera template into a chain instance | 0 | `templateId`, `epicId` | No |

### 6.7 tools (32 operations)

The tools domain aggregates skills, providers, issues, and the CAAMP catalog.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `issue.diagnostics` | Issue diagnostics | 0 | -- | Yes |
| query | `issue.templates` | List available issue templates | 2 | -- | Yes |
| query | `issue.validate.labels` | Validate issue labels | 2 | `labels` | Yes |
| query | `skill.list` | List installed skills | 0 | -- | Yes |
| query | `skill.show` | Show skill details | 0 | -- | Yes |
| query | `skill.find` | Search skills | 0 | -- | Yes |
| query | `skill.dispatch` | Dispatch skill execution | 0 | -- | Yes |
| query | `skill.verify` | Verify skill frontmatter | 0 | -- | Yes |
| query | `skill.dependencies` | Show skill dependencies | 0 | -- | Yes |
| query | `skill.spawn.providers` | List spawn-capable providers by capability | 1 | -- | Yes |
| query | `skill.catalog.protocols` | List CAAMP protocol definitions | 2 | -- | Yes |
| query | `skill.catalog.profiles` | List CAAMP dispatch profiles | 2 | -- | Yes |
| query | `skill.catalog.resources` | List CAAMP shared resources | 2 | -- | Yes |
| query | `skill.catalog.info` | Get CAAMP catalog metadata | 2 | -- | Yes |
| query | `skill.precedence.show` | Show skills precedence mapping | 1 | -- | Yes |
| query | `skill.precedence.resolve` | Resolve skill paths for provider | 1 | `providerId` | Yes |
| query | `provider.list` | List registered providers | 0 | -- | Yes |
| query | `provider.detect` | Detect available providers | 0 | -- | Yes |
| query | `provider.inject.status` | Provider injection status | 0 | -- | Yes |
| query | `provider.supports` | Check if provider supports capability | 1 | -- | Yes |
| query | `provider.hooks` | List providers by hook event support | 1 | -- | Yes |
| mutate | `issue.add.bug` | File bug report | 0 | -- | No |
| mutate | `issue.add.feature` | File feature request | 0 | -- | No |
| mutate | `issue.add.help` | File help request | 0 | -- | No |
| mutate | `issue.generate.config` | Generate issue template configuration | 2 | -- | No |
| mutate | `skill.install` | Install skill | 0 | -- | No |
| mutate | `skill.uninstall` | Uninstall skill | 0 | -- | No |
| mutate | `skill.enable` | Enable skill | 0 | -- | No |
| mutate | `skill.disable` | Disable skill | 0 | -- | No |
| mutate | `skill.configure` | Configure skill parameters | 0 | -- | No |
| mutate | `skill.refresh` | Refresh skill catalog | 0 | -- | No |
| mutate | `provider.inject` | Inject provider configuration | 0 | -- | No |

### 6.8 admin (43 operations)

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `version` | Show CLEO version | 0 | -- | Yes |
| query | `health` | System health check | 0 | -- | Yes |
| query | `config.show` | Show configuration value | 0 | -- | Yes |
| query | `stats` | Project statistics | 0 | -- | Yes |
| query | `context` | Project context info | 0 | -- | Yes |
| query | `runtime` | Runtime environment info | 0 | -- | Yes |
| query | `job.status` | Background job status | 0 | -- | Yes |
| query | `job.list` | List background jobs | 0 | -- | Yes |
| query | `dash` | Dashboard overview | 0 | -- | Yes |
| query | `log` | Read audit log | 0 | -- | Yes |
| query | `sequence` | Show sequence counter state | 0 | -- | Yes |
| query | `help` | Operations list and guidance (progressive disclosure) | 0 | -- | Yes |
| query | `grade` | Grade agent behavioral session (5-dimension rubric) | 2 | `sessionId` | Yes |
| query | `grade.list` | List past session grade results | 2 | -- | Yes |
| query | `archive.stats` | Archive statistics and analytics | 1 | -- | Yes |
| query | `adr.list` | List ADRs with optional status filter | 2 | -- | Yes |
| query | `adr.show` | Retrieve single ADR by ID with frontmatter | 2 | `adrId` | Yes |
| query | `adr.find` | Fuzzy search ADRs by title, summary, keywords | 1 | `query` | Yes |
| query | `doctor` | Comprehensive health check and diagnostics report | 0 | -- | Yes |
| mutate | `init` | Initialize CLEO project | 0 | -- | No |
| mutate | `config.set` | Set configuration value | 0 | -- | No |
| mutate | `backup` | Create backup | 0 | -- | No |
| mutate | `restore` | Restore from backup | 0 | -- | No |
| mutate | `migrate` | Run schema migrations | 0 | -- | No |
| mutate | `sync` | Synchronize data stores | 0 | -- | No |
| mutate | `cleanup` | Clean up stale data | 0 | -- | No |
| mutate | `job.cancel` | Cancel background job | 0 | -- | No |
| mutate | `safestop` | Graceful shutdown with state preservation | 0 | -- | No |
| mutate | `inject.generate` | Generate injection content | 0 | -- | No |
| mutate | `sequence` | Manage sequence counter | 0 | -- | No |
| mutate | `install.global` | Refresh global CLEO setup (providers, MCP configs) | 2 | -- | Yes |
| mutate | `adr.sync` | Sync ADR markdown files into architecture_decisions table | 2 | -- | Yes |
| mutate | `adr.validate` | Validate ADR frontmatter against schema | 2 | -- | Yes |
| mutate | `fix` | Auto-fix failed doctor checks | 0 | -- | No |
| mutate | `backup.restore` | admin.backup.restore (mutate) - restore individual file from backup | 0 | `file` | No |
| query | `sync.status` | Show current sync state with TodoWrite (query) | 1 | -- | Yes |
| mutate | `sync.clear` | Clear sync state without merging (mutate) | 1 | -- | No |
| query | `export` | admin.export (query) — export tasks to portable format (json, csv, tsv, markdown, todowrite) | 2 | -- | Yes |
| mutate | `import` | admin.import (mutate) — import tasks from export file | 2 | `file` | No |
| query | `snapshot.export` | admin.snapshot.export (query) — export current task state snapshot | 2 | -- | Yes |
| mutate | `snapshot.import` | admin.snapshot.import (mutate) — import tasks from snapshot file | 2 | `file` | No |
| query | `export.tasks` | admin.export.tasks (query) — export tasks to portable cross-project package | 2 | -- | Yes |
| mutate | `import.tasks` | admin.import.tasks (mutate) — import tasks from cross-project export package | 2 | `file` | No |

### 6.9 nexus (31 operations)

All nexus operations are tier 2 (cross-project coordination) except `reconcile` (tier 1). Includes 10 sharing operations in the `share.*` sub-namespace.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `status` | Overall NEXUS health status | 2 | -- | Yes |
| query | `list` | List all registered NEXUS projects | 2 | -- | Yes |
| query | `show` | Show specific project by name or hash | 2 | `name` | Yes |
| query | `query` | Resolve cross-project `project:taskId` query | 2 | `query` | Yes |
| query | `deps` | Cross-project dependency analysis | 2 | `query` | Yes |
| query | `graph` | Global dependency graph across all projects | 2 | -- | Yes |
| query | `path.show` | Show critical dependency path across projects | 2 | -- | Yes |
| query | `blockers.show` | Show blocking impact for a task query | 2 | `query` | Yes |
| query | `orphans.list` | List orphaned cross-project dependencies | 2 | -- | Yes |
| query | `critical-path` | Global critical path across all registered projects | 2 | -- | Yes |
| query | `blocking` | Blocking impact analysis for a task | 2 | `query` | Yes |
| query | `orphans` | Detect broken cross-project dependency references | 2 | -- | Yes |
| query | `discover` | Discover related tasks across registered projects | 2 | `query` | Yes |
| query | `search` | Search for patterns across registered projects | 2 | `query` | Yes |
| query | `share.status` | Sharing status | 2 | -- | Yes |
| query | `share.remotes` | List configured remotes | 2 | -- | Yes |
| query | `share.sync.status` | Sync status | 2 | -- | Yes |
| mutate | `init` | Initialize NEXUS (creates registry and directories) | 2 | -- | Yes |
| mutate | `register` | Register a project in NEXUS | 2 | `path` | No |
| mutate | `unregister` | Remove a project from NEXUS | 2 | `name` | No |
| mutate | `sync` | Sync project metadata (task count, labels) | 2 | `name` | Yes |
| mutate | `sync.all` | Sync all registered projects | 2 | -- | Yes |
| mutate | `permission.set` | Update project permissions | 2 | `name`, `level` | Yes |
| mutate | `reconcile` | Reconcile project identity with global nexus registry | 1 | -- | Yes |
| mutate | `share.snapshot.export` | Export project snapshot | 2 | -- | No |
| mutate | `share.snapshot.import` | Import project snapshot | 2 | -- | No |
| mutate | `share.sync.gitignore` | Sync gitignore with CLEO paths | 2 | -- | No |
| mutate | `share.remote.add` | Add sharing remote | 2 | -- | No |
| mutate | `share.remote.remove` | Remove sharing remote | 2 | -- | No |
| mutate | `share.push` | Push to sharing remote | 2 | -- | No |
| mutate | `share.pull` | Pull from sharing remote | 2 | -- | No |

### 6.10 sticky (6 operations)

All sticky operations are tier 0 (quick capture). Sticky notes are lightweight capture entries that can be converted to tasks or memory.

| Gateway | Operation | Description | Tier | Required Params | Idempotent |
|---------|-----------|-------------|------|-----------------|------------|
| query | `list` | List sticky notes | 0 | -- | Yes |
| query | `show` | Show sticky note details | 0 | `stickyId` | Yes |
| mutate | `add` | Create new sticky note | 0 | `content` | No |
| mutate | `convert` | Convert sticky to task or memory | 0 | `stickyId`, `targetType` | No |
| mutate | `archive` | Archive sticky note | 0 | `stickyId` | No |
| mutate | `purge` | sticky.purge (mutate) — permanently delete sticky notes | 0 | `stickyId` | Yes |

### Summary Counts

| Domain | Query | Mutate | Total |
|--------|-------|--------|-------|
| tasks | 17 | 15 | 32 |
| session | 11 | 8 | 19 |
| memory | 12 | 6 | 18 |
| check | 17 | 2 | 19 |
| pipeline | 14 | 24 | 38 |
| orchestrate | 11 | 8 | 19 |
| tools | 21 | 11 | 32 |
| admin | 23 | 20 | 43 |
| nexus | 17 | 14 | 31 |
| sticky | 2 | 4 | 6 |
| **Total** | **145** | **112** | **257** |

---

## 7. Progressive Disclosure Contract

Operations are organized into 3 tiers. Agents SHOULD start at tier 0 and escalate only when needed:

### Tier 0 -- Core (149 operations)

Available to all agents from session start. Covers 65% of typical workflows.

**Domains**: tasks, session, check, pipeline, orchestrate, tools, admin, sticky

### Tier 1 -- Extended (51 operations)

Memory, manifest, and advanced query operations. Agents escalate here when they need cognitive memory or research artifact access.

**Domains**: memory plus extended operations across pipeline, session, admin, and tools

### Tier 2 -- Full System (56 operations)

Cross-project coordination, advanced tooling, and administrative functions. Used by orchestrator agents and system administrators.

**Domains**: nexus plus advanced operations across admin and tools

### Tier Escalation

An agent discovers tier 1+ operations via `admin.help`:

```
query { domain: "admin", operation: "help" }                  -- tier 0 ops
query { domain: "admin", operation: "help", params: { tier: 1 } }  -- + tier 1
query { domain: "admin", operation: "help", params: { tier: 2 } }  -- all ops
```

---

## 8. Injection Contract

Protocol injection is performed via `session.context.inject` (mutate gateway):

```
mutate {
  domain: "session",
  operation: "context.inject",
  params: {
    protocolType: "research",    // required
    taskId: "T123",              // optional
    variant: "default"           // optional
  }
}
```

Valid `protocolType` values are defined by the CAAMP catalog and skill registry. Common types include `research`, `orchestrator`, `lifecycle`, and `validator`.

---

## 9. CLI/MCP Parity Rules

1. The same `{domain}.{operation}` semantics apply to both CLI and MCP.
2. CLI commands map 1:1 to MCP operations where possible: `cleo show T123` = `query tasks.show { id: "T123" }`.
3. CLI MAY provide aliases for convenience (e.g., `cleo done` for `tasks.complete`).
4. MCP operations are the canonical names; CLI aliases are cosmetic.
5. Both interfaces route through the shared dispatch layer (`src/dispatch/`) to `src/core/`.

---

## 10. Validation and CI Enforcement

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

---

## 11. Change Control

### Adding Operations

1. Add `OperationDef` entry to `OPERATIONS` array in `src/dispatch/registry.ts`.
2. Implement handler in the appropriate domain handler (`src/dispatch/domains/`).
3. Wire core logic in `src/core/`.
4. Update this document (Section 6 tables).
5. Add tests for the new operation.

### Removing Operations

1. Remove from `OPERATIONS` array in registry.
2. Old operation names return `E_INVALID_OPERATION` at runtime.
3. Update this document to remove the operation.

### Renaming Operations

1. Add new name to registry.
2. Add old name as `aliases` entry on the new definition.
3. Update this document to reflect the rename.

---

## 12. Appendix A: Error Codes

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

## 13. Appendix B: Field Naming Conventions

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

## References

- `src/dispatch/registry.ts` -- Executable SSoT
- `src/dispatch/types.ts` -- Type definitions
- `docs/specs/VERB-STANDARDS.md` -- Canonical verb standards
- `docs/specs/MCP-SERVER-SPECIFICATION.md` -- MCP server contract
- `docs/specs/MCP-AGENT-INTERACTION-SPEC.md` -- Progressive disclosure patterns
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md` -- Visual architecture guide
