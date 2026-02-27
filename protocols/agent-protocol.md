---
id: AGENT
title: Agent Protocol
version: 1.0.0
status: active
type: base
audience: [llm-agent, orchestrator]
tags: [agent, multi-agent, coordination]
skillRef: ct-orchestrator
lastUpdated: 2026-02-24
enforcement: strict
---

# CLEO Agent Protocol

**Version**: 1.0.0
**Type**: Agent Reference
**Audience**: LLM agents operating CLEO CLI

---

## Commands

| Command | Purpose | Output Key |
|---------|---------|------------|
| ct find "query" | Search tasks | .tasks[].id |
| ct find --id 142 | ID search | .tasks[].id |
| ct show T### | Task details | .task |
| ct add "Title" | Create task | .task.id |
| ct add "Title" --parent T### | Create subtask | .task.id |
| ct done T### | Complete task | .completedAt |
| ct update T### --status active | Update status | .task |
| ct start T### | Set active task | .task |
| ct current | Current active task | .task |
| ct next | Suggest task | .recommendation.taskId |
| ct session list | List sessions | .sessions[] |
| ct session start --scope epic:T### --auto-focus --name "..." | Start session | .session.id |
| ct session end --note "..." | End session | .session |
| ct session resume ID | Resume session | .session |
| ct session status | Current session | .session |
| ct dash | Project overview | .summary |
| ct context | Context usage | .context |
| ct archive | Archive done tasks | .archived[] |
| ct exists T### | Check existence | .exists |
| ct list --parent T### | Children only | .tasks[] |

## Session Sequence

1. `ct session list` - Check existing sessions
2. `ct session start --scope epic:T### --auto-focus --name "Name"` OR `ct session resume ID`
3. `ct start T###` - Set working task
4. Execute work on active task
5. `ct complete T###` - Mark done
6. `ct start T###` - Next task (or `ct next`)
7. `ct archive` - Clean up done tasks
8. `ct session end --note "Progress summary"` - ALWAYS end

**CRITICAL**: Session start requires BOTH `--scope` AND `--auto-focus` (or `--focus T###`)

## Exit Codes

### General (0-8)

| Code | Constant | Recoverable | Recovery |
|------|----------|:-----------:|----------|
| 0 | SUCCESS | - | - |
| 1 | GENERAL_ERROR | Yes | Check error.message |
| 2 | INVALID_INPUT | Yes | Fix arguments |
| 3 | FILE_ERROR | No | Check permissions |
| 4 | NOT_FOUND | Yes | `ct find` to locate ID |
| 5 | DEPENDENCY_ERROR | No | Install missing tool |
| 6 | VALIDATION_ERROR | Yes | Check field lengths, escape \$ |
| 7 | LOCK_TIMEOUT | Yes | Retry after delay |
| 8 | CONFIG_ERROR | Yes | `ct doctor` to diagnose |

### Hierarchy (10-19)

| Code | Constant | Recoverable | Recovery |
|------|----------|:-----------:|----------|
| 10 | PARENT_NOT_FOUND | Yes | `ct exists <parentId>` first |
| 11 | DEPTH_EXCEEDED | Yes | Max 3 levels (epic->task->subtask) |
| 12 | SIBLING_LIMIT | Yes | Check parent children count |
| 13 | INVALID_PARENT_TYPE | Yes | Subtasks cannot have children |
| 14 | CIRCULAR_REFERENCE | No | Check dependency graph |
| 15 | ORPHAN_DETECTED | Yes | Verify parent exists |
| 16 | HAS_CHILDREN | Yes | Delete children first or use --cascade |
| 17 | TASK_COMPLETED | Yes | Use `ct archive` instead |
| 18 | CASCADE_FAILED | No | Manual intervention required |
| 19 | HAS_DEPENDENTS | Yes | Use --orphan flag |

### Concurrency (20-22)

| Code | Constant | Recoverable | Recovery |
|------|----------|:-----------:|----------|
| 20 | CHECKSUM_MISMATCH | Yes | Retry (file changed externally) |
| 21 | CONCURRENT_MODIFICATION | Yes | Retry after delay |
| 22 | ID_COLLISION | Yes | Retry (regenerates ID) |

