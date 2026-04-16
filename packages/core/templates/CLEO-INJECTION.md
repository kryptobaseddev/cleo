# CLEO Protocol

Version: 2.4.1 | CLI-only dispatch | `cleo <command> [args]`

## Session Start (cheapest-first)

1. `cleo session status` — resume existing? (~200 tokens)
2. `cleo dash` — project overview (~500 tokens)
3. `cleo current` — active task? (~100 tokens)
4. `cleo next` — what to work on (~300 tokens)
5. `cleo show {id}` — full details for chosen task (~400 tokens)
6. `cleo orchestrate start --epic TXXX` — for epics with ≥ 5 children (~300 tokens, auto-inits LOOM)

## Work Loop

1. `cleo current` or `cleo next` → pick task
2. `cleo show {id}` → read requirements
3. Do the work (code, test, document)
4. `cleo complete {id}` → mark done
5. `cleo next` → continue or end session

## Triggers (when to call what)

| Signal | Action |
|--------|--------|
| Epic with ≥ 5 child tasks just created | Run `cleo orchestrate start <epicId>` before touching any child |
| You just ran `cleo complete <id>` for a non-trivial task | Run `cleo memory observe "..." --title "..."` with what you learned |
| Task acceptance criterion contains "test" | Propose an `AcceptanceGate` with `kind:"test"` via `cleo req add` |
| Session token budget ≈ 80% consumed | Run `cleo session end --note "..."` and hand off |
| Multiple related tasks ready in parallel | Run `cleo orchestrate ready --epic <id>` for the wave set |
| About to call `cleo complete` | First: check gates via `cleo show <id>` → run tests → then complete |

## Task Discovery

**Use `cleo find` for discovery. NEVER `cleo list` for browsing.**

| Command | ~Tokens | Use |
|---------|---------|-----|
| `cleo find "query"` | 200-400 | Search tasks (default) |
| `cleo show <id>` | 300-600 | Full details for one task |
| `cleo list --parent <id>` | 1000-5000 | Direct children only |

## Session Commands

| Goal | Command |
|------|---------|
| Check session | `cleo session status` |
| Resume context | `cleo briefing` |
| Start session | `cleo session start --scope global` |
| End session | `cleo session end --note "..."` |

## Memory (BRAIN)

3-layer retrieval — search first, then fetch:

| Step | Command | ~Tokens |
|------|---------|---------|
| Search | `cleo memory find "query"` | 50/hit |
| Context | `cleo memory timeline <id>` | 200-500 |
| Details | `cleo memory fetch <id>` | 500/entry |
| Save | `cleo memory observe "text" --title "title"` | — |
| LLM status | `cleo memory llm-status` | 50 |
| Ground-truth promote | `cleo memory verify <id>` (owner only) | 50 |

Memory bridge (`.cleo/memory-bridge.md`) auto-refreshes on session end and task completion.

## Orchestration (for epics ≥ 5 tasks)

| Goal | Command |
|------|---------|
| Initialize epic pipeline | `cleo orchestrate start <epicId>` (auto-inits LOOM research stage) |
| Get parallel-safe wave | `cleo orchestrate ready --epic <id>` |
| Get spawn prompt for a task | `cleo orchestrate spawn <taskId>` |
| Multi-agent IVTR loop | `cleo orchestrate ivtr <taskId> --start` |
| View epic wave plan | `cleo orchestrate waves <epicId>` |

## Documents & Attachments

| Goal | Command |
|------|---------|
| Attach file/url to task | `cleo docs add <taskId> <file>` or `--url <url>` |
| List task attachments | `cleo docs list --task <id>` |
| Generate llms.txt summary | `cleo docs generate --for <taskId>` |

## Error Handling

Check exit code (`0` = success) and `"success"` in JSON output after every command.

| Exit | Code | Fix |
|:----:|------|-----|
| 4 | `E_NOT_FOUND` | `cleo find` to verify ID |
| 6 | `E_VALIDATION` | Check field lengths |
| 10 | `E_PARENT_NOT_FOUND` | `cleo exists <id>` |
| 80 | `E_LIFECYCLE_GATE_FAILED` | Parent epic not in implementation stage yet — advance with `cleo lifecycle complete` |
| 83 | `E_IVTR_INCOMPLETE` | IVTR loop not released — run `cleo orchestrate ivtr <id> --next` |

## Pre-Complete Gate Ritual

MANDATORY before every `cleo complete <id>`:

1. `cleo show <id>` — inspect gates
2. Run each acceptance criterion verifiable (tests, lint, file checks)
3. `cleo verify <id> --run` — executes programmatic AcceptanceGates
4. `cleo memory observe "..." --title "..."` — capture learnings
5. `cleo complete <id>` — should pass cleanly

Anti-patterns to avoid:
- ❌ Calling `cleo complete` without verifying tests actually ran
- ❌ Marking all gates green on `cleo verify --all` when only some criteria were checked
- ❌ Skipping `cleo memory observe` on non-trivial tasks
- ❌ Self-attesting without programmatic proof (IVTR validate phase exists to prevent this)

## Rules

- No time estimates — use `small`, `medium`, `large` sizing
- Token budget: avoid `cleo list` without `--parent`, avoid `cleo help --tier 2` before tier 0
- Do not read full task details for tasks you won't work on

## Memory Protocol (JIT)

Pull context on demand — don't pre-load everything:

| Need | Command |
|------|---------|
| Prior decisions | `cleo memory find "<topic>" --type decision` |
| Known patterns | `cleo memory find "<domain>" --type pattern` |
| Timeline context | `cleo memory timeline <id>` |
| Full details | `cleo memory fetch <id>` |
| Code context | `cleo nexus context <symbol>` |
| Impact analysis | `cleo nexus impact <symbol>` |

Budget: 3 JIT calls per task phase. More = task is underspecified.

## Escalation

- Load **ct-cleo** skill for full protocol details
- Load **ct-orchestrator** skill for multi-agent workflows
