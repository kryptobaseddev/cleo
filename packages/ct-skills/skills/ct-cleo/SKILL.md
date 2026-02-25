---
name: ct-cleo
description: CLEO task management protocol - session, task, and workflow guidance
version: 2.0.0
category: core
tier: 0
protocol: null
tags: [cleo, protocol, mcp, session, task-management]
triggers: [cleo, session, task, focus, mcp]
compatibility: [claude-code, gemini-cli, codex-cli]
dependencies: []
sharedResources: [task-system-integration]
license: MIT
---

# CLEO Protocol Guide

CLEO is the task management protocol for AI coding agents. It provides structured task tracking, session management, and multi-agent coordination with anti-hallucination validation.

## MCP-First Workflow

MCP is the **primary** entry point. Use `cleo_query` for reads and `cleo_mutate` for writes.

### Key Read Operations (`cleo_query`)

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
| `validate` | `report` | Validate task data integrity |
| `system` | `dash` | Project overview dashboard |
| `system` | `context` | Context window usage |
| `skills` | `list` | Available skills |
| `skills` | `show` | Skill details (`params: { name }`) |

### Key Write Operations (`cleo_mutate`)

| Domain | Operation | Description |
|--------|-----------|-------------|
| `tasks` | `add` | Create task (`params: { title, description?, parent?, depends? }`) |
| `tasks` | `update` | Update task (`params: { taskId, title?, status?, notes? }`) |
| `tasks` | `complete` | Complete task (`params: { taskId }`) |
| `session` | `start` | Start session (`params: { scope, name, autoStart? }`) |
| `session` | `end` | End session (`params: { note? }`) |
| `session` | `resume` | Resume session (`params: { sessionId }`) |
| `tasks` | `start` | Set active focus task (`params: { taskId }`) |
| `research` | `link` | Link research to task (`params: { taskId, entryId }`) |
| `orchestrate` | `spawn` | Generate spawn prompt for subagent (`params: { taskId }`) |

## CLI Fallback

When MCP tools are unavailable, use `ct` (alias for `cleo`).

```bash
ct find "query"            # Search (99% less context than list)
ct find --id 142           # Search by ID
ct show T1234              # Full task details
ct add "Task title"        # Create task
ct complete T1234          # Complete task
ct focus set T1234         # Set active focus
ct dash                    # Project overview
```

## Task Discovery (Context Efficiency)

**MUST** use efficient commands -- `find` for discovery, `show` for details:

- `list` includes full notes arrays (huge context cost)
- `find` returns minimal fields only (99% less context)
- Use `show` only when you need full details for a specific task

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
ct focus show / ct next / ct complete T005 / ct focus set T006

# 4. END (ALWAYS when stopping)
ct complete <id>
ct session end --note "Progress"
```

### MCP Session Operations

```
cleo_mutate({ domain: "session", operation: "start",
  params: { scope: "epic:T001", name: "Work", autoStart: true }})
cleo_query({ domain: "session", operation: "status" })
cleo_mutate({ domain: "session", operation: "end", params: { note: "Progress" }})
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

## RCSD-IVTR Lifecycle

Projects follow a structured lifecycle with gate enforcement:

```
RCSD PIPELINE (setup):  Research -> Consensus -> Specification -> Decomposition
EXECUTION (delivery):   Implementation -> Contribution -> Release
```

Each stage has a lifecycle gate. Entering a later stage requires prior stages to be `completed` or `skipped`. Gate enforcement is configured in `.cleo/config.json` (`strict` | `advisory` | `off`).

### Conditional Protocols (9 Types)

| Protocol | Use Case |
|----------|----------|
| Research | Information gathering |
| Consensus | Multi-agent decisions |
| Specification | Document creation |
| Decomposition | Task breakdown |
| Implementation | Code execution |
| Contribution | Work attribution |
| Release | Version management |
| Artifact Publish | Artifact distribution |
| Provenance | Supply chain integrity |

## Time Estimates Prohibited

- **MUST NOT** estimate hours, days, weeks, or temporal duration
- **MUST** use relative sizing: `small` / `medium` / `large`
- **SHOULD** describe scope, complexity, dependencies when asked

## References

For detailed guidance on specific topics, see:

- **Session Protocol**: `references/session-protocol.md`
- **RCSD Lifecycle**: `references/rcsd-lifecycle.md`
- **Orchestrator Constraints**: `references/orchestrator-constraints.md`
- **Anti-Patterns**: `references/anti-patterns.md`
