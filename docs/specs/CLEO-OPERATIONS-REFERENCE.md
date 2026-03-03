> **SUPERSEDED**: This document has been replaced by
> [CLEO-OPERATION-CONSTITUTION.md](CLEO-OPERATION-CONSTITUTION.md) as of 2026-03-03.
> Retained for historical reference.

# CLEO Operations Reference

**Version**: 1.2.0
**Status**: SUPERSEDED
**Date**: 2026-03-02
**Task**: T4732
**Supersedes**: docs/commands/COMMANDS-INDEX.json
**Last verified against gateway matrices**: 2026-03-02

---

## Authority

This document is the single source of truth for all CLEO operations. Both MCP gateway registries and CLI command registrations MUST match this reference.

Implementation source files:
- MCP Query: `src/mcp/gateways/query.ts`
- MCP Mutate: `src/mcp/gateways/mutate.ts`
- CLI: `src/cli/index.ts` + `src/cli/commands/*.ts`
- Core: `src/core/` + `src/dispatch/engines/`

## Operation Counts

| Gateway | Operations | Domains |
|---------|-----------|---------|
| cleo_query | 105 | 10 |
| cleo_mutate | 83 | 10 |
| **Total** | **188** | **10** |

Canonical domains: tasks, session, orchestrate, memory, check, pipeline, admin, tools, nexus, sharing

## Legacy Aliases

The following legacy domain names are supported for backward compatibility. The dispatch adapter resolves them to canonical domains at routing time:

| Legacy Domain | Canonical Domain | Notes |
|---------------|-----------------|-------|
| `research` | `memory` | 8 query ops, 4 mutate ops (subset of memory) |
| `lifecycle` | `pipeline` | 5 query ops, 5 mutate ops (without stage.* prefix) |
| `validate` | `check` | 10 query ops, 2 mutate ops (same as check) |
| `release` | `pipeline` | 0 query ops, 7 mutate ops (without release.* prefix) |
| `system` | `admin` | 11 query ops, 10 mutate ops (subset of admin) |
| `issues` | `tools` | 1 query op, 6 mutate ops (without issue.* prefix) |
| `skills` | `tools` | 6 query ops, 6 mutate ops (without skill.* prefix) |
| `providers` | `tools` | 3 query ops, 1 mutate op (without provider.* prefix) |

## Naming Conventions (T4732)

- All operations use **dot.notation** for multi-word names
- CRUD verbs: `add` (create), `show` (read), `update`, `delete`
- Task work: `start` (begin), `stop` (end), `current` (show active)
- Standard verbs: `list`, `find`, `validate`, `record`, `restore`

---

## Domain: tasks

The core task management domain. Handles CRUD, hierarchy, dependencies, focus, and analysis.

### Query Operations (13)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `show` | `cleo show <id>` | Get single task details | `taskId` |
| `list` | `cleo list` | List tasks with filters | `parent?`, `status?`, `limit?` |
| `find` | `cleo find <query>` | Fuzzy search tasks | `query`, `limit?` |
| `exists` | `cleo exists <id>` | Check task existence | `taskId` |
| `tree` | `cleo tree` | Hierarchical task view | `rootId?`, `depth?` |
| `blockers` | `cleo blockers <id>` | Get blocking tasks | `taskId` |
| `depends` | `cleo deps <id>` | Get dependencies | `taskId`, `direction?` |
| `analyze` | `cleo analyze` | Triage analysis | `epicId?` |
| `next` | `cleo next` | Next task suggestion | `epicId?`, `count?` |
| `plan` | `cleo plan` | Composite planning view | - |
| `relates` | `cleo relates <id>` | Query task relationships | `taskId` |
| `complexity.estimate` | N/A | Deterministic complexity scoring | `taskId` |
| `current` | `cleo current` | Get currently active task | - |

