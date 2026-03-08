---
name: ct-cleo
description: CLEO task management protocol - session, task, and workflow guidance. Use when managing tasks, sessions, or multi-agent workflows with the CLEO MCP protocol.
---

# CLEO Protocol Guide

CLEO is the task management protocol for AI coding agents. It provides structured task tracking, session management, and multi-agent coordination with anti-hallucination validation.

**Operation set**: 164 operations (97 query + 67 mutate) across 10 canonical domains.

## MCP-First Workflow

MCP is the **primary** entry point. Use `query` for reads and `mutate` for writes.

### Tier-0 Read Operations (`query`) — Always Available

| Domain | Operation | Description |
|--------|-----------|-------------|
| `tasks` | `show` | Get task details (`params: { taskId }`) |
| `tasks` | `find` | Search tasks (`params: { query }` or `{ id }`) |
| `tasks` | `next` | Auto-select highest-priority next task |
| `tasks` | `plan` | Composite planning view: upcoming tasks, blockers, dependencies |
| `tasks` | `current` | Show currently active (started) task |
| `session` | `status` | Current session state — **mandatory first call** |
| `session` | `handoff.show` | Resume prior context from last session |
| `session` | `briefing.show` | Composite cold-start briefing (status + handoff combined) |
| `memory` | `find` | Search brain for past observations, decisions, patterns (`params: { query }`) |
| `admin` | `version` | CLEO version number |
| `admin` | `health` | Installation health check |
| `admin` | `dash` | Project dashboard — mandatory efficiency sequence step 2 |
| `admin` | `help` | Discover available operations; use `{tier:2}` to reveal advanced ops |
| `tools` | `skill.list` | List all installed agent skills |
| `tools` | `provider.list` | List all known LLM/agent providers |
| `tools` | `provider.detect` | Detect currently active provider |

### Tier-1 Read Operations (`query`) — After Session Init

| Domain | Operation | Description |
|--------|-----------|-------------|
| `tasks` | `list` | List direct children (`params: { parentId }`) — **requires parentId filter; prefer tasks.find for discovery** |
| `tasks` | `tree` | Full subtask hierarchy (`params: { taskId }`) |
| `tasks` | `analyze` | Leverage-sorted task discovery |
| `tasks` | `blockers` | Tasks blocking a specific task (`params: { taskId }`) |
| `tasks` | `depends` | Full dependency graph for a task (`params: { taskId }`) |
| `session` | `list` | List sessions (prefer `session.find` for discovery) |
| `session` | `decision.log` | Recorded decisions for the current session |
| `session` | `find` | Search sessions (`params: { query }`) |
| `session` | `show` | Full session record (`params: { sessionId }`) |
| `session` | `context.drift` | Inspect context drift during long sessions |
| `memory` | `timeline` | Context around an anchor entry (`params: { anchorId }`) |
| `memory` | `fetch` | Batch-fetch brain entries (`params: { ids: [...] }`) |
| `memory` | `decision.find` | Search stored decisions (`params: { query, taskId? }`) |
| `memory` | `pattern.find` | Search stored patterns (`params: { query, type? }`) |
| `memory` | `learning.find` | Search stored learnings (`params: { query, minConfidence? }`) |
| `orchestrate` | `analyze` | Dependency wave analysis (`params: { epicId }`) |
| `orchestrate` | `ready` | Tasks ready to spawn (`params: { epicId }`) |
| `orchestrate` | `next` | Next task suggestion (`params: { epicId }`) |
| `orchestrate` | `status` | Current orchestration state |
| `check` | `schema` | Validate task data schema integrity |
| `check` | `protocol` | Protocol compliance for a task (`params: { taskId, protocolType? }`) |
| `check` | `task` | Validate task fields (`params: { taskId }`) |
| `check` | `compliance.summary` | Overall compliance summary |
| `check` | `test` | Test status or coverage (`params: { format: "status" | "coverage" }`) |
| `check` | `gate.status` | Lifecycle gate status |
| `pipeline` | `stage.status` | Pipeline stage for epic (`params: { epicId }`) |
| `pipeline` | `stage.validate` | Validate gate before advancing |
| `pipeline` | `manifest.show` | Read manifest entry (`params: { id }`) |
| `pipeline` | `manifest.list` | List manifest entries (`params: { filter?: "pending" }`) |
| `pipeline` | `manifest.find` | Search manifest entries (`params: { query }`) |
| `nexus` | `status` | Check if nexus is initialized |
| `nexus` | `list` | List registered projects |
| `admin` | `config.show` | Inspect current configuration |
| `admin` | `adr.find` | Search architecture decision records |
| `tools` | `skill.show` | Skill details (`params: { skillId }`) |
| `sticky` | `list` | List sticky notes (`params: { status?, tag? }`) |
| `sticky` | `show` | Show sticky details (`params: { stickyId }`) |

