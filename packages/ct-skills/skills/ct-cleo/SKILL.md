---
name: ct-cleo
description: CLEO task management protocol - session, task, and workflow guidance
version: 2.0.0
category: core
tier: 0
protocol: null
tags: [cleo, protocol, mcp, session, task-management]
triggers: [cleo, session, task, start, mcp]
compatibility: [claude-code, gemini-cli, codex-cli]
dependencies: []
sharedResources: [task-system-integration]
license: MIT
---

# CLEO Protocol Guide

CLEO is the task management protocol for AI coding agents. It provides structured task tracking, session management, and multi-agent coordination with anti-hallucination validation.

## MCP-First Workflow

MCP is the **primary** entry point. Use `query` for reads and `mutate` for writes.

### Key Read Operations (`query`)

| Domain | Operation | Description |
|--------|-----------|-------------|
| `tasks` | `show` | Get task details (`params: { taskId }`) |
| `tasks` | `find` | Search tasks (`params: { query }` or `{ id }`) |
| `tasks` | `list` | List tasks (`params: { parent?, status? }`) |
| `session` | `status` | Current session state |
| `session` | `list` | All sessions |
| `orchestrate` | `analyze` | Dependency wave analysis (`params: { epicId }`) |
| `orchestrate` | `ready` | Tasks ready to spawn (`params: { epicId }`) |
| `orchestrate` | `next` | Next task suggestion (`params: { epicId }`) |
| `research` | `list` | Research manifest entries |
| `research` | `show` | Research entry details (`params: { entryId }`) |
| `check` | `schema` | Validate task data schema integrity |
| `system` | `dash` | Project overview dashboard |
| `system` | `context` | Context window usage |
| `skills` | `list` | Available skills |
| `skills` | `show` | Skill details (`params: { name }`) |
| `pipeline` | `stage.status` | Pipeline stage for epic (`params: { epicId }`) |
| `pipeline` | `stage.validate` | Validate gate before advancing (`params: { epicId, stage }`) |
| `sticky` | `list` | List sticky notes (`params: { status?, tag? }`) |
| `sticky` | `show` | Show sticky details (`params: { stickyId }`) |

### Key Write Operations (`mutate`)

| Domain | Operation | Description |
|--------|-----------|-------------|
| `tasks` | `add` | Create task (`params: { title, description?, parent?, depends? }`) |
| `tasks` | `update` | Update task (`params: { taskId, title?, status?, notes? }`) |
| `tasks` | `complete` | Complete task (`params: { taskId }`) |
| `session` | `start` | Start session (`params: { scope, name, autoStart? }`) |
| `session` | `end` | End session (`params: { note? }`) |
| `session` | `resume` | Resume session (`params: { sessionId }`) |
| `tasks` | `start` | Start working on a task (`params: { taskId }`) |
| `research` | `link` | Link research to task (`params: { taskId, entryId }`) |
| `orchestrate` | `spawn` | Generate spawn prompt for subagent (`params: { taskId }`) |
| `pipeline` | `stage.record` | Record pipeline stage progress (`params: { epicId, stage, status }`) |
| `pipeline` | `stage.gate.pass` | Advance pipeline to next stage (`params: { epicId, stage }`) |
| `sticky` | `add` | Create sticky note (`params: { content, tags?, color?, priority? }`) |
| `sticky` | `convert` | Convert to task/memory (`params: { stickyId, targetType }`) |
| `sticky` | `archive` | Archive sticky (`params: { stickyId }`) |

## CLI Fallback

When MCP tools are unavailable, use `ct` (alias for `cleo`).

```bash
ct find "query"            # Search (99% less context than list)
ct find --id 142           # Search by ID
ct show T1234              # Full task details
ct add "Task title"        # Create task
ct complete T1234          # Complete task
ct start T1234             # Start working on task
ct dash                    # Project overview

ct sticky add "Quick note"     # Create sticky note
ct sticky list                 # List active stickies
ct sticky show SN-001          # Show sticky details
```

## Task Discovery (Context Efficiency)

**MUST** use efficient commands -- `find` for discovery, `show` for details:

- `list` includes full notes arrays (huge context cost)
- `find` returns minimal fields only (99% less context)
- Use `show` only when you need full details for a specific task

### Work Selection Decision Tree