### Mutate Operations (13)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `add` | `cleo add <title>` | Create new task | `title`, `description`, `parent?`, `priority?`, `labels?`, `depends?` |
| `update` | `cleo update <id>` | Update task fields | `taskId`, `title?`, `status?`, `priority?`, `notes?` |
| `complete` | `cleo complete <id>` | Mark task done | `taskId`, `notes?` |
| `delete` | `cleo delete <id>` | Delete task | `taskId`, `force?`, `reason?` |
| `archive` | `cleo archive` | Archive done tasks | `taskId?`, `before?` |
| `restore` | `cleo restore <id>` | Restore from archive | `taskId` |
| `reparent` | `cleo reparent <id> --to <parent>` | Change task parent | `taskId`, `newParent` |
| `promote` | `cleo promote <id>` | Promote subtask to task | `taskId` |
| `reorder` | `cleo reorder <id>` | Reorder siblings | `taskId`, `position` |
| `reopen` | N/A | Alias for restore (completed tasks) | `taskId` |
| `relates.add` | `cleo relates <id> --add <other>` | Add task relationship | `taskId`, `targetId`, `type` |
| `start` | `cleo start <id>` | Start working on task | `taskId` |
| `stop` | `cleo stop` | Stop working on task | - |

---

## Domain: session

Work session lifecycle and decision tracking.

### Query Operations (11)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `status` | `cleo session status` | Current session status | - |
| `list` | `cleo session list` | List all sessions | `active?` |
| `show` | `cleo session show <id>` | Session details | `sessionId` |
| `find` | `cleo session find` | Lightweight session discovery | `query?`, `status?` |
| `history` | `cleo session history` | Session history | `limit?` |
| `decision.log` | N/A | Decision audit log | `sessionId?` |
| `context.drift` | N/A | Session context drift analysis | `sessionId?` |
| `handoff.show` | `cleo session handoff` | Show handoff data | `scope?` |
| `briefing.show` | `cleo briefing` | Composite session-start context | `scope?`, `maxNext?` |
| `debrief.show` | N/A | Rich debrief data | `sessionId?` |
| `chain.show` | N/A | Session chain linked via previous/next | `sessionId?` |

### Mutate Operations (7)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `start` | `cleo session start` | Start new session | `scope`, `name?` |
| `end` | `cleo session end` | End current session | `notes?` |
| `resume` | `cleo session resume <id>` | Resume existing session | `sessionId` |
| `suspend` | `cleo session suspend` | Suspend session | `notes?` |
| `gc` | `cleo session gc` | Garbage collect sessions | `olderThan?` |
| `record.decision` | N/A | Record a decision | `sessionId`, `taskId`, `decision`, `rationale` |
| `record.assumption` | N/A | Record an assumption | `assumption`, `confidence` |

---

## Domain: orchestrate

Multi-agent coordination and parallel execution.

### Query Operations (9)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `status` | `cleo orchestrate status` | Orchestrator status | `epicId` |
| `next` | `cleo orchestrate next` | Next task to spawn | `epicId` |
| `ready` | `cleo orchestrate ready` | Parallel-safe tasks | `epicId` |
| `analyze` | `cleo orchestrate analyze` | Dependency analysis | `epicId` |
| `context` | `cleo context` | Context usage check | `tokens?` |
| `waves` | `cleo orchestrate waves` | Wave computation | `epicId` |
| `bootstrap` | N/A | Brain state bootstrap | `epicId?` |
| `unblock.opportunities` | N/A | Unblocking opportunities analysis | `epicId?` |
| `critical.path` | N/A | Longest dependency chain analysis | `epicId` |

### Mutate Operations (5)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `start` | `cleo orchestrate start` | Initialize orchestration | `epicId` |
| `spawn` | `cleo orchestrate spawn` | Generate spawn prompt | `taskId`, `skill?` |
| `validate` | `cleo orchestrate validate` | Validate spawn readiness | `taskId` |
| `parallel.start` | N/A | Start parallel wave | `epicId`, `wave` |
| `parallel.end` | N/A | End parallel wave | `epicId`, `wave` |

---

## Domain: memory

Research protocol management, manifest operations, and native BRAIN memory system.

