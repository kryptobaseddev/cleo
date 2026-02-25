# CLEO Agent Protocol

CLEO is the task management protocol for AI coding agents. Structured task tracking, session management, and multi-agent coordination with anti-hallucination validation.

---

## MCP Tools (Primary Interface)

Use `cleo_query` for reads and `cleo_mutate` for writes.

**Domains**: `tasks`, `session`, `orchestrate`, `research`, `validate`, `system`, `skills`

### Common Read Operations (`cleo_query`)

| Domain | Operation | Params |
|--------|-----------|--------|
| `tasks` | `find` | `{ query }` or `{ id }` |
| `tasks` | `show` | `{ taskId }` |
| `tasks` | `list` | `{ parent?, status? }` |
| `session` | `status` | — |
| `system` | `dash` | — |

### Common Write Operations (`cleo_mutate`)

| Domain | Operation | Params |
|--------|-----------|--------|
| `tasks` | `add` | `{ title, description?, parent?, depends? }` |
| `tasks` | `complete` | `{ taskId }` |
| `tasks` | `start` | `{ taskId }` |
| `session` | `start` | `{ scope, name, autoStart? }` |
| `session` | `end` | `{ note? }` |

---

## CLI Fallback

When MCP tools are unavailable, use `ct` (alias for `cleo`):

```bash
ct find "query"            # Search tasks (99% less context than list)
ct show T1234              # Full task details
ct add "Task title"        # Create task
ct done T1234              # Complete task
ct dash                    # Project overview
```

---

## Error Handling

**NEVER ignore exit codes.** Failed commands = tasks NOT created/updated.

- Exit `0` = success, `1-22` = error, `100+` = special
- Check `"success": false` in JSON output
- Execute `error.fix` for copy-paste-ready fixes
- Escape `$` as `\$` in shell arguments

| Exit | Code | Fix |
|:----:|------|-----|
| 4 | `E_NOT_FOUND` | Use `ct find` to verify |
| 6 | `E_VALIDATION` | Check field lengths |
| 10 | `E_PARENT_NOT_FOUND` | Verify parent exists |
| 11 | `E_DEPTH_EXCEEDED` | Exceeds configured hierarchy.maxDepth (default: 3) |
| 12 | `E_SIBLING_LIMIT` | Exceeds configured maxSiblings (default: unlimited) |

---

## Session Quick-Start

```bash
# 1. CHECK first
ct session list

# 2. RESUME or START
ct session resume <id>
# OR:
ct session start --scope epic:T001 --auto-focus --name "Work"

# 3. WORK
ct focus show / ct next / ct complete T005 / ct focus set T006

# 4. END (ALWAYS)
ct session end --note "Progress"
```

---

## Task Discovery

Use `find` for discovery, `show` for details. `list` is expensive (full notes arrays).

```bash
ct find "query"              # Minimal fields
ct show T1234                # Full details
ct list --parent T001        # Direct children only
```

---

## Detailed Guidance

For comprehensive protocol details (session lifecycle, RCSD pipeline, orchestrator constraints, spawn pipeline, anti-patterns), load the **ct-cleo** skill:

```
cleo_query({ domain: "skills", operation: "show", params: { name: "ct-cleo" }})
```

---

## Time Estimates Prohibited

- **MUST NOT** estimate hours, days, weeks, or temporal duration
- **MUST** use relative sizing: `small` / `medium` / `large`
