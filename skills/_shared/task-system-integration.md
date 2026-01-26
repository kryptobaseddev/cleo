# Task System Integration Reference

This reference defines portable task management commands using dynamic tokens.
Skills and templates SHOULD reference this file instead of hardcoding CLEO commands.

---

## Task Lifecycle Commands

### Read Task Details

```bash
{{TASK_SHOW_CMD}} {{TASK_ID}}
```

**Purpose**: Get full task context before starting work.

**CLEO Default**: `cleo show {{TASK_ID}}`

### Set Focus

```bash
{{TASK_FOCUS_CMD}} {{TASK_ID}}
```

**Purpose**: Mark task as active/in-progress.

**CLEO Default**: `cleo focus set {{TASK_ID}}`

### Complete Task

```bash
{{TASK_COMPLETE_CMD}} {{TASK_ID}}
```

**Purpose**: Mark task as done after work completes.

**CLEO Default**: `cleo complete {{TASK_ID}}`

### Link Research

```bash
{{TASK_LINK_CMD}} {{TASK_ID}} {{RESEARCH_ID}}
```

**Purpose**: Associate research output with task.

**CLEO Default**: `cleo research link {{TASK_ID}} {{RESEARCH_ID}}`

---

## Query Commands

### List Tasks

```bash
{{TASK_LIST_CMD}} [--status STATUS] [--parent EPIC_ID]
```

**CLEO Default**: `cleo list`

### Find Tasks

```bash
{{TASK_FIND_CMD}} "query"
```

**CLEO Default**: `cleo find`

### Add Task

```bash
{{TASK_ADD_CMD}} "Title" [OPTIONS]
```

**CLEO Default**: `cleo add`

---

## File Attachment

### Attach Files to Task

```bash
{{TASK_ADD_CMD}} "Title" --files "path1,path2"
```

Or update existing task:

```bash
cleo update {{TASK_ID}} --files "path1,path2"
```

**Purpose**: Attach context files for agent reference.

**CLEO Default**: `cleo add/update --files "paths"`

**Storage**: `.files` array in task JSON

### When to Use --files vs Research Link

| Method | Use Case | Storage |
|--------|----------|---------|
| `--files` | Reference existing docs, code files | Task `.files` array |
| `research link` | Connect subagent research outputs | Task `.linkedResearch` array |

### Guidelines

- **SHOULD** use `--files` for input context (specs, designs, code files)
- **SHOULD** use `research link` for output artifacts (research findings)
- **MAY** combine both for comprehensive task context

---

## CLEO-Specific Extensions

When the task system is CLEO, these additional commands are available:

| Command | Purpose |
|---------|---------|
| `cleo focus show` | Show current focus |
| `cleo session start` | Begin work session |
| `cleo session end` | End work session |
| `cleo analyze` | Task triage with scoring |
| `cleo deps {{TASK_ID}}` | Check task dependencies |
| `cleo tree --parent {{EPIC_ID}}` | Visualize hierarchy |

### Session Lifecycle

Sessions persist across Claude conversations and support long-running work.

**Key Behaviors**:
- Sessions timeout after **72 hours** of inactivity (session warning threshold)
- Sessions are auto-ended after `retention.autoEndActiveAfterDays` (default: **7 days**) of inactivity
- Use `cleo session gc --include-active` to clean up stale active sessions

**Session Commands**:

| Command | Purpose |
|---------|---------|
| `cleo session start --scope epic:{{EPIC_ID}}` | Begin scoped session |
| `cleo session end --note "summary"` | End session properly |
| `cleo session list` | Check existing sessions |
| `cleo session resume <id>` | Resume previous session |
| `cleo session gc` | Clean up ended/suspended sessions |
| `cleo session gc --include-active` | Also clean stale active sessions |

**Best Practices**:
- **MUST** check `cleo session list` before starting new sessions
- **SHOULD** end sessions properly to avoid accumulation
- **MAY** use `session gc --include-active` to recover from abandoned sessions
- Long-running sessions are expected for complex multi-day work

---

## Token Defaults

When tokens are not explicitly configured, assume CLEO defaults:

| Token | Default Value |
|-------|---------------|
| `{{TASK_SHOW_CMD}}` | `cleo show` |
| `{{TASK_FOCUS_CMD}}` | `cleo focus set` |
| `{{TASK_COMPLETE_CMD}}` | `cleo complete` |
| `{{TASK_LINK_CMD}}` | `cleo research link` |
| `{{TASK_LIST_CMD}}` | `cleo list` |
| `{{TASK_FIND_CMD}}` | `cleo find` |
| `{{TASK_ADD_CMD}}` | `cleo add` |
| `{{OUTPUT_DIR}}` | `claudedocs/research-outputs` |
| `{{MANIFEST_PATH}}` | `{{OUTPUT_DIR}}/MANIFEST.jsonl` |

---

## Usage in Skills

Reference this file from SKILL.md:

```markdown
### Task System Integration

@skills/_shared/task-system-integration.md

Execute lifecycle commands:
1. Read task: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. Set focus: `{{TASK_FOCUS_CMD}} {{TASK_ID}}`
3. Complete: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
```

---

## Usage in Templates

Include task lifecycle section in templates:

```markdown
### Task Lifecycle

1. MUST read task details: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. MUST set focus: `{{TASK_FOCUS_CMD}} {{TASK_ID}}`
3. MUST complete task: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
4. SHOULD link research: `{{TASK_LINK_CMD}} {{TASK_ID}} {{RESEARCH_ID}}`
```

---

## Non-CLEO Configurations

### Linear

```yaml
TASK_SHOW_CMD: "linear issue view"
TASK_FOCUS_CMD: "linear issue update --status in-progress"
TASK_COMPLETE_CMD: "linear issue update --status done"
```

### Jira

```yaml
TASK_SHOW_CMD: "jira issue view"
TASK_FOCUS_CMD: "jira issue move --status 'In Progress'"
TASK_COMPLETE_CMD: "jira issue move --status 'Done'"
```

### GitHub Issues

```yaml
TASK_SHOW_CMD: "gh issue view"
TASK_FOCUS_CMD: "gh issue edit --add-label 'in-progress'"
TASK_COMPLETE_CMD: "gh issue close"
```