### Query Operations (15)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `show` | `cleo research show <id>` | Research entry details | `researchId` |
| `list` | `cleo research list` | List research entries | `epicId?`, `status?` |
| `find` | `cleo research find` | Find research | `query` |
| `pending` | `cleo research pending` | Pending research | `epicId?` |
| `stats` | `cleo research stats` | Research statistics | `epicId?` |
| `manifest.read` | N/A | Read manifest entries | `filter?`, `limit?` |
| `contradictions` | N/A | Find conflicting research findings | `epicId?` |
| `superseded` | N/A | Find superseded research entries | `epicId?` |
| `pattern.search` | N/A | Search BRAIN pattern memory | `query` |
| `pattern.stats` | N/A | Pattern memory statistics | - |
| `learning.search` | N/A | Search BRAIN learning memory | `query` |
| `learning.stats` | N/A | Learning memory statistics | - |
| `brain.search` | N/A | 3-layer retrieval step 1: search index | `query`, `limit?`, `tables?`, `dateStart?`, `dateEnd?` |
| `brain.timeline` | N/A | 3-layer retrieval step 2: context around anchor | `anchor`, `depthBefore?`, `depthAfter?` |
| `brain.fetch` | N/A | 3-layer retrieval step 3: full details for filtered IDs | `ids` (string[]) |

### Mutate Operations (7)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `inject` | `cleo research inject` | Get protocol injection | `protocolType`, `taskId?` |
| `link` | `cleo research link` | Link research to task | `researchId`, `taskId` |
| `manifest.append` | N/A | Append manifest entry | `entry` |
| `manifest.archive` | N/A | Archive old entries | `beforeDate?` |
| `pattern.store` | N/A | Store BRAIN pattern memory | `pattern`, `context?` |
| `learning.store` | N/A | Store BRAIN learning memory | `learning`, `context?` |
| `brain.observe` | N/A | Save observation to brain.db | `text`, `title?`, `type?`, `project?`, `sourceSessionId?`, `sourceType?` |

**Token budget for BRAIN operations**:
- `brain.search`: ~50 tokens per result (returns `{results: [{id, type, title, date, relevance}], total, tokensEstimated}`)
- `brain.timeline`: ~200-500 tokens (returns `{anchor: {id, type, data}, before: [...], after: [...]}`)
- `brain.fetch`: ~500 tokens per entry (returns `{results: [{id, type, data}], notFound: string[], tokensEstimated}`)
- `brain.observe`: returns `{id, type, createdAt}` -- content hash dedup prevents duplicates within 30-second window

**3-layer retrieval pattern**: Search first (cheap) -> filter interesting IDs -> fetch only what you need.

---

## Domain: check

Validation, compliance, and quality checks.

### Query Operations (10)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `schema` | `cleo validate` | JSON Schema validation | `fileType`, `filePath?` |
| `protocol` | `cleo compliance` | Protocol compliance | `taskId`, `protocolType` |
| `task` | N/A | Anti-hallucination check | `taskId`, `checkMode` |
| `manifest` | N/A | Manifest entry check | `entry` or `taskId` |
| `output` | N/A | Output file validation | `taskId`, `filePath` |
| `compliance.summary` | `cleo compliance summary` | Aggregated compliance | `scope?`, `since?` |
| `compliance.violations` | `cleo compliance violations` | List violations | `severity?` |
| `test.status` | N/A | Test suite status | `taskId?` |
| `test.coverage` | N/A | Coverage metrics | `taskId?` |
| `coherence.check` | N/A | Task graph consistency | `scope?` |

### Mutate Operations (2)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `compliance.record` | N/A | Record compliance check | `taskId`, `result` |
| `test.run` | `cleo testing` | Execute test suite | `scope?`, `pattern?` |

---

## Domain: pipeline

RCSD-IVTR lifecycle stage management and release lifecycle.

### Query Operations (5)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `stage.validate` | `cleo lifecycle validate` | Check stage prerequisites | `taskId`, `targetStage` |
| `stage.status` | `cleo lifecycle status` | Current lifecycle state | `taskId` or `epicId` |
| `stage.history` | `cleo lifecycle history` | Stage transition history | `taskId` |
| `stage.gates` | `cleo lifecycle gates` | All gate statuses | `taskId` |
| `stage.prerequisites` | N/A | Required prior stages | `targetStage` |

