# CLEO Operations Reference

**Version**: 1.1.0
**Status**: CANONICAL
**Date**: 2026-02-27
**Task**: T4732
**Supersedes**: docs/commands/COMMANDS-INDEX.json

---

## Authority

This document is the single source of truth for all CLEO operations. Both MCP gateway registries and CLI command registrations MUST match this reference.

Implementation source files:
- MCP Query: `src/mcp/gateways/query.ts`
- MCP Mutate: `src/mcp/gateways/mutate.ts`
- CLI: `src/cli/index.ts` + `src/cli/commands/*.ts`
- Core: `src/core/` + `src/mcp/engine/`

## Operation Counts

| Gateway | Operations | Domains |
|---------|-----------|---------|
| cleo_query | 97 | 10 |
| cleo_mutate | 80 | 10 |
| **Total** | **177** | **10** |

Canonical domains: tasks, session, orchestrate, memory, check, pipeline, admin, tools, nexus, sharing
Legacy aliases (backward compat): research, lifecycle, validate, release, system, issues, skills, providers

> **Note**: The per-domain tables below use legacy domain names (research, lifecycle, validate,
> release, system, issues, skills, providers) for historical continuity. These map to canonical
> domains (memory, pipeline, check, pipeline, admin, tools, tools, tools) via gateway alias routing.
> Some per-domain counts are stale; refer to `src/mcp/gateways/query.ts` and `mutate.ts` for
> current operation lists.

## Naming Conventions (T4732)

- All operations use **dot.notation** for multi-word names
- CRUD verbs: `add` (create), `show` (read), `update`, `delete`
- Task work: `start` (begin), `stop` (end), `current` (show active)
- Standard verbs: `list`, `find`, `validate`, `record`, `restore`

---

## Domain: tasks

The core task management domain. Handles CRUD, hierarchy, dependencies, focus, and analysis.

### Query Operations (13)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `show` | `cleo show <id>` | Get task details | `taskId` | 0 |
| `list` | `cleo list` | List tasks with filters | `parent?`, `status?`, `limit?` | 0 |
| `find` | `cleo find <query>` | Search tasks by text | `query`, `limit?` | 0 |
| `exists` | `cleo exists <id>` | Check task exists | `taskId` | 1 |
| `tree` | `cleo tree` | Hierarchical view | `rootId?`, `depth?` | 1 |
| `blockers` | `cleo blockers <id>` | Blocking chain analysis | `taskId` | 1 |
| `depends` | `cleo deps <id>` | Dependency graph | `taskId`, `direction?` | 1 |
| `analyze` | `cleo analyze` | Triage with scoring | `epicId?` | 2 |
| `next` | `cleo next` | Smart task suggestion | `epicId?`, `count?` | 0 |
| `plan` | `cleo plan` | Composite planning view | - | 0 |
| `relates` | `cleo relates <id>` | Relationship query | `taskId` | 2 |
| `complexity.estimate` | N/A | Complexity scoring | `taskId` | 2 |
| `current` | `cleo current` | Currently active task | - | 0 |

### Mutate Operations (13)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `add` | `cleo add <title>` | Create new task | `title`, `description?`, `parent?`, `priority?`, `labels?`, `depends?` | 0 |
| `update` | `cleo update <id>` | Update task fields | `taskId`, `title?`, `status?`, `priority?`, `notes?` | 0 |
| `complete` | `cleo complete <id>` | Mark task done | `taskId`, `notes?` | 0 |
| `delete` | `cleo delete <id>` | Delete/cancel task | `taskId`, `force?`, `reason?` | 1 |
| `archive` | `cleo archive` | Archive done tasks | `taskId?`, `before?` | 2 |
| `restore` | `cleo restore <id>` | Restore from archive | `taskId` | 2 |
| `reparent` | `cleo reparent <id> --to <parent>` | Change parent | `taskId`, `newParent` | 2 |
| `promote` | `cleo promote <id>` | Promote to root level | `taskId` | 2 |
| `reorder` | `cleo reorder <id>` | Reorder siblings | `taskId`, `position` | 2 |
| `reopen` | N/A (MCP only) | Reopen completed task | `taskId` | 2 |
| `relates.add` | `cleo relates <id> --add <other>` | Add relationship | `taskId`, `relatedId`, `type?` | 2 |
| `start` | `cleo start <id>` | Start working (set focus) | `taskId` | 0 |
| `stop` | `cleo stop` | Stop working (clear focus) | - | 0 |