### Tier-0 Write Operations (`mutate`) — Always Available

| Domain | Operation | Description |
|--------|-----------|-------------|
| `tasks` | `add` | Create task (`params: { title, description, parentId?, status? }`) |
| `tasks` | `update` | Update task (`params: { taskId, title?, status?, notes? }`) |
| `tasks` | `complete` | Mark task done (`params: { taskId }`) |
| `tasks` | `start` | Start working on a task (`params: { taskId }`) |
| `tasks` | `stop` | Stop working on current task |
| `session` | `start` | Start session (`params: { scope }`) — scope is **required** |
| `session` | `end` | End session (`params: { note? }`) |
| `memory` | `observe` | Save observation to brain (`params: { text, title? }`) |

### Tier-1 Write Operations (`mutate`) — After Session Init

| Domain | Operation | Description |
|--------|-----------|-------------|
| `tasks` | `cancel` | Cancel task (`params: { taskId }`) |
| `tasks` | `archive` | Archive completed task (`params: { taskId }`) |
| `tasks` | `restore` | Restore from done/archive (`params: { taskId, from: "done" \| "archive" }`) |
| `tasks` | `delete` | Hard delete — irreversible (`params: { taskId }`) |
| `tasks` | `reparent` | Move to different parent (`params: { taskId, newParentId }`) |
| `tasks` | `reorder` | Reorder tasks within their parent (`params: { taskId, position }`) |
| `session` | `resume` | Resume a prior session (`params: { sessionId }`) |
| `session` | `suspend` | Pause session without ending it |
| `session` | `record.decision` | Record a session decision (`params: { text, rationale }`) |
| `session` | `record.assumption` | Record a session assumption (`params: { text }`) |
| `admin` | `context.inject` | Inject protocol content into context (`params: { protocolType }`) — **moved from session domain** |
| `memory` | `link` | Link memory entry to task (`params: { memoryId, taskId }`) |
| `memory` | `decision.store` | Store structured decision (`params: { decision, rationale, taskId, alternatives? }`) |
| `memory` | `pattern.store` | Store recurring pattern (`params: { name, type, impact, success, antiPattern? }`) |
| `memory` | `learning.store` | Store a learning (`params: { text, confidence, taskId? }`) |
| `orchestrate` | `start` | Start orchestrating an epic (`params: { epicId }`) |
| `orchestrate` | `spawn` | Spawn prep for a task (`params: { taskId, skillIds? }`) |
| `orchestrate` | `spawn.execute` | Execute spawn via adapter registry (`params: { taskId }`) |
| `orchestrate` | `handoff` | Hand off context to subagent (`params: { taskId, context }`) |
| `orchestrate` | `validate` | Pre-spawn gate check (`params: { taskId }`) |
| `orchestrate` | `parallel` | Run parallel agent wave (`params: { action: "start" \| "end", waveId? }`) |
| `check` | `test.run` | Run tests |
| `check` | `gate.set` | Set or reset a lifecycle gate |
| `pipeline` | `stage.record` | Record pipeline stage progress |
| `pipeline` | `stage.gate.pass` | Pass a pipeline gate (`params: { stageId, gateId }`) |
| `pipeline` | `stage.gate.fail` | Fail a gate with reason (`params: { stageId, gateId, reason }`) |
| `pipeline` | `manifest.append` | Append manifest entry (`params: { entry }`) — **MANDATORY per BASE protocol** |
| `pipeline` | `phase.set` | Set pipeline phase (`params: { phaseId, action: "start" \| "complete" }`) |
| `pipeline` | `release.ship` | Ship a release (`params: { step? }`) |
| `admin` | `config.set` | Update configuration (`params: { key, value }`) |
| `tools` | `skill.install` | Install a skill (`params: { skillId }`) |
| `tools` | `skill.uninstall` | Uninstall a skill (`params: { skillId }`) |
| `tools` | `skill.refresh` | Bulk update all installed skills |
| `sticky` | `add` | Create sticky note (`params: { content, tags?, color?, priority? }`) |
| `sticky` | `convert` | Convert to task/memory (`params: { stickyId, targetType }`) |
| `sticky` | `archive` | Archive sticky (`params: { stickyId }`) |
| `sticky` | `purge` | Permanently delete sticky notes (`params: { stickyId }`) |