### Session (30-39)

| Code | Constant | Recoverable | Recovery |
|------|----------|:-----------:|----------|
| 30 | SESSION_EXISTS | Yes | `ct session list`, resume existing |
| 31 | SESSION_NOT_FOUND | Yes | `ct session list` for valid IDs |
| 32 | SCOPE_CONFLICT | Yes | End conflicting session first |
| 33 | SCOPE_INVALID | Yes | Verify epic exists |
| 34 | TASK_NOT_IN_SCOPE | Yes | End session, restart with correct scope |
| 35 | TASK_CLAIMED | Yes | `ct next` for unclaimed task |
| 36 | SESSION_REQUIRED | Yes | `ct session start` first |
| 37 | SESSION_CLOSE_BLOCKED | No | Complete pending tasks first |
| 38 | ACTIVE_TASK_REQUIRED | Yes | `ct start T###` |
| 39 | NOTES_REQUIRED | Yes | Add `--note "..."` |

### Verification (40-47)

| Code | Constant | Recoverable | Recovery |
|------|----------|:-----------:|----------|
| 40 | VERIFICATION_INIT_FAILED | Yes | Check task state |
| 41 | GATE_UPDATE_FAILED | Yes | Retry |
| 42 | INVALID_GATE | Yes | Check valid gate names |
| 43 | INVALID_AGENT | Yes | Check valid agent names |
| 44 | MAX_ROUNDS_EXCEEDED | Yes | Review implementation |
| 45 | GATE_DEPENDENCY | Yes | Complete prerequisite gate |
| 46 | VERIFICATION_LOCKED | No | Requires manual unlock |
| 47 | ROUND_MISMATCH | Yes | Sync round number |

### Context Safeguard (50-54)

| Code | Constant | Action |
|------|----------|--------|
| 50 | CONTEXT_WARNING | Continue, reduce output |
| 51 | CONTEXT_CAUTION | Prioritize completion |
| 52 | CONTEXT_CRITICAL | Run `ct safestop` |
| 53 | CONTEXT_EMERGENCY | Immediate `ct safestop` |
| 54 | CONTEXT_STALE | Re-check context state |

### Protocol/Orchestrator (60-67)

| Code | Constant | Recoverable | Recovery |
|------|----------|:-----------:|----------|
| 60 | PROTOCOL_MISSING | Yes | Add protocol injection block |
| 61 | INVALID_RETURN_MESSAGE | Yes | Fix return format |
| 62 | MANIFEST_ENTRY_MISSING | Yes | Append MANIFEST.jsonl entry |
| 63 | SPAWN_VALIDATION_FAILED | Yes | Fix spawn parameters |
| 64 | AUTONOMOUS_BOUNDARY | No | Requires HITL decision |
| 65 | HANDOFF_REQUIRED | No | Generate handoff document |
| 66 | RESUME_FAILED | Yes | Check session/handoff validity |
| 67 | CONCURRENT_SESSION | Yes | End other session first |

**NOTE**: Codes 60-67 have a known collision between protocol validation (RCSD) and orchestrator functions. They are isolated by usage context.

### Nexus (70-79)

| Code | Constant | Recoverable | Recovery |
|------|----------|:-----------:|----------|
| 70 | NEXUS_NOT_INITIALIZED | Yes | Run nexus init |
| 71 | NEXUS_PROJECT_NOT_FOUND | Yes | Register project first |
| 72 | NEXUS_PERMISSION_DENIED | No | Check permissions |
| 73 | NEXUS_INVALID_SYNTAX | Yes | Fix query syntax |
| 74 | NEXUS_SYNC_FAILED | Yes | Retry sync |
| 75 | NEXUS_REGISTRY_CORRUPT | No | Manual repair needed |
| 76 | NEXUS_PROJECT_EXISTS | Yes | Already registered |
| 77 | NEXUS_QUERY_FAILED | Yes | Retry or refine query |
| 78 | NEXUS_GRAPH_ERROR | Yes | Retry |
| 79 | NEXUS_RESERVED | - | Reserved |