### Mutate Operations (12)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `stage.record` | `cleo lifecycle record` | Record stage completion | `taskId`, `stage`, `status` |
| `stage.skip` | `cleo lifecycle skip` | Skip optional stage | `taskId`, `stage`, `reason` |
| `stage.reset` | `cleo lifecycle reset` | Reset stage (emergency) | `taskId`, `stage`, `reason` |
| `stage.gate.pass` | `cleo verify --gate <g> --value pass` | Mark gate as passed | `taskId`, `gateName`, `agent` |
| `stage.gate.fail` | `cleo verify --gate <g> --value fail` | Mark gate as failed | `taskId`, `gateName`, `reason` |
| `release.prepare` | `cleo release prepare` | Prepare release | `version`, `type` |
| `release.changelog` | `cleo release changelog` | Generate changelog | `version` |
| `release.commit` | `cleo release commit` | Create release commit | `version` |
| `release.tag` | `cleo release tag` | Create git tag | `version` |
| `release.push` | `cleo release push` | Push to remote | `version` |
| `release.gates.run` | `cleo release gates` | Run release gates | `gates?` |
| `release.rollback` | `cleo release rollback` | Rollback release | `version`, `reason` |

---

## Domain: admin

System administration, configuration, observability, and ADR management.

### Query Operations (19)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `version` | `cleo --version` | CLEO version | - |
| `health` | `cleo doctor` | Health check | - |
| `doctor` | `cleo doctor` | Comprehensive doctor report | - |
| `config.show` | `cleo config get <key>` | Show config value | `key` |
| `config.get` | `cleo config get <key>` | Alias (backward compat) | `key` |
| `stats` | `cleo stats` | Project statistics | - |
| `context` | `cleo context` | Context window info | - |
| `runtime` | N/A | Runtime environment info | - |
| `job.status` | N/A | Get background job status | `jobId` |
| `job.list` | N/A | List background jobs | `status?` |
| `dash` | `cleo dash` | Project overview dashboard | - |
| `log` | `cleo log` | Audit log entries | `limit?`, `since?` |
| `sequence` | `cleo sequence` | ID sequence inspection | - |
| `help` | N/A | Operation list filtered by disclosure tier | `tier?` |
| `adr.list` | N/A | List architecture decision records | - |
| `adr.show` | N/A | Show single ADR by ID | `adrId` |
| `adr.find` | N/A | Fuzzy search ADRs | `query` |
| `grade` | N/A | Grade agent behavioral session | `sessionId?` |
| `grade.list` | N/A | List past session grade results | - |

### Mutate Operations (14)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `init` | `cleo init` | Initialize CLEO | `projectType?` |
| `fix` | `cleo doctor --fix` | Auto-fix failed doctor checks | - |
| `config.set` | `cleo config set <key> <val>` | Set config value | `key`, `value` |
| `backup` | `cleo backup` | Create backup | `type?`, `note?` |
| `restore` | `cleo restore <id>` | Restore from backup | `backupId` |
| `migrate` | `cleo migrate` | Run migrations | `version?`, `dryRun?` |
| `sync` | `cleo sync` | Sync with TodoWrite | `direction?` |
| `cleanup` | N/A | Cleanup stale data | `type`, `olderThan?` |
| `job.cancel` | N/A | Cancel background job | `jobId` |
| `safestop` | `cleo safestop` | Graceful agent shutdown | `reason?` |
| `inject.generate` | N/A | Generate MVI injection | `level?`, `format?` |
| `sequence` | `cleo sequence --repair` | Repair ID sequence | `action` (repair) |
| `adr.sync` | N/A | Sync ADRs from markdown to DB | - |
| `adr.validate` | N/A | Validate ADR frontmatter | - |

---

## Domain: tools

Skill management, GitHub issue integration, and agent provider management.