---

## Canonical Decision Tree

Every agent MUST use this tree to select the minimum-cost operation path.

### Entry Point: Session Start (MANDATORY)

```
Agent starts work
│
├── STEP 1: query session.status
│   ├── Active session exists
│   │   └── query session.handoff.show  → resume prior context, then STEP 2
│   └── No active session
│       └── mutate session.start {scope: "task:TXXX" | "epic:TXXX"}
│
├── STEP 2: query admin.dash  → project overview, active epic, blockers
│
├── STEP 3: query tasks.current  → is a task already in progress?
│   ├── Yes → continue that task (skip STEP 4)
│   └── No → STEP 4
│
└── STEP 4: query tasks.next  → what to work on next
    └── query tasks.show {taskId}  → full task requirements
```

**Anti-pattern blocked**: Never skip `session.status`. Resuming without `handoff.show` loses prior context and causes duplicate work.

---

### Goal: Discover Work

```
I need to find what to work on
│
├── What should I do next (auto-selected)?
│   └── query tasks.next  [tier 0]
│       └── query tasks.show {taskId}  [tier 0]  → full details
│
├── I know keywords — search for a specific task
│   └── query tasks.find {query: "..."}  [tier 0]
│       ├── Found one match → query tasks.show {taskId}
│       └── Need to browse children of a known parent
│           └── query tasks.list {parentId: "TXXX"}  [tier 1]  ← ONLY with parentId filter
│               ANTI-PATTERN: tasks.list with no parentId = full dump, never do this
│
├── I need a prioritized planning view (upcoming tasks, blockers, dependencies)
│   └── query tasks.plan  [tier 0]
│
├── I need the full task hierarchy under a parent
│   └── (discover via tasks.find first, then)
│   └── query tasks.tree {taskId}  [tier 1]  → subtask hierarchy
│
├── I need to see what's blocking a task
│   └── query tasks.blockers {taskId}  [tier 1]
│
└── I need leverage-sorted discovery (highest-impact tasks first)
    └── query tasks.analyze  [tier 1]
```

---

### Goal: Memory Operations

```
I need to save or recall information across sessions
│
├── Save an observation right now (free-form)
│   └── mutate memory.observe {text, title?}  [tier 0]
│
├── Search for something I or a prior agent observed
│   └── query memory.find {query: "..."}  [tier 0]  ← ALWAYS start here (cheap)
│       └── Found interesting IDs → query memory.timeline {anchorId}  [tier 1]
│           └── Need full content → query memory.fetch {ids: [...]}  [tier 1]
│       3-LAYER PATTERN: find → timeline → fetch (never skip to fetch directly)
│
├── Save a structured decision (with rationale, alternatives, taskId)
│   └── mutate memory.decision.store {decision, rationale, taskId, alternatives?}  [tier 1]
│       └── Recall: query memory.decision.find {query, taskId?}  [tier 1]
│
└── Associate a memory entry with a task (research linking protocol)
    └── mutate memory.link {memoryId, taskId}  [tier 1]
```

**Anti-pattern blocked**: Never call `memory.fetch` without first calling `memory.find`. Fetching without filtering returns all entries (expensive).

---

### Goal: Multi-Agent Coordination

```
I need to coordinate agent work (orchestrator role)
│
├── I am the orchestrator — start coordinating an epic
│   └── mutate orchestrate.start {epicId}  [tier 1]
│       └── query orchestrate.status  [tier 1]  → current orchestration state
│
├── Spawn a subagent for a task
│   └── (1) mutate orchestrate.validate {taskId}  [tier 1]  → pre-spawn gate check
│       (2) mutate orchestrate.spawn {taskId, skillIds?}  [tier 1]  → spawn prep
│
└── I am a subagent — complete my work and report
    └── mutate pipeline.manifest.append {entry}  [tier 1]  ← MANDATORY per BASE protocol
        mutate tasks.complete {taskId}  [tier 0]
```

**Subagent BASE protocol**: Every subagent MUST append one entry to MANIFEST.jsonl via `pipeline.manifest.append` BEFORE calling `tasks.complete`. Omitting this is a protocol violation (exit code 62).

---

### Goal: Track Session Context