---

## Domain: session

Work session lifecycle and decision tracking.

### Query Operations (10)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `status` | `cleo session status` | Current session state | - | 1 |
| `list` | `cleo session list` | List sessions | `active?` | 2 |
| `show` | `cleo session show <id>` | Session details | `sessionId` | 2 |
| `history` | `cleo session history` | Session history | `limit?` | 2 |
| `decision.log` | N/A | Decision audit log | `sessionId?` | 2 |
| `context.drift` | N/A | Context drift analysis | `sessionId?` | 3 |
| `handoff.show` | `cleo session handoff` | Show handoff data | `scope?` | 0 |
| `briefing.show` | `cleo briefing` | Session-start context | `scope?`, `maxNext?` | 0 |
| `debrief.show` | N/A | Session debrief data | `sessionId?` | 2 |
| `chain.show` | N/A | Session chain view | `sessionId?` | 2 |

### Mutate Operations (7)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `start` | `cleo session start` | Start new session | `scope`, `name?` | 1 |
| `end` | `cleo session end` | End session | `notes?` | 1 |
| `resume` | `cleo session resume <id>` | Resume session | `sessionId` | 2 |
| `suspend` | `cleo session suspend` | Suspend session | `notes?` | 2 |
| `gc` | `cleo session gc` | Garbage collect | `olderThan?` | 3 |
| `record.decision` | N/A | Record decision | `decision`, `rationale` | 1 |
| `record.assumption` | N/A | Record assumption | `assumption`, `basis` | 2 |

---

## Domain: orchestrate

Multi-agent coordination and parallel execution.

### Query Operations (9)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `status` | `cleo orchestrate status` | Orchestrator state | `epicId` | 3 |
| `next` | `cleo orchestrate next` | Next to spawn | `epicId` | 3 |
| `ready` | `cleo orchestrate ready` | Parallel-safe tasks | `epicId` | 3 |
| `analyze` | `cleo orchestrate analyze` | Dependency analysis | `epicId` | 3 |
| `context` | `cleo context` | Context budget | `tokens?` | 2 |
| `waves` | `cleo orchestrate waves` | Wave computation | `epicId` | 3 |
| `bootstrap` | N/A | Brain state bootstrap | `epicId?` | 3 |
| `unblock.opportunities` | N/A | Unblock analysis | `epicId?` | 3 |
| `critical.path` | N/A | Critical path | `epicId` | 3 |

### Mutate Operations (5)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `start` | `cleo orchestrate start` | Initialize | `epicId` | 3 |
| `spawn` | `cleo orchestrate spawn` | Generate spawn | `taskId`, `skill?` | 3 |
| `validate` | `cleo orchestrate validate` | Validate readiness | `taskId` | 3 |
| `parallel.start` | N/A | Start wave | `epicId`, `wave` | 3 |
| `parallel.end` | N/A | End wave | `epicId`, `wave` | 3 |

---

## Domain: research

Research protocol management and manifest operations.

### Query Operations (8)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `show` | `cleo research show <id>` | Research details | `researchId` | 2 |
| `list` | `cleo research list` | List entries | `epicId?`, `status?` | 2 |
| `find` | `cleo research find` | Find research | `query` | 2 |
| `pending` | `cleo research pending` | Needs follow-up | `epicId?` | 2 |
| `stats` | `cleo research stats` | Statistics | `epicId?` | 2 |
| `manifest.read` | N/A | Read manifest | `filter?`, `limit?` | 3 |
| `contradictions` | N/A | Conflicting findings | `epicId?` | 3 |
| `superseded` | N/A | Superseded entries | `epicId?` | 3 |

### Mutate Operations (4)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `inject` | `cleo research inject` | Protocol injection | `protocolType`, `taskId?` | 3 |
| `link` | `cleo research link` | Link to task | `researchId`, `taskId` | 2 |
| `manifest.append` | N/A | Append entry | `entry` | 3 |
| `manifest.archive` | N/A | Archive entries | `beforeDate?` | 3 |

