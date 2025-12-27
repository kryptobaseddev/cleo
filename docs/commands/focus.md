# focus Command

Manage task focus for single-task workflow discipline.

## Usage

```bash
cleo focus <command> [OPTIONS]
```

## Description

The `focus` command enforces single-task discipline by tracking which task you're currently working on. Setting focus automatically marks the task as `active` and ensures only one task is active at a time.

Focus also supports session notes and next-action suggestions to maintain context across work sessions.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `set <task-id>` | Set focus to a specific task (marks it active) |
| `clear` | Clear current focus (resets task to pending) |
| `show` | Show current focus (default if no subcommand) |
| `note <text>` | Set session progress note |
| `next <text>` | Set suggested next action |

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output in JSON format |
| `--help`, `-h` | Show help message |

## Examples

### Setting Focus

```bash
# Set focus to a task (marks it active)
cleo focus set T001

# Focus automatically enforces single-active-task rule
# If another task is active, it's set to pending first
```

Output:
```
[FOCUS] Focus set: Implement user authentication
[INFO] Task ID: T001
[INFO] Status: active
```

### Viewing Focus

```bash
# Show current focus
cleo focus show

# JSON output for scripting
cleo focus show --json
```

Output (text):
```
=== Current Focus ===

Task: Implement user authentication
  ID: T001
  Status: active
  Path: T001 > T002  (hierarchy breadcrumb)
  Parent: T001 (Auth Epic)
  Children: 2 done, 1 pending

Session Note: Working on JWT implementation
Next Action: Write integration tests
```

Output (JSON):
```json
{
  "currentTask": "T001",
  "sessionNote": "Working on JWT implementation",
  "nextAction": "Write integration tests",
  "hierarchy": {
    "parent": "T001 (Auth Epic)",
    "children": "2 done, 1 pending",
    "breadcrumb": "T001 > T002"
  }
}
```

## Hierarchy Context (v0.27.0+)

When showing focus, hierarchy context is displayed:

| Field | Description |
|-------|-------------|
| Path | Breadcrumb trail showing ancestor chain |
| Parent | Parent task with ID and title |
| Children | Summary of child task statuses |

This helps maintain context when working on nested tasks within epics.

### Session Notes

```bash
# Set progress note (replaces previous note)
cleo focus note "Completed API endpoints, working on tests"

# Set suggested next action
cleo focus next "Write unit tests for auth module"
```

### Clearing Focus

```bash
# Clear focus (resets task to pending)
cleo focus clear
```

Output:
```
[FOCUS] Focus cleared
[INFO] Previous focus: T001 (status reset to pending)
```

## Focus State

Focus state is stored in `todo.json`:

```json
{
  "focus": {
    "currentTask": "T001",
    "sessionNote": "Working on authentication",
    "nextAction": "Write tests"
  }
}
```

| Field | Description | Persistence |
|-------|-------------|-------------|
| `currentTask` | ID of focused task | Until cleared or completed |
| `sessionNote` | Progress/context note | Replaces on each `focus note` |
| `nextAction` | Suggested next step | Replaces on each `focus next` |

## Single-Task Enforcement

Setting focus enforces these rules:
1. Only one task can be `active` at a time
2. Setting focus on a new task:
   - Sets previous active task to `pending`
   - Sets new task to `active`
   - Updates `focus.currentTask`

## Integration with Other Commands

### With session command

```bash
# Start session (shows focus context)
cleo session start

# Focus is shown automatically:
# [INFO] Resume focus: Implement auth (T001)
# [INFO] Last session note: Working on JWT
# [INFO] Suggested next action: Write tests
```

### With complete command

```bash
# Completing focused task clears focus automatically
cleo complete T001 --notes "Done"

# Focus is cleared when task is completed
```

## See Also

- [session](session.md) - Manage work sessions
- [list](list.md) - View tasks
- [complete](complete.md) - Complete tasks
- [next](next.md) - Get task suggestions