```
I need to manage session lifecycle or read session state
│
├── Check whether a session is active
│   └── query session.status  [tier 0]  ← FIRST, always
│
├── Resume prior context after a restart
│   └── query session.handoff.show  [tier 0]
│
├── Get a composite cold-start briefing (combines status + handoff)
│   └── query session.briefing.show  [tier 0]
│
├── Start a new session
│   └── mutate session.start {scope: "task:TXXX" | "epic:TXXX"}  [tier 0]
│       RULE: scope is required — no unscoped sessions
│
├── End the current session (triggers debrief + handoff generation)
│   └── mutate session.end  [tier 0]
│
└── Browse past sessions
    └── query session.find {query: "..."}  [tier 1]  ← NOT session.list unfiltered
        └── Full session record: query session.show {sessionId}  [tier 1]
```

---

### Goal: Discover Available Skills

```
I need to know what skills or providers are available
│
├── List all installed skills (cold-start safe)
│   └── query tools.skill.list  [tier 0]
│       └── Detail on a specific skill: query tools.skill.show {skillId}  [tier 1]
│
└── Detect active provider
    └── query tools.provider.detect  [tier 0]
```

---

### Goal: System Information

```
I need system or configuration info
│
├── What is the overall project state?
│   └── query admin.dash  [tier 0]  ← mandatory efficiency sequence step 2
│
├── What operations are available at this tier?
│   └── query admin.help  [tier 0]  → tier 0 + tier 1 ops
│       └── query admin.help {tier:2}  → reveals tier-2 ops + escalation hints
│
└── Inspect configuration
    └── query admin.config.show  [tier 1]
```

---

## CLI Fallback

When MCP tools are unavailable, use `ct` (alias for `cleo`).

```bash
ct find "query"            # Search (99% less context than list)
ct find --id T1234         # Search by ID
ct show T1234              # Full task details
ct add "Task title"        # Create task
ct complete T1234          # Complete task
ct start T1234             # Start working on task
ct dash                    # Project overview (admin.dash equivalent)

ct sticky add "Quick note"     # Create sticky note
ct sticky list                 # List active stickies
ct sticky show SN-001          # Show sticky details
```

---

## Task Discovery (Context Efficiency)

**MUST** use efficient commands — `find` for discovery, `show` for details:

- `list` includes full notes arrays (huge context cost)
- `find` returns minimal fields only (99% less context)
- Use `show` only when you need full details for a specific task

### Context Bloat Anti-Patterns

| Anti-Pattern | Token Cost | Efficient Alternative | Savings |
|-------------|-----------|----------------------|---------|
| `tasks.list` (no parentId filter) | 2000-5000 | `tasks.find {query: "..."}` | 80-90% |
| `admin.help {tier:2}` first call | 2000+ | `admin.help` (tier 0 default) | 60-75% |
| `tasks.show` for every task | 400 x N | `tasks.find` then `show` for 1-2 | 70-90% |
| `memory.fetch` without `memory.find` | large | `memory.find` → filter → `memory.fetch` | 80% |
| `session.list` unfiltered | 300 x N | `session.status` first, then `session.find` if needed | 90% |
| Reading full epic tree | 1000-3000 | `tasks.next` for suggestions | 80% |

---

## Anti-Pattern Reference

| Bad Pattern | Correct Pattern | Why |
|-------------|----------------|-----|
| `research.list` | `pipeline.manifest.list` | research domain is defunct |
| `research.show` | `pipeline.manifest.show` | research domain is defunct |
| `research.link` / `cleo research link` | `memory.link` (MCP) | research domain is defunct |
| `system.dash` | `admin.dash` | system domain is defunct |
| `system.context` | `admin.context` | system domain is defunct |
| `skills.list` | `tools.skill.list` | skills domain is defunct |
| `skills.show` | `tools.skill.show` | skills domain is defunct |
| `tasks.list` (no filter) | `tasks.find {query: "..."}` | list returns ALL tasks + notes |
| `tasks.reopen` | `tasks.restore {from: "done"}` | reopen is deprecated verb |
| `tasks.unarchive` | `tasks.restore {from: "archive"}` | unarchive is deprecated verb |
| `tasks.promote` | `tasks.reparent {newParentId: null}` | promote is deprecated verb |
| `memory.brain.search` | `memory.find` | old operation name (cutover T5241) |
| `memory.brain.observe` | `memory.observe` | old operation name (cutover T5241) |
| `session.context.inject` | `admin.context.inject` | operation moved domains (reads filesystem, is an admin/bootstrap op) |
| `memory.fetch` without `memory.find` | `memory.find` → filter → `memory.fetch` | fetch without filter returns everything |
| Completing task without manifest append | `pipeline.manifest.append` then `tasks.complete` | BASE protocol violation (exit 62) |
| Skipping `session.status` at start | Always check `session.status` first | loses prior context, causes duplicate work |

