# CLEO Command Reference

Complete reference for all CLEO CLI commands, optimized for both LLM agents and humans.

**CLI Binary**: `cleo` (alias: `ct`)
**Output**: JSON by default (all commands)
**Exit Codes**: 0 = success, 1-99 = error, 100+ = special (not error)

---

## Quick Lookup

| Category | Commands |
|----------|----------|
| **Task CRUD** | [add](#add), [show](#show), [list](#list), [find](#find), [update](#update), [complete](#complete), [delete](#delete) |
| **Task Ops** | [archive](#archive), [unarchive](#unarchive), [reopen](#reopen), [uncancel](#uncancel), [promote](#promote), [reparent](#reparent), [reorder](#reorder) |
| **Session** | [session start](#session-start), [session end](#session-end), [session status](#session-status), [session list](#session-list), [session resume](#session-resume), [session gc](#session-gc) |
| **Focus** | [focus show](#focus-show), [focus set](#focus-set), [focus clear](#focus-clear), [focus history](#focus-history) |
| **Analysis** | [next](#next), [analyze](#analyze), [blockers](#blockers), [stats](#stats), [history](#history), [dash](#dash) |
| **Dependencies** | [deps overview](#deps-overview), [deps show](#deps-show), [deps waves](#deps-waves), [deps critical-path](#deps-critical-path), [deps impact](#deps-impact), [deps cycles](#deps-cycles), [tree](#tree) |
| **Phases** | [phase show](#phase-show), [phase list](#phase-list), [phase set](#phase-set), [phase start](#phase-start), [phase complete](#phase-complete), [phase advance](#phase-advance), [phase rename](#phase-rename), [phase delete](#phase-delete), [phases](#phases) |
| **Research** | [research add](#research-add), [research show](#research-show), [research list](#research-list), [research link](#research-link), [research update](#research-update), [research pending](#research-pending), [research stats](#research-stats), [research links](#research-links), [research manifest](#research-manifest), [research archive](#research-archive) |
| **Orchestration** | [orchestrate start](#orchestrate-start), [orchestrate analyze](#orchestrate-analyze), [orchestrate ready](#orchestrate-ready), [orchestrate next](#orchestrate-next), [orchestrate spawn](#orchestrate-spawn), [orchestrate validate](#orchestrate-validate), [orchestrate context](#orchestrate-context) |
| **Lifecycle** | [lifecycle show](#lifecycle-show), [lifecycle start](#lifecycle-start), [lifecycle complete](#lifecycle-complete), [lifecycle skip](#lifecycle-skip), [lifecycle gate](#lifecycle-gate) |
| **Release** | [release create](#release-create), [release plan](#release-plan), [release ship](#release-ship), [release list](#release-list), [release show](#release-show), [release changelog](#release-changelog) |
| **System** | [version](#version), [init](#init), [doctor](#doctor), [validate](#validate), [config](#config-get), [context](#context-status), [log](#log), [labels](#labels), [exists](#exists), [roadmap](#roadmap) |

---

## Task CRUD

### add

**Purpose**: Create a new task

**Usage**: `cleo add <title> [flags]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| title | string | yes | Task title |

**Flags**:

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| --status | -s | string | pending | Task status: pending, active, blocked, done |
| --priority | -p | string | medium | Priority: low, medium, high, critical |
| --type | -t | string | task | Task type: epic, task, subtask |
| --parent | | string | | Parent task ID (e.g. T001) |
| --size | | string | | Scope size: small, medium, large |
| --phase | -P | string | | Phase slug |
| --add-phase | | boolean | false | Create new phase if it does not exist |
| --description | -d | string | | Task description |
| --labels | -l | string | | Comma-separated labels |
| --files | | string | | Comma-separated file paths |
| --acceptance | | string | | Comma-separated acceptance criteria |
| --depends | -D | string | | Comma-separated dependency task IDs |
| --notes | | string | | Initial note entry |
| --position | | number | | Position within sibling group |
| --dry-run | | boolean | false | Preview without making changes |

**MCP Equivalent**: `cleo_mutate` domain=tasks operation=add params={title, ...}

**Example**:
```bash
cleo add "Implement auth module" -p high --parent T001 --depends T002,T003
```

**Output**:
```json
{"success": true, "data": {"task": {"id": "T042", "title": "Implement auth module", "status": "pending", "priority": "high"}}}
```

---

### show

**Purpose**: Show full task details by ID

**Usage**: `cleo show <taskId>`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | yes | Task ID (e.g. T001) |

**MCP Equivalent**: `cleo_query` domain=tasks operation=show params={taskId}

**Example**:
```bash
cleo show T042
```

**Output**:
```json
{"success": true, "data": {"task": {"id": "T042", "title": "...", "status": "pending", "priority": "high", "depends": ["T002"], "notes": [], "createdAt": "..."}}}
```

---

### list

**Purpose**: List tasks with optional filters

**Usage**: `cleo list [flags]`
**Alias**: `cleo ls`

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --status | string | | Filter by status (pending, active, blocked, done) |
| --priority | string | | Filter by priority (low, medium, high, critical) |
| --type | string | | Filter by type (epic, task, subtask) |
| --parent | string | | Filter by parent task ID |
| --phase | string | | Filter by phase slug |
| --label | string | | Filter by label |
| --children | boolean | false | Show direct children only (requires --parent) |
| --limit | number | | Max results |
| --offset | number | | Skip first N results |

**MCP Equivalent**: `cleo_query` domain=tasks operation=list params={status, parentId, ...}

**Example**:
```bash
cleo list --status pending --parent T001 --limit 10
```

**Note**: Prefer `find` over `list` for discovery -- `list` includes full notes arrays which consume significant context.

---

### find

**Purpose**: Fuzzy search tasks by title/description (context-efficient)

**Usage**: `cleo find [query] [flags]`
**Alias**: `cleo search`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | no | Search query text |

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --id | string | | Search by ID prefix (numeric, e.g. 42) |
| --exact | boolean | false | Exact title match |
| --status | string | | Filter by status |
| --field | string | | Restrict search to specific field |
| --include-archive | boolean | false | Include archived tasks |
| --limit | number | 20 | Max results |
| --offset | number | | Skip first N results |

**MCP Equivalent**: `cleo_query` domain=tasks operation=find params={query, id, ...}

**Example**:
```bash
cleo find "auth module"
cleo find --id 42
```

**Output**:
```json
{"success": true, "data": {"results": [{"id": "T042", "title": "...", "status": "pending", "score": 0.85}], "total": 1}}
```

---

### update

**Purpose**: Update a task's fields

**Usage**: `cleo update <taskId> [flags]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | yes | Task ID to update |

**Flags**:

| Flag | Short | Type | Description |
|------|-------|------|-------------|
| --title | | string | New title |
| --status | -s | string | New status |
| --priority | -p | string | New priority |
| --type | -t | string | New type |
| --size | | string | New size |
| --phase | -P | string | New phase |
| --description | -d | string | New description |
| --labels | -l | string | Set labels (comma-separated, replaces all) |
| --add-labels | | string | Add labels (comma-separated) |
| --remove-labels | | string | Remove labels (comma-separated) |
| --depends | -D | string | Set dependencies (comma-separated, replaces all) |
| --add-depends | | string | Add dependencies |
| --remove-depends | | string | Remove dependencies |
| --notes | | string | Add a note |
| --acceptance | | string | Set acceptance criteria (comma-separated) |
| --files | | string | Set files (comma-separated) |
| --blocked-by | | string | Set blocked-by reason |
| --parent | | string | Set parent ID |
| --no-auto-complete | | boolean | Disable auto-complete for epic |

**MCP Equivalent**: `cleo_mutate` domain=tasks operation=update params={taskId, ...}

**Example**:
```bash
cleo update T042 --status active --notes "Starting implementation"
cleo update T042 --add-labels "backend,auth" --add-depends T050
```

**Shell Escaping**: Escape `$` as `\$` in notes/descriptions.

---

### complete

**Purpose**: Mark a task as completed

**Usage**: `cleo complete <taskId> [flags]`
**Alias**: `cleo done`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | yes | Task ID to complete |

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --notes | string | Completion notes |
| --changeset | string | Changeset reference |

**MCP Equivalent**: `cleo_mutate` domain=tasks operation=complete params={taskId, notes}

**Example**:
```bash
cleo complete T042 --notes "Auth module shipped"
```

**Output**:
```json
{"success": true, "data": {"task": {"id": "T042", "status": "done", "completedAt": "2026-02-16T..."}, "autoCompleted": []}}
```

---

### delete

**Purpose**: Soft-delete a task (moves to archive)

**Usage**: `cleo delete <taskId> [flags]`
**Alias**: `cleo rm`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | yes | Task ID to delete |

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --force | boolean | false | Force delete even with dependents or children |
| --cascade | boolean | false | Delete children recursively |

**MCP Equivalent**: `cleo_mutate` domain=tasks operation=delete params={taskId, force, cascade}

**Example**:
```bash
cleo delete T042 --cascade
```

---

## Task Operations

### archive

**Purpose**: Archive completed tasks (move from todo.json to archive)

**Usage**: `cleo archive [flags]`

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --before | string | | Archive tasks completed before date (ISO format) |
| --tasks | string | | Specific task IDs to archive (comma-separated) |
| --no-cancelled | boolean | false | Exclude cancelled tasks |
| --dry-run | boolean | false | Preview without changes |

**MCP Equivalent**: `cleo_mutate` domain=tasks operation=archive params={before, taskIds}

**Example**:
```bash
cleo archive --before 2026-01-01
cleo archive --tasks T010,T011,T012
```

---

### unarchive

**Purpose**: Restore an archived task back to todo.json

**Usage**: `cleo unarchive <task-id> [flags]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| task-id | string | yes | Archived task ID |

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --status | string | pending | Status to restore task as |
| --preserve-status | boolean | false | Keep the original task status |
| --dry-run | boolean | false | Preview without changes |

**MCP Equivalent**: `cleo_mutate` domain=tasks operation=unarchive params={taskId, status}

---

### reopen

**Purpose**: Restore a completed (done) task back to pending/active status

**Usage**: `cleo reopen <task-id> [flags]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| task-id | string | yes | Completed task ID |

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --status | string | pending | Target status: pending or active |
| --reason | string | | Reason for reopening |
| --dry-run | boolean | false | Preview without changes |

**MCP Equivalent**: `cleo_mutate` domain=tasks operation=reopen params={taskId, status, reason}

---

### uncancel

**Purpose**: Restore cancelled tasks back to pending status

**Usage**: `cleo uncancel <task-id> [flags]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| task-id | string | yes | Cancelled task ID |

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --cascade | boolean | false | Also restore cancelled child tasks |
| --notes | string | | Note about restoration |
| --dry-run | boolean | false | Preview without changes |

**MCP Equivalent**: `cleo_mutate` domain=system operation=uncancel params={taskId, cascade}

---

### promote

**Purpose**: Remove parent from a task, making it root-level

**Usage**: `cleo promote <task-id> [flags]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| task-id | string | yes | Task ID to promote |

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --no-type-update | boolean | false | Skip auto-updating type from subtask to task |

**MCP Equivalent**: `cleo_mutate` domain=tasks operation=promote params={taskId}

---

### reparent

**Purpose**: Move a task to a different parent in the hierarchy

**Usage**: `cleo reparent <task-id> --to <parent-id>`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| task-id | string | yes | Task ID to move |

**Flags**:

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| --to | string | yes | Target parent task ID (or "" for root) |

**MCP Equivalent**: `cleo_mutate` domain=tasks operation=reparent params={taskId, parentId}

**Errors**: Exit 11 (depth exceeded), Exit 12 (sibling limit), Exit 14 (circular reference)

---

### reorder

**Purpose**: Change task position within its sibling group

**Usage**: `cleo reorder <task-id> [flags]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| task-id | string | yes | Task ID to reorder |

**Flags** (one required):

| Flag | Type | Description |
|------|------|-------------|
| --position | number | Move to specific position (1-based) |
| --before | string | Move before specified task ID |
| --after | string | Move after specified task ID |
| --top | boolean | Move to first position |
| --bottom | boolean | Move to last position |

**MCP Equivalent**: `cleo_mutate` domain=tasks operation=reorder params={taskId, position}

---

## Session Management

### session start

**Purpose**: Start a new work session

**Usage**: `cleo session start --scope <scope> --name <name> [flags]`

**Flags**:

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| --scope | string | yes | Session scope: `epic:T###` or `global` |
| --name | string | yes | Session name |
| --auto-focus | boolean | no | Auto-focus on first available task |
| --focus | string | no | Set initial focus task ID |
| --agent | string | no | Agent identifier |

**MCP Equivalent**: `cleo_mutate` domain=session operation=start params={scope, name, autoFocus}

**Example**:
```bash
cleo session start --scope epic:T001 --auto-focus --name "Auth work"
```

---

### session end

**Purpose**: End the current session

**Usage**: `cleo session end [flags]`

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --session | string | Specific session ID to end |
| --note | string | End note |

**MCP Equivalent**: `cleo_mutate` domain=session operation=end params={sessionId, note}

**Example**:
```bash
cleo session end --note "Completed auth tasks T042-T045"
```

---

### session status

**Purpose**: Show current session status

**Usage**: `cleo session status`

**MCP Equivalent**: `cleo_query` domain=session operation=status

**Exit**: 100 (NO_DATA) if no active session.

---

### session list

**Purpose**: List all sessions

**Usage**: `cleo session list [flags]`

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --status | string | Filter: active, ended, orphaned |
| --limit | number | Max results |

**MCP Equivalent**: `cleo_query` domain=session operation=list params={status, limit}

---

### session resume

**Purpose**: Resume an existing session

**Usage**: `cleo session resume <sessionId>`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| sessionId | string | yes | Session ID to resume |

**MCP Equivalent**: `cleo_mutate` domain=session operation=resume params={sessionId}

---

### session gc

**Purpose**: Garbage collect old/orphaned sessions

**Usage**: `cleo session gc [flags]`

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --max-age | number | Max age in hours for active sessions |

**MCP Equivalent**: `cleo_mutate` domain=session operation=gc params={maxAge}

---

## Focus Management

### focus show

**Purpose**: Show current focus task

**Usage**: `cleo focus show`

**MCP Equivalent**: `cleo_query` domain=session operation=focus-show

---

### focus set

**Purpose**: Set focus to a specific task

**Usage**: `cleo focus set <taskId>`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | yes | Task ID to focus on |

**MCP Equivalent**: `cleo_mutate` domain=session operation=focus-set params={taskId}

---

### focus clear

**Purpose**: Clear current focus

**Usage**: `cleo focus clear`

**MCP Equivalent**: `cleo_mutate` domain=session operation=focus-clear

---

### focus history

**Purpose**: Show focus history

**Usage**: `cleo focus history`

**MCP Equivalent**: `cleo_query` domain=session operation=history

---

## Analysis & Reporting

### next

**Purpose**: Suggest next task to work on based on priority, dependencies, and phase alignment

**Usage**: `cleo next [flags]`

**Flags**:

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| --explain | | boolean | false | Show detailed scoring reasoning |
| --count | -n | number | 1 | Show top N suggestions |

**MCP Equivalent**: `cleo_query` domain=tasks operation=next params={explain, count}

**Example**:
```bash
cleo next --explain -n 3
```

**Output**:
```json
{"success": true, "data": {"suggestion": {"id": "T050", "title": "...", "priority": "high", "score": 95, "reasons": ["priority: high (+75)", "all dependencies satisfied (+10)"]}, "totalCandidates": 12}}
```

---

### analyze

**Purpose**: Task triage with leverage scoring and bottleneck detection

**Usage**: `cleo analyze [flags]`

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --auto-focus | boolean | false | Automatically set focus to recommended task |

**MCP Equivalent**: `cleo_query` domain=tasks operation=analyze params={autoFocus}

---

### blockers

**Purpose**: Show blocked tasks and analyze blocking chains

**Usage**: `cleo blockers [flags]`

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --analyze | boolean | false | Show full blocking chain analysis |

**MCP Equivalent**: `cleo_query` domain=tasks operation=blockers params={analyze}

---

### stats

**Purpose**: Project statistics (counts, completion rates, velocity)

**Usage**: `cleo stats [flags]`

**Flags**:

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| --period | -p | string | 30 | Analysis period: today, week, month, quarter, year, or number of days |
| --verbose | -v | boolean | false | Show detailed breakdowns |
| --quiet | -q | boolean | false | Suppress decorative output |

**MCP Equivalent**: `cleo_query` domain=system operation=stats params={period}

---

### history

**Purpose**: Completion timeline and productivity analytics

**Usage**: `cleo history [flags]`

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --days | number | 30 | Show last N days |
| --since | string | | Start date (YYYY-MM-DD) |
| --until | string | | End date (YYYY-MM-DD) |
| --no-chart | boolean | false | Disable bar charts |

**MCP Equivalent**: `cleo_query` domain=tasks operation=history params={days, since, until}

---

### dash

**Purpose**: Project dashboard with status summary, phase progress, recent activity

**Usage**: `cleo dash [flags]`

**Flags**:

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| --compact | -c | boolean | false | Condensed single-line view |
| --period | | string | 7 | Stats period in days |
| --no-chart | | boolean | false | Disable ASCII charts |
| --sections | | string | | Comma-separated sections to show |
| --verbose | -v | boolean | false | Show full task details |
| --quiet | -q | boolean | false | Suppress decorative output |

**MCP Equivalent**: `cleo_query` domain=system operation=dash params={compact, period}

---

## Dependency Analysis

### deps overview

**Purpose**: Overview of all project dependencies

**Usage**: `cleo deps overview`

**MCP Equivalent**: `cleo_query` domain=tasks operation=deps params={subcommand: "overview"}

---

### deps show

**Purpose**: Show dependencies for a specific task (upstream and downstream)

**Usage**: `cleo deps show <taskId>`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | yes | Task ID |

**MCP Equivalent**: `cleo_query` domain=tasks operation=depends params={taskId}

---

### deps waves

**Purpose**: Group tasks into parallelizable execution waves

**Usage**: `cleo deps waves [epicId]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| epicId | string | no | Optional epic ID scope |

**MCP Equivalent**: `cleo_query` domain=orchestrate operation=waves params={epicId}

---

### deps critical-path

**Purpose**: Find the longest dependency chain from a task

**Usage**: `cleo deps critical-path <taskId>`

**MCP Equivalent**: `cleo_query` domain=orchestrate operation=critical-path params={taskId}

---

### deps impact

**Purpose**: Find all tasks affected by changes to a given task

**Usage**: `cleo deps impact <taskId> [flags]`

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --depth | number | 10 | Maximum traversal depth |

---

### deps cycles

**Purpose**: Detect circular dependencies across all tasks

**Usage**: `cleo deps cycles`

---

### tree

**Purpose**: Task hierarchy tree visualization

**Usage**: `cleo tree [rootId]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| rootId | string | no | Root task ID (whole tree if omitted) |

**MCP Equivalent**: `cleo_query` domain=tasks operation=tree params={rootId}

---

## Phase Management

### phase show

**Purpose**: Show phase details (current phase if no slug given)

**Usage**: `cleo phase show [slug]`

---

### phase list

**Purpose**: List all phases with status

**Usage**: `cleo phase list`

---

### phase set

**Purpose**: Set the current project phase

**Usage**: `cleo phase set <slug> [flags]`

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --rollback | boolean | false | Allow backward phase movement |
| --force | boolean | false | Skip confirmation |
| --dry-run | boolean | false | Preview changes |

---

### phase start

**Purpose**: Start a phase (pending -> active)

**Usage**: `cleo phase start <slug>`

---

### phase complete

**Purpose**: Complete a phase (active -> completed)

**Usage**: `cleo phase complete <slug>`

---

### phase advance

**Purpose**: Complete current phase and start the next one

**Usage**: `cleo phase advance [flags]`

**Flags**:

| Flag | Short | Type | Description |
|------|-------|------|-------------|
| --force | -f | boolean | Skip validation |

---

### phase rename

**Purpose**: Rename a phase and update all task references

**Usage**: `cleo phase rename <oldName> <newName>`

---

### phase delete

**Purpose**: Delete a phase with task reassignment protection

**Usage**: `cleo phase delete <slug> [flags]`

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --reassign-to | string | Reassign tasks to another phase |
| --force | boolean | Required safety flag |

---

### phases

**Purpose**: List phases with progress bars and statistics

**Usage**: `cleo phases`

---

## Research

### research add

**Purpose**: Add a research entry linked to a task

**Usage**: `cleo research add -t <taskId> --topic <topic> [flags]`

**Flags**:

| Flag | Short | Type | Required | Description |
|------|-------|------|----------|-------------|
| --task | -t | string | yes | Task ID to attach research to |
| --topic | | string | yes | Research topic |
| --findings | | string | no | Comma-separated findings |
| --sources | | string | no | Comma-separated sources |

**MCP Equivalent**: `cleo_mutate` domain=research operation=inject params={taskId, topic, findings}

---

### research show

**Purpose**: Show a single research entry

**Usage**: `cleo research show <id>`

**MCP Equivalent**: `cleo_query` domain=research operation=show params={id}

---

### research list

**Purpose**: List research entries with optional filters

**Usage**: `cleo research list [flags]`

**Flags**:

| Flag | Short | Type | Description |
|------|-------|------|-------------|
| --task | -t | string | Filter by task ID |
| --status | -s | string | Filter by status: pending, complete, partial |
| --limit | -l | number | Limit results |

**MCP Equivalent**: `cleo_query` domain=research operation=list params={taskId, status}

---

### research link

**Purpose**: Link a research entry to a task

**Usage**: `cleo research link <researchId> <taskId>`

**MCP Equivalent**: `cleo_mutate` domain=research operation=link params={researchId, taskId}

---

### research update

**Purpose**: Update research findings, sources, or status

**Usage**: `cleo research update <id> [flags]`

**Flags**:

| Flag | Short | Type | Description |
|------|-------|------|-------------|
| --findings | | string | Comma-separated findings |
| --sources | | string | Comma-separated sources |
| --status | -s | string | Set status: pending, complete, partial |

---

### research pending

**Purpose**: List pending research entries

**Usage**: `cleo research pending`

**MCP Equivalent**: `cleo_query` domain=research operation=pending

---

### research stats

**Purpose**: Show research statistics

**Usage**: `cleo research stats`

**MCP Equivalent**: `cleo_query` domain=research operation=stats

---

### research links

**Purpose**: Show research entries linked to a specific task

**Usage**: `cleo research links <taskId>`

---

### research manifest

**Purpose**: Query MANIFEST.jsonl entries

**Usage**: `cleo research manifest [flags]`

**Flags**:

| Flag | Short | Type | Description |
|------|-------|------|-------------|
| --status | -s | string | Filter by status |
| --agent-type | -a | string | Filter by agent type |
| --topic | | string | Filter by topic |
| --task | -t | string | Filter by linked task |
| --limit | -l | number | Limit results |

**MCP Equivalent**: `cleo_query` domain=research operation=manifest.read params={status, agentType, taskId}

---

### research archive

**Purpose**: Archive completed research entries

**Usage**: `cleo research archive`

**MCP Equivalent**: `cleo_mutate` domain=research operation=manifest.archive

---

## Multi-Agent Orchestration

### orchestrate start

**Purpose**: Start orchestrator session for an epic

**Usage**: `cleo orchestrate start <epicId>`

**MCP Equivalent**: `cleo_mutate` domain=orchestrate operation=startup params={epicId}

---

### orchestrate analyze

**Purpose**: Analyze epic dependency structure (waves, bottlenecks)

**Usage**: `cleo orchestrate analyze <epicId>`

**MCP Equivalent**: `cleo_query` domain=orchestrate operation=analyze params={epicId}

---

### orchestrate ready

**Purpose**: Get parallel-safe tasks ready for execution

**Usage**: `cleo orchestrate ready <epicId>`

**MCP Equivalent**: `cleo_query` domain=orchestrate operation=ready params={epicId}

---

### orchestrate next

**Purpose**: Get next task to spawn for a subagent

**Usage**: `cleo orchestrate next <epicId>`

**MCP Equivalent**: `cleo_query` domain=orchestrate operation=next params={epicId}

---

### orchestrate spawn

**Purpose**: Prepare spawn context for a subagent (resolves tokens, loads protocol)

**Usage**: `cleo orchestrate spawn <taskId>`

**MCP Equivalent**: `cleo_mutate` domain=orchestrate operation=spawn params={taskId}

---

### orchestrate validate

**Purpose**: Validate subagent output after spawn completion

**Usage**: `cleo orchestrate validate <taskId> [flags]`

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --file | string | Output file path to validate |
| --manifest | boolean | Check manifest entry was appended |

**MCP Equivalent**: `cleo_mutate` domain=orchestrate operation=validate params={taskId, file}

---

### orchestrate context

**Purpose**: Get orchestrator context summary for an epic

**Usage**: `cleo orchestrate context <epicId>`

**MCP Equivalent**: `cleo_query` domain=orchestrate operation=context params={epicId}

---

## RCSD Lifecycle

### lifecycle show

**Purpose**: Show lifecycle state for an epic

**Usage**: `cleo lifecycle show <epicId>`

**MCP Equivalent**: `cleo_query` domain=lifecycle operation=status params={epicId}

---

### lifecycle start

**Purpose**: Start a lifecycle stage (research, consensus, specification, decomposition, implementation, release)

**Usage**: `cleo lifecycle start <epicId> <stage>`

**MCP Equivalent**: `cleo_mutate` domain=lifecycle operation=progress params={epicId, stage}

---

### lifecycle complete

**Purpose**: Complete a lifecycle stage

**Usage**: `cleo lifecycle complete <epicId> <stage> [flags]`

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --artifacts | string | Comma-separated artifact paths |

---

### lifecycle skip

**Purpose**: Skip a lifecycle stage (requires justification)

**Usage**: `cleo lifecycle skip <epicId> <stage> --reason <reason>`

**Flags**:

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| --reason | string | yes | Reason for skipping |

**MCP Equivalent**: `cleo_mutate` domain=lifecycle operation=skip params={epicId, stage, reason}

---

### lifecycle gate

**Purpose**: Check if a lifecycle gate allows progression to a stage

**Usage**: `cleo lifecycle gate <epicId> <stage>`

**Exit**: 80 (LIFECYCLE_GATE_FAILED) if gate check fails.

**MCP Equivalent**: `cleo_query` domain=lifecycle operation=check params={epicId, stage}

---

## Release Management

### release create

**Purpose**: Create a new release

**Usage**: `cleo release create <version> [flags]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| version | string | yes | Semver version (e.g. v1.2.0) |

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --tasks | string | Comma-separated task IDs |
| --notes | string | Release notes |
| --target-date | string | Target release date (ISO) |

**MCP Equivalent**: `cleo_mutate` domain=release operation=prepare params={version, tasks}

---

### release plan

**Purpose**: Add or remove tasks from a release

**Usage**: `cleo release plan <version> [flags]`

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --tasks | string | Comma-separated task IDs to add |
| --remove | string | Comma-separated task IDs to remove |
| --notes | string | Update release notes |

---

### release ship

**Purpose**: Ship a release (bump version, generate changelog, tag, push)

**Usage**: `cleo release ship <version> [flags]`

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --bump-version | boolean | false | Update VERSION file |
| --create-tag | boolean | false | Create git tag |
| --push | boolean | false | Push to remote |
| --dry-run | boolean | false | Preview without changes |

**MCP Equivalent**: `cleo_mutate` domain=release operation=commit params={version, bumpVersion, createTag, push}

**Example**:
```bash
cleo release ship v1.2.0 --bump-version --create-tag --push
cleo release ship v1.2.0 --bump-version --dry-run  # Preview first
```

---

### release list

**Purpose**: List all releases

**Usage**: `cleo release list`

---

### release show

**Purpose**: Show details for a specific release

**Usage**: `cleo release show <version>`

---

### release changelog

**Purpose**: Get generated changelog for a release

**Usage**: `cleo release changelog <version>`

**MCP Equivalent**: `cleo_mutate` domain=release operation=changelog params={version}

---

## System Commands

### version

**Purpose**: Display CLEO version

**Usage**: `cleo version`

**MCP Equivalent**: `cleo_query` domain=system operation=version

---

### init

**Purpose**: Initialize CLEO in a project directory

**Usage**: `cleo init [projectName] [flags]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| projectName | string | no | Project name |

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --name | string | Project name (alternative to argument) |
| --force | boolean | Overwrite existing files |
| --detect | boolean | Auto-detect project configuration |
| --update-docs | boolean | Update agent documentation injections |

**MCP Equivalent**: `cleo_mutate` domain=system operation=init params={name, force}

---

### doctor

**Purpose**: Run system diagnostics and health checks

**Usage**: `cleo doctor`

**MCP Equivalent**: `cleo_query` domain=system operation=doctor

**Checks**: jq installed, git installed, CLEO directories, data files, schema version, Node.js version, platform.

**Exit**: 6 (VALIDATION_ERROR) if any check fails.

---

### validate

**Purpose**: Validate todo.json against schema and business rules

**Usage**: `cleo validate [flags]`

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --strict | boolean | false | Treat warnings as errors |
| --fix | boolean | false | Auto-fix simple issues |
| --dry-run | boolean | false | Preview fixes without applying |

**MCP Equivalent**: `cleo_query` domain=validate operation=schema

**Checks**: JSON syntax, duplicate IDs, cross-file duplicates, active task limit, dependency integrity, circular deps, blocked task reasons, completion timestamps, schema version, required fields, focus consistency, checksum, stale tasks.

---

### config get

**Purpose**: Get a configuration value by dotted path

**Usage**: `cleo config get <key>`

**MCP Equivalent**: `cleo_query` domain=system operation=config.get params={key}

**Example**:
```bash
cleo config get hierarchy.maxDepth
```

---

### config set

**Purpose**: Set a configuration value

**Usage**: `cleo config set <key> <value> [flags]`

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --global | boolean | Set in global config instead of project config |

**MCP Equivalent**: `cleo_mutate` domain=system operation=config.set params={key, value, global}

**Example**:
```bash
cleo config set hierarchy.maxSiblings 10
cleo config set lifecycle.mode advisory --global
```

---

### config list

**Purpose**: Show all resolved configuration

**Usage**: `cleo config list`

**MCP Equivalent**: `cleo_query` domain=system operation=config

---

### context status

**Purpose**: Show current context window state

**Usage**: `cleo context status [flags]`

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --session | string | Check specific session ID |

**MCP Equivalent**: `cleo_query` domain=system operation=context params={session}

---

### context check

**Purpose**: Check context threshold, return exit code for scripting

**Usage**: `cleo context check [flags]`

**Flags**:

| Flag | Type | Description |
|------|------|-------------|
| --session | string | Check specific session ID |

**Exit Codes**: 50 (WARNING), 51 (CAUTION), 52 (CRITICAL), 53 (EMERGENCY)

---

### context list

**Purpose**: List all context state files (multi-session)

**Usage**: `cleo context list`

---

### log

**Purpose**: View audit log entries

**Usage**: `cleo log [flags]`

**Flags**:

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| --limit | | number | 20 | Maximum entries to show |
| --offset | | number | 0 | Skip N entries |
| --operation | | string | | Filter by operation type |
| --task | | string | | Filter by task ID |
| --since | | string | | Filter entries since date |
| --quiet | -q | boolean | false | Suppress decorative output |

**MCP Equivalent**: `cleo_query` domain=system operation=log params={limit, operation, task}

---

### labels

**Purpose**: List all labels with task counts, or show tasks for a label

**Usage**:
```bash
cleo labels list        # List all labels with counts
cleo labels show <label> # Show tasks with specific label
cleo labels stats       # Detailed label statistics
```

**Alias**: `cleo tags`

**MCP Equivalent**: `cleo_query` domain=system operation=labels

---

### exists

**Purpose**: Check if a task ID exists (for scripting)

**Usage**: `cleo exists <task-id> [flags]`

**Arguments**:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| task-id | string | yes | Task ID to check (e.g. T001) |

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --include-archive | boolean | false | Search archive file too |
| --verbose | boolean | false | Show which file contains the task |

**MCP Equivalent**: `cleo_query` domain=tasks operation=exists params={taskId, includeArchive}

**Exit**: 0 = exists, 4 = not found

**Example**:
```bash
cleo exists T042 && echo "found" || echo "not found"
```

---

### roadmap

**Purpose**: Generate roadmap from pending epics and CHANGELOG history

**Usage**: `cleo roadmap [flags]`

**Flags**:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| --include-history | boolean | false | Include release history |
| --upcoming-only | boolean | false | Only show upcoming/planned releases |

**MCP Equivalent**: `cleo_query` domain=system operation=roadmap params={includeHistory}

---

## Exit Code Reference

| Range | Meaning | Examples |
|-------|---------|---------|
| 0 | Success | Operation completed |
| 1-9 | General errors | Invalid input (2), not found (4), validation error (6) |
| 10-19 | Hierarchy errors | Parent not found (10), depth exceeded (11), sibling limit (12) |
| 20-29 | Concurrency errors | Checksum mismatch (20), ID collision (22) |
| 30-39 | Session errors | Session exists (30), focus required (38) |
| 40-47 | Verification errors | Gate update failed (41) |
| 50-54 | Context safeguard | Warning (50), caution (51), critical (52), emergency (53) |
| 60-67 | Orchestrator errors | Protocol missing (60), manifest missing (62) |
| 70-79 | Nexus errors | Not initialized (70), permission denied (72) |
| 80-84 | Lifecycle | Gate failed (80), audit missing (81) |
| 100+ | Special (non-error) | No data (100), already exists (101), no change (102) |

---

## MCP Domain/Operation Mapping

CLEO exposes two MCP tools: `cleo_query` (read-only) and `cleo_mutate` (writes).

### Tasks Domain

| CLI Command | Gateway | Operation | Key Params |
|-------------|---------|-----------|------------|
| show | query | show | taskId |
| list | query | list | status, priority, type, parentId, phase, label |
| find | query | find | query, id, exact, status |
| exists | query | exists | taskId, includeArchive |
| next | query | next | explain, count |
| deps | query | deps | taskId |
| tree | query | tree | rootId |
| blockers | query | blockers | analyze |
| analyze | query | analyze | autoFocus |
| stats | query | stats | period |
| history | query | history | days, since, until |
| add | mutate | add | title, priority, type, parentId, depends, ... |
| update | mutate | update | taskId, title, status, priority, notes, ... |
| complete | mutate | complete | taskId, notes, changeset |
| delete | mutate | delete | taskId, force, cascade |
| archive | mutate | archive | before, taskIds |
| unarchive | mutate | unarchive | taskId, status |
| reopen | mutate | reopen | taskId, status, reason |
| promote | mutate | promote | taskId |
| reparent | mutate | reparent | taskId, parentId |
| reorder | mutate | reorder | taskId, position |

### Session Domain

| CLI Command | Gateway | Operation | Key Params |
|-------------|---------|-----------|------------|
| session status | query | status | |
| session list | query | list | status, limit |
| focus show | query | focus-show | |
| session start | mutate | start | scope, name, autoFocus |
| session end | mutate | end | sessionId, note |
| session resume | mutate | resume | sessionId |
| focus set | mutate | focus-set | taskId |
| focus clear | mutate | focus-clear | |
| session gc | mutate | gc | maxAge |

### System Domain

| CLI Command | Gateway | Operation | Key Params |
|-------------|---------|-----------|------------|
| version | query | version | |
| doctor | query | doctor | |
| dash | query | dash | compact, period |
| stats | query | stats | period |
| config list | query | config | |
| config get | query | config.get | key |
| context | query | context | session |
| log | query | log | limit, operation, task |
| labels | query | labels | |
| roadmap | query | roadmap | includeHistory |
| init | mutate | init | name, force |
| config set | mutate | config.set | key, value, global |
| backup | mutate | backup | |
| restore | mutate | restore | |

### Orchestrate Domain

| CLI Command | Gateway | Operation | Key Params |
|-------------|---------|-----------|------------|
| orchestrate analyze | query | analyze | epicId |
| orchestrate ready | query | ready | epicId |
| orchestrate next | query | next | epicId |
| orchestrate context | query | context | epicId |
| orchestrate start | mutate | startup | epicId |
| orchestrate spawn | mutate | spawn | taskId |
| orchestrate validate | mutate | validate | taskId, file |

### Research Domain

| CLI Command | Gateway | Operation | Key Params |
|-------------|---------|-----------|------------|
| research show | query | show | id |
| research list | query | list | taskId, status |
| research pending | query | pending | |
| research stats | query | stats | |
| research manifest | query | manifest.read | status, agentType, taskId |
| research add | mutate | inject | taskId, topic, findings |
| research link | mutate | link | researchId, taskId |

### Lifecycle Domain

| CLI Command | Gateway | Operation | Key Params |
|-------------|---------|-----------|------------|
| lifecycle show | query | status | epicId |
| lifecycle gate | query | check | epicId, stage |
| lifecycle start | mutate | progress | epicId, stage |
| lifecycle skip | mutate | skip | epicId, stage, reason |

### Validate Domain

| CLI Command | Gateway | Operation | Key Params |
|-------------|---------|-----------|------------|
| validate | query | schema | strict |
| validate (protocol) | query | protocol | protocol, file |

### Release Domain

| CLI Command | Gateway | Operation | Key Params |
|-------------|---------|-----------|------------|
| release create | mutate | prepare | version, tasks |
| release ship | mutate | commit | version, bumpVersion, createTag, push |
| release changelog | mutate | changelog | version |