---

## Domain: memory

Native BRAIN memory system for persistent knowledge storage and retrieval across sessions.

### Query Operations (3)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `brain.search` | N/A | Search memory index | `query`, `limit?` (default 10), `tables?` (decisions/patterns/learnings/observations), `dateStart?`, `dateEnd?` | 2 |
| `brain.timeline` | N/A | Context around anchor | `anchor` (entry ID), `depthBefore?` (default 3), `depthAfter?` (default 3) | 2 |
| `brain.fetch` | N/A | Fetch full entry details | `ids` (string[]) | 2 |

### Mutate Operations (1)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `brain.observe` | N/A | Save observation | `text`, `title?`, `type?` (auto-classified if omitted), `project?`, `sourceSessionId?`, `sourceType?` | 2 |

**Token budget**:
- `brain.search`: ~50 tokens per result (returns `{results: [{id, type, title, date, relevance}], total, tokensEstimated}`)
- `brain.timeline`: ~200-500 tokens (returns `{anchor: {id, type, data}, before: [...], after: [...]}`)
- `brain.fetch`: ~500 tokens per entry (returns `{results: [{id, type, data}], notFound: string[], tokensEstimated}`)
- `brain.observe`: returns `{id, type, createdAt}` — content hash dedup prevents duplicates within 30-second window

**3-layer retrieval pattern**: Search first (cheap) → filter interesting IDs → fetch only what you need.

---

## Domain: lifecycle

RCSD-IVTR pipeline stage management.

### Query Operations (5)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `validate` | `cleo lifecycle validate` | Check prerequisites | `taskId`, `targetStage` | 3 |
| `status` | `cleo lifecycle status` | Current state | `taskId` or `epicId` | 2 |
| `history` | `cleo lifecycle history` | Transition log | `taskId` | 3 |
| `gates` | `cleo lifecycle gates` | Gate statuses | `taskId` | 3 |
| `prerequisites` | N/A | Required stages | `targetStage` | 3 |

### Mutate Operations (5)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `record` | `cleo lifecycle record` | Record completion | `taskId`, `stage`, `status` | 3 |
| `skip` | `cleo lifecycle skip` | Skip stage | `taskId`, `stage`, `reason` | 3 |
| `reset` | `cleo lifecycle reset` | Reset stage | `taskId`, `stage`, `reason` | 3 |
| `gate.pass` | `cleo verify --gate <g> --value pass` | Pass gate | `taskId`, `gateName`, `agent` | 3 |
| `gate.fail` | `cleo verify --gate <g> --value fail` | Fail gate | `taskId`, `gateName`, `reason` | 3 |

---

## Domain: validate

Validation, compliance, and quality checks.

### Query Operations (10)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `schema` | `cleo validate` | JSON Schema check | `fileType`, `filePath?` | 2 |
| `protocol` | `cleo compliance` | Protocol compliance | `taskId`, `protocolType` | 2 |
| `task` | N/A | Anti-hallucination check | `taskId`, `checkMode` | 2 |
| `manifest` | N/A | Manifest integrity | `entry` or `taskId` | 3 |
| `output` | N/A | Output file check | `taskId`, `filePath` | 3 |
| `compliance.summary` | `cleo compliance summary` | Compliance metrics | `scope?`, `since?` | 2 |
| `compliance.violations` | `cleo compliance violations` | List violations | `severity?` | 2 |
| `test.status` | N/A | Test suite status | `taskId?` | 2 |
| `test.coverage` | N/A | Coverage metrics | `taskId?` | 3 |
| `coherence.check` | N/A | Graph consistency | `scope?` | 3 |

### Mutate Operations (2)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `compliance.record` | N/A | Record check result | `taskId`, `result` | 3 |
| `test.run` | `cleo testing` | Execute tests | `scope?`, `pattern?` | 3 |

---

## Domain: release

Release lifecycle management.

### Query Operations (0)

No query operations.