---

## Progressive Disclosure

Load only what you need. Escalate tiers when the task demands it:

**Stay at Tier 0** (default — 80% of work):
- Single task execution (implement, fix, test)
- Task discovery and status updates
- Session start/end

**Escalate to Tier 1** when:
- Managing pipeline stages or manifest entries
- Running validation/compliance checks
- Working with memory (timeline, fetch, decisions, patterns)
- Orchestrating multi-agent workflows

**Escalate to Tier 2** when (via `admin.help {tier:2}` first):
- WarpChain pipeline operations (`pipeline.chain.*`)
- Behavioral grading (`check.grade`)
- Cross-project nexus deep queries (`nexus.resolve`, `nexus.graph`)
- Data export/import (`admin.export`, `admin.import`)

---

## Session Protocol

Sessions track work context across agent interactions.

### Quick Start

```bash
# 1. CHECK session state first (always)
ct session status

# 2. RESUME or START
ct session resume <id>
# OR (only if no suitable session):
ct session start --scope epic:T001

# 3. WORK
ct current / ct next / ct complete T005 / ct start T006

# 4. END (ALWAYS when stopping)
ct complete <id>
ct session end
```

### MCP Session Operations

```javascript
query({ domain: "session", operation: "status" })
query({ domain: "session", operation: "handoff.show" })
mutate({ domain: "session", operation: "start", params: { scope: "epic:T001" }})
mutate({ domain: "session", operation: "end", params: { note: "Progress" }})
```

---

## Error Handling

**CRITICAL: NEVER ignore exit codes. Failed commands = tasks NOT created/updated.**

After EVERY command:
1. Exit code `0` = success, `1-22` = error, `100+` = special (not error)
2. JSON `"success": false` = operation failed
3. Execute `error.fix` — copy-paste-ready fix command

| Exit | Code | Fix |
|:----:|------|-----|
| 4 | `E_NOT_FOUND` | Use `ct find` to verify |
| 6 | `E_VALIDATION_*` | Check field lengths, escape `$` as `\$` |
| 10 | `E_PARENT_NOT_FOUND` | Verify with `ct find <parent-id>` |
| 11 | `E_DEPTH_EXCEEDED` | Max depth 3 (epic->task->subtask) |
| 12 | `E_SIBLING_LIMIT` | Max 7 siblings per parent |
| 62 | `MANIFEST_ENTRY_MISSING` | Subagent must call `pipeline.manifest.append` before `tasks.complete` |

---

## RCSD-IVTR Lifecycle (LOOM)

**LOOM** (Logical Order of Operations Methodology) is the systematic framework for how CLEO processes project threads through the RCASD-IVTR+C pipeline. See `docs/concepts/CLEO-VISION.md` for the complete LOOM framework.

**Lifecycle**: See `references/loom-lifecycle.md` for gate enforcement and subagent architecture.

## Pipeline Awareness

Epics follow the RCASD-IVTR+C lifecycle managed through pipeline stages. Use `pipeline.stage.status` to check where an epic is in its lifecycle:

| Stage | Purpose |
|-------|---------|
| `research` | Information gathering and analysis |
| `consensus` | Validate claims and decisions |
| `architecture_decision` | ADR and specification |
| `specification` | Formal requirements |
| `decomposition` | Task breakdown |
| `implementation` | Build functionality |
| `validation` | Verify against criteria |
| `testing` | Test coverage |
| `release` | Version and publish |
| `contribution` | Multi-agent consensus tracking |

---

## Time Estimates Prohibited

- **MUST NOT** estimate hours, days, weeks, or temporal duration
- **MUST** use relative sizing: `small` / `medium` / `large`
- **SHOULD** describe scope, complexity, dependencies when asked

---

## References

For detailed guidance on specific topics, see:

- **Session Protocol**: `references/session-protocol.md`
- **LOOM Lifecycle**: `references/loom-lifecycle.md`
- **Anti-Patterns**: `references/anti-patterns.md`
- **Operation Constitution**: `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
- **Verb Standards**: `docs/specs/VERB-STANDARDS.md`
- **Decision Tree source**: `.cleo/agent-outputs/T5610-decision-tree.md`
