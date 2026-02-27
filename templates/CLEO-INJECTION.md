# CLEO Protocol

Use `cleo_query` (reads) and `cleo_mutate` (writes) via MCP. CLI fallback: `ct`.

## Core Operations

| Tool | Domain | Operation | Key Params | Use |
|------|--------|-----------|------------|-----|
| query | `tasks` | `find` | `{ query }` | Search tasks |
| query | `tasks` | `show` | `{ taskId }` | Full task details |
| query | `session` | `status` | — | Current session |
| query | `admin` | `dash` | — | Project overview |
| mutate | `tasks` | `add` | `{ title, description }` | Create task |
| mutate | `tasks` | `complete` | `{ taskId }` | Mark done |
| mutate | `tasks` | `start` | `{ taskId }` | Begin work |
| mutate | `session` | `start` | `{ scope, name, autoStart }` | Start session |
| mutate | `session` | `end` | `{ note? }` | End session |

## CLI Fallback

```bash
ct find "query"                  # search tasks
ct show T1234                    # full details
ct show T1234 --field title      # single field, plain text (no JSON parsing)
ct add "Task title"              # create task
ct done T1234                    # complete task
```

## Session (required for multi-step work)

```bash
ct session list                                              # CHECK FIRST
ct session resume <id>                                       # resume existing
ct session start --scope epic:T001 --auto-focus --name "X"  # or start new
ct session end --note "summary"                              # ALWAYS end
```

## Errors

Never ignore exit codes. `"success": false` = failure.
Exit 4 = not found. Exit 6 = validation. Exit 10 = parent not found.
Exit 11 = depth exceeded (max 3). Exit 12 = sibling limit. Escape `$` as `\$`.

## More Operations

```bash
ct ops                # Tier 0 operations (this list)
ct ops --tier 1       # + memory and check domains
ct ops --tier 2       # all operations
```

Or via MCP: `cleo_query({ domain: "admin", operation: "help", params: { tier: 1 } })`

For session protocol, RCSD pipeline, orchestrator patterns: load the `ct-cleo` skill.

## Time Estimates Prohibited

Use `small` / `medium` / `large` sizing only. Never estimate hours, days, or weeks.