```
START
├─ Has active session? → `session status`
│  ├─ YES → Has active task? → `tasks current`
│  │  ├─ YES → Continue working on it
│  │  └─ NO → `tasks next` → pick suggestion → `tasks start {id}`
│  └─ NO → `session list` → resume or start new
│     └─ `session start --scope epic:{id} --auto-focus`
├─ Know what to work on?
│  ├─ YES → `tasks find "query"` → `tasks show {id}` → `tasks start {id}`
│  └─ NO → `admin dash` → identify priority → `tasks next`
└─ Epic-level work?
   └─ `tasks tree {epicId}` → find actionable leaf → `tasks start {id}`
```

### Context Bloat Anti-Patterns

| Anti-Pattern | Token Cost | Efficient Alternative | Savings |
|-------------|-----------|----------------------|---------|
| `tasks list` (no filters) | 2000-5000 | `tasks find "query"` | 80-90% |
| `admin help --tier 2` first | 2000+ | `admin help` (tier 0 default) | 60-75% |
| `tasks show` for every task | 400 x N | `tasks find` then `show` for 1-2 | 70-90% |
| Reading full epic tree | 1000-3000 | `tasks next` for suggestions | 80% |
| Repeated `session list` | 300 x N | Once at startup, cache result | 90% |
| `tasks analyze` before starting | 800-1500 | `tasks next --explain` | 50% |

### Progressive Disclosure Triggers

Load only what you need. Escalate tiers when the task demands it:

**Stay at Tier 0** (default -- 80% of work):
- Single task execution (implement, fix, test)
- Task discovery and status updates
- Session start/end

**Escalate to Tier 1** when:
- Managing research artifacts or consensus docs
- Running validation/compliance checks
- Working with memory or check domains

**Escalate to Tier 2** when:
- Orchestrating multi-agent workflows
- Managing release pipelines
- Working with nexus cross-project operations
- Spawning subagents with protocol injection

## Session Protocol

Sessions track work context across agent interactions.

### Quick Start

```
# 1. CHECK existing sessions first
ct session list
ct session status

# 2. RESUME or START
ct session resume <id>
# OR (only if no suitable session):
ct session start --scope epic:T001 --auto-focus --name "Work"
#                ^^^^^^^^^^^^^^^^^ REQUIRED  ^^^^^^^^^^^^^ REQUIRED

# 3. WORK
ct current / ct next / ct complete T005 / ct start T006

# 4. END (ALWAYS when stopping)
ct complete <id>
ct session end --note "Progress"
```

### MCP Session Operations

```
mutate({ domain: "session", operation: "start",
  params: { scope: "epic:T001", name: "Work", autoStart: true }})
query({ domain: "session", operation: "status" })
mutate({ domain: "session", operation: "end", params: { note: "Progress" }})
```

## Error Handling

**CRITICAL: NEVER ignore exit codes. Failed commands = tasks NOT created/updated.**

After EVERY command:
1. Exit code `0` = success, `1-22` = error, `100+` = special (not error)
2. JSON `"success": false` = operation failed
3. Execute `error.fix` -- copy-paste-ready fix command

| Exit | Code | Fix |
|:----:|------|-----|
| 4 | `E_NOT_FOUND` | Use `ct find` or `ct list` to verify |
| 6 | `E_VALIDATION_*` | Check field lengths, escape `$` as `\$` |
| 10 | `E_PARENT_NOT_FOUND` | Verify with `ct exists <parent-id>` |
| 11 | `E_DEPTH_EXCEEDED` | Max depth 3 (epic->task->subtask) |
| 12 | `E_SIBLING_LIMIT` | Max 7 siblings per parent |

## RCSD-IVTR Lifecycle (LOOM)

**LOOM** (Logical Order of Operations Methodology) is the systematic framework for how CLEO processes project threads through the RCASD-IVTR+C pipeline. See `docs/concepts/CLEO-VISION.md` for the complete LOOM framework, neural hierarchy model, and brain metaphor mapping.

**Lifecycle**: See CLEO-INJECTION.md standard tier for full RCASD-IVTR+C pipeline details, or `references/loom-lifecycle.md` for gate enforcement and subagent architecture.

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

## Time Estimates Prohibited

- **MUST NOT** estimate hours, days, weeks, or temporal duration
- **MUST** use relative sizing: `small` / `medium` / `large`
- **SHOULD** describe scope, complexity, dependencies when asked

## References

For detailed guidance on specific topics, see:

- **Session Protocol**: `references/session-protocol.md`
- **LOOM Lifecycle**: `references/loom-lifecycle.md`
- **Anti-Patterns**: `references/anti-patterns.md`