### Lifecycle (80-84)

| Code | Constant | Recoverable | Recovery |
|------|----------|:-----------:|----------|
| 80 | LIFECYCLE_GATE_FAILED | Yes | Complete prerequisite RCSD stages |
| 81 | AUDIT_MISSING | Yes | Add required audit fields |
| 82 | CIRCULAR_VALIDATION | No | Assign different validator |
| 83 | LIFECYCLE_TRANSITION_INVALID | No | Follow RCSD->IVTR sequence |
| 84 | PROVENANCE_REQUIRED | Yes | Add provenance fields |

### Special (100+) - NOT errors

| Code | Constant | Meaning | Agent Action |
|------|----------|---------|-------------|
| 100 | NO_DATA | Query returned empty | Do NOT retry. No matching data. |
| 101 | ALREADY_EXISTS | Resource exists | Treat as success. |
| 102 | NO_CHANGE | No-op (idempotent) | Treat as success. Do NOT retry. |

## Error Recovery Decision Trees

### Exit 34 (TASK_NOT_IN_SCOPE)
```
1. ct session status           -> get current scope
2. ct show T###                -> get task's parent epic
3. ct session end --note "Scope mismatch"
4. ct session start --scope epic:<parentId> --auto-focus --name "Name"
5. RETRY original command
```

### Exit 35 (TASK_CLAIMED)
```
1. ct next                     -> get unclaimed task suggestion
2. ct start <suggested>        -> switch to unclaimed task
```

### Exit 38 (ACTIVE_TASK_REQUIRED)
```
1. ct start T###               -> start working on target task
2. RETRY original command
```

### Exit 100 (NO_DATA) with session start
```
1. ct session list             -> check existing sessions
2. IF sessions exist: ct session resume <id>
3. ELSE: ct session start --scope epic:T### --auto-focus --name "Name"
```

## State Transitions

| From | To | Via Command |
|------|----|-------------|
| pending | active | `ct start T###` |
| pending | blocked | `ct update T### --status blocked` |
| pending | done | `ct complete T###` |
| active | pending | `ct start <other>` (stops current) |
| active | blocked | `ct update T### --status blocked` |
| active | done | `ct complete T###` |
| blocked | pending | `ct update T### --status pending` |
| blocked | active | `ct start T###` |
| done | active | `ct reopen T###` |

Valid statuses: `pending` | `active` | `blocked` | `done`

## JSON Output Format

All commands return:
```json
{"_meta":{"command":"...","timestamp":"...","version":"..."},"success":true,...}
```

Errors return:
```json
{"_meta":{...},"success":false,"error":{"code":"E_...","exitCode":N,"message":"...","fix":"ct ...","alternatives":[{"action":"...","command":"ct ..."}]}}
```

**Parsing patterns**:
- Success check: `jq '.success'`
- Error code: `jq '.error.code'`
- Fix command: `jq -r '.error.fix'`
- Results field: `jq -r '._meta.resultsField'` -> tells which key has primary data

## Constraints

| Rule | Value |
|------|-------|
| Hierarchy depth | Max 3 (epic -> task -> subtask) |
| Siblings per parent | Max configurable (default varies) |
| Valid statuses | pending, active, blocked, done |
| ID format | T### (sequential, immutable) |
| Shell escaping | Escape `$` as `\$` in arguments |
| Context efficiency | Use `find` (not `list`) for discovery |
| Discovery pattern | `find` -> `show` for details |

## Subagent Protocol

1. `ct start T###` - Start task before work
2. Execute implementation work
3. Write output file to designated path
4. Append ONE line to `MANIFEST.jsonl` (compact JSON, no pretty-print)
5. `ct complete T###` - Mark task done
6. Return summary message ONLY (no file content)

**Manifest entry format**:
```json
{"id":"T###-slug","file":"path","title":"...","date":"YYYY-MM-DD","status":"complete","agent_type":"...","topics":[],"key_findings":[],"actionable":true,"needs_followup":[],"linked_tasks":["T###"]}
```