### Query Operations (16)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `skill.list` | `cleo skills list` | List available skills | `filter?` |
| `skill.show` | `cleo skills show <id>` | Skill details | `skillId` |
| `skill.find` | `cleo skills find` | Find skills | `query` |
| `skill.dispatch` | N/A | Simulate skill dispatch | `taskId` |
| `skill.verify` | N/A | Validate skill frontmatter | `skillId` |
| `skill.dependencies` | N/A | Skill dependency tree | `skillId` |
| `skill.catalog.protocols` | N/A | List catalog protocols | - |
| `skill.catalog.profiles` | N/A | List catalog profiles | - |
| `skill.catalog.resources` | N/A | List catalog shared resources | - |
| `skill.catalog.info` | N/A | Catalog metadata and availability | - |
| `issue.diagnostics` | `cleo issue diagnostics` | System diagnostics for bug reports | - |
| `issue.templates` | N/A | List/get issue templates | - |
| `issue.validate.labels` | N/A | Validate issue labels | - |
| `provider.list` | N/A | List all registered providers | - |
| `provider.detect` | N/A | Detect installed providers | - |
| `provider.inject.status` | N/A | Check injection status | `providerId?` |

### Mutate Operations (14)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `skill.install` | `cleo skills install` | Install a skill | `name`, `source?` |
| `skill.uninstall` | `cleo skills uninstall` | Uninstall a skill | `name` |
| `skill.enable` | `cleo skills enable` | Enable a skill | `name` |
| `skill.disable` | `cleo skills disable` | Disable a skill | `name` |
| `skill.configure` | `cleo skills configure` | Configure a skill | `name`, `config` |
| `skill.refresh` | `cleo skills refresh` | Refresh skill registry | - |
| `issue.add.bug` | `cleo issue bug` | File a bug report | `title`, `body` |
| `issue.add.feature` | `cleo issue feature` | Request a feature | `title`, `body` |
| `issue.add.help` | `cleo issue help` | Ask a question | `title`, `body` |
| `issue.create.bug` | N/A | Alias (backward compat) | `title`, `body` |
| `issue.create.feature` | N/A | Alias (backward compat) | `title`, `body` |
| `issue.create.help` | N/A | Alias (backward compat) | `title`, `body` |
| `issue.generate.config` | N/A | Generate issue template config | - |
| `provider.inject` | N/A | Inject content into provider instruction files | `providerId`, `content?` |

---

## Domain: nexus

BRAIN Network placeholder (not yet implemented).

### Query Operations (1)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `status` | N/A | Nexus network status (not yet implemented) | - |

### Mutate Operations (1)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `connect` | N/A | Connect to BRAIN network (not yet implemented) | - |

---

## Domain: sharing

Multi-contributor operations for task database sharing and synchronization.

### Query Operations (3)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `status` | N/A | Sharing status | - |
| `remotes` | N/A | List remotes | - |
| `sync.status` | N/A | Sync status | - |

### Mutate Operations (7)

| Operation | CLI Equivalent | Description | Key Params |
|-----------|---------------|-------------|------------|
| `snapshot.export` | N/A | Export snapshot | - |
| `snapshot.import` | N/A | Import snapshot | - |
| `sync.gitignore` | N/A | Sync gitignore | - |
| `remote.add` | N/A | Add remote | `name`, `url` |
| `remote.remove` | N/A | Remove remote | `name` |
| `push` | N/A | Push to remote | `remote?` |
| `pull` | N/A | Pull from remote | `remote?` |

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
admin.dash    admin.health    admin.version    admin.init    admin.safestop
admin.stats    admin.config.show
```

### Level 2: Extended (~2-5K tokens, on-demand)

All domain operations for: check, memory, pipeline, tools, plus remaining tasks/session/admin operations.

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
- Dispatch Engines: `src/dispatch/engines/`
- Deprecated: `docs/commands/COMMANDS-INDEX.json` (replaced by this document)

---

## Changelog

### v1.2.0 (2026-03-02)

- Full refresh against gateway matrices (`query.ts` and `mutate.ts`)
- 188 canonical operations (105 query + 83 mutate) across 10 domains
- Restructured to use canonical domain names throughout (tasks, session, orchestrate, memory, check, pipeline, admin, tools, nexus, sharing)
- Legacy aliases documented in dedicated table with operation count mapping
- Added new operations: session.find, admin.doctor/runtime/help/adr.*/grade/grade.list/fix, memory.pattern.*/learning.*, tools.skill.catalog.*/issue.templates/issue.validate.labels/issue.generate.config
- Removed stale disclaimer about approximate counts
- Removed Disclosure Level column (progressive disclosure is documented separately)

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