### Mutate Operations (7)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `prepare` | `cleo release prepare` | Prepare release | `version`, `type` | 3 |
| `changelog` | `cleo release changelog` | Generate changelog | `version` | 3 |
| `commit` | `cleo release commit` | Create commit | `version` | 3 |
| `tag` | `cleo release tag` | Create git tag | `version` | 3 |
| `push` | `cleo release push` | Push to remote | `version` | 3 |
| `gates.run` | `cleo release gates` | Run release gates | `gates?` | 3 |
| `rollback` | `cleo release rollback` | Rollback release | `version`, `reason` | 3 |

---

## Domain: system

System administration, configuration, and observability.

### Query Operations (14)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `version` | `cleo --version` | Version info | - | 1 |
| `health` | `cleo doctor` | Health check | - | 1 |
| `config.get` | `cleo config get <key>` | Get config | `key` | 1 |
| `stats` | `cleo stats` | Project statistics | - | 1 |
| `context` | `cleo context` | Context window | - | 2 |
| `job.status` | N/A | Background job status | `jobId` | 3 |
| `job.list` | N/A | List jobs | `status?` | 3 |
| `dash` | `cleo dash` | Dashboard | - | 1 |
| `roadmap` | `cleo roadmap` | Roadmap view | `epicId?` | 2 |
| `labels` | `cleo labels` | Label listing | `filter?` | 2 |
| `compliance` | `cleo compliance` | Compliance metrics | `scope?` | 2 |
| `log` | `cleo log` | Audit log | `limit?`, `since?` | 2 |
| `archive.stats` | `cleo archive-stats` | Archive analytics | - | 2 |
| `sequence` | `cleo sequence` | ID sequence | - | 3 |

### Mutate Operations (11)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `init` | `cleo init` | Initialize project | `projectType?` | 1 |
| `config.set` | `cleo config set <key> <val>` | Set config | `key`, `value` | 2 |
| `backup` | `cleo backup` | Create backup | `type?`, `note?` | 2 |
| `restore` | `cleo restore <id>` | Restore backup | `backupId` | 2 |
| `migrate` | `cleo migrate` | Run migrations | `version?`, `dryRun?` | 2 |
| `sync` | `cleo sync` | Sync TodoWrite | `direction?` | 2 |
| `cleanup` | N/A | Cleanup stale data | `type`, `olderThan?` | 3 |
| `job.cancel` | N/A | Cancel job | `jobId` | 3 |
| `safestop` | `cleo safestop` | Agent shutdown | `reason?` | 1 |
| `uncancel` | N/A | Restore cancelled | `taskId` | 2 |
| `inject.generate` | N/A | Generate injection | `level?`, `format?` | 3 |

---

## Domain: issues

GitHub issue integration.

### Query Operations (1)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `diagnostics` | `cleo issue diagnostics` | System diagnostics | - | 2 |

### Mutate Operations (3)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `create.bug` | `cleo issue bug` | File bug report | `title`, `body` | 2 |
| `create.feature` | `cleo issue feature` | Request feature | `title`, `body` | 2 |
| `create.help` | `cleo issue help` | Ask question | `title`, `body` | 2 |

---

## Domain: skills

Skill management system.

### Query Operations (6)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `list` | `cleo skills list` | List skills | `filter?` | 2 |
| `show` | `cleo skills show <id>` | Skill details | `skillId` | 2 |
| `find` | `cleo skills find` | Find skills | `query` | 2 |
| `dispatch` | N/A | Dispatch simulation | `taskId` | 3 |
| `verify` | N/A | Validate frontmatter | `skillId` | 3 |
| `dependencies` | N/A | Dependency tree | `skillId` | 3 |

### Mutate Operations (6)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `install` | `cleo skills install` | Install skill | `skillId`, `source?` | 2 |
| `uninstall` | `cleo skills uninstall` | Remove skill | `skillId` | 2 |
| `enable` | `cleo skills enable` | Enable skill | `skillId` | 2 |
| `disable` | `cleo skills disable` | Disable skill | `skillId` | 2 |
| `configure` | `cleo skills configure` | Configure skill | `skillId`, `config` | 3 |
| `refresh` | `cleo skills refresh` | Refresh registry | - | 3 |

---

## Domain: providers

Agent provider management (CAAMP integration).

### Query Operations (3)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `list` | N/A | List providers | - | 2 |
| `detect` | N/A | Detect installed | - | 2 |
| `inject.status` | N/A | Injection status | `providerId?` | 2 |

### Mutate Operations (1)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `inject` | N/A | Inject into provider | `providerId`, `content?` | 3 |

---

## Domain: sharing

Multi-contributor operations for task database sharing and synchronization.

### Query Operations (3)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `status` | N/A | Sharing status | - | 2 |
| `remotes` | N/A | List remotes | - | 2 |
| `sync.status` | N/A | Sync status | - | 2 |

### Mutate Operations (7)

| Operation | CLI Equivalent | Description | Key Params | Disclosure Level |
|-----------|---------------|-------------|------------|-----------------|
| `snapshot.export` | N/A | Export snapshot | - | 2 |
| `snapshot.import` | N/A | Import snapshot | - | 2 |
| `sync.gitignore` | N/A | Sync gitignore | - | 2 |
| `remote.add` | N/A | Add remote | `name`, `url` | 2 |
| `remote.remove` | N/A | Remove remote | `name` | 2 |
| `push` | N/A | Push to remote | `remote?` | 2 |
| `pull` | N/A | Pull from remote | `remote?` | 2 |

---

## Progressive Disclosure Levels

### Level 0: Minimal Entry (~200 tokens, always injected)

8 essential operations for 90% of agent sessions:

```
tasks.show    tasks.list    tasks.find    tasks.next
tasks.add     tasks.complete    tasks.start   tasks.current
```

### Level 1: Common Workflow (~500 tokens, multi-step tasks)

16 additional operations:

```
tasks.tree    tasks.blockers    tasks.delete    tasks.stop    tasks.update
session.start    session.end    session.status    session.record.decision
system.dash    system.health    system.version    system.init    system.safestop
system.stats    system.config.get
```

### Level 2: Extended (~2-5K tokens, on-demand)

All domain operations for: validate, research, lifecycle, skills, issues, providers, plus remaining tasks/session/system operations.

### Level 3: Full Protocol (~5-15K tokens, orchestrators only)

Complete protocol stack including RCSD-IVTR lifecycle, orchestration waves, manifest management, release pipeline, and compliance enforcement.

---

## Terminology Changes (T4732)

| Old Name | New Name | Domain | Rationale |
|----------|----------|--------|-----------|
| `get` | `show` | tasks | CLI verb alignment |
| `create` | `add` | tasks | CLI verb alignment |
| `unarchive` | `restore` | tasks | Unified restore verb |
| `tasks.start` | `start` | tasks | Moved from session |
| `tasks.stop` | `stop` | tasks | Moved from session |
| `focus.get` | `current` | tasks | Moved from session |
| `startup` | `start` | orchestrate | Simpler verb |
| `progress` | `record` | lifecycle | More descriptive |
| `check` | `validate` | lifecycle | Verb unification |
| `query` | `find` | research | Verb standardization |
| `doctor` | `health` | system | Standard verb |
| All hyphens | dot.notation | All | Convention: `complexity.estimate` not `complexity-estimate` |
| All underscores | dot.notation | issues | Convention: `create.bug` not `create_bug` |

---

## References

- MCP Server Specification: `docs/specs/MCP-SERVER-SPECIFICATION.md`
- MCP Agent Interaction Spec: `docs/specs/MCP-AGENT-INTERACTION-SPEC.md`
- Gateway Source (query): `src/mcp/gateways/query.ts`
- Gateway Source (mutate): `src/mcp/gateways/mutate.ts`
- CLI Entry: `src/cli/index.ts`
- Core Logic: `src/core/`
- Deprecated: `docs/commands/COMMANDS-INDEX.json` (replaced by this document)

---

## Changelog

### v1.1.0 (2026-02-27)

- Reconciled with actual registry: 164 operations (93 query + 71 mutate)
- Updated to 10 canonical domains (tasks, session, memory, check, pipeline, orchestrate, tools, admin, nexus, sharing)
- Legacy domain aliases documented for backward compatibility

### v1.0.0 (2026-02-20)

- Initial canonical operations reference
- 140 operations (75 query + 65 mutate) across 11 domains
- Progressive disclosure level assignments
- CLI equivalents for all applicable operations
- T4732 terminology changes documented
