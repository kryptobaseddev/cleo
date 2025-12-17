# sync Command

> Bidirectional synchronization between claude-todo and Claude Code's TodoWrite

## Usage

```bash
claude-todo sync --inject [OPTIONS]    # Session start: prepare tasks
claude-todo sync --extract [FILE]      # Session end: merge changes
claude-todo sync --status              # Show sync state
```

## Description

The `sync` command orchestrates bidirectional synchronization between claude-todo's persistent task storage and Claude Code's ephemeral TodoWrite system. It enables seamless task management across sessions by:

1. **Injecting** tasks at session start (claude-todo → TodoWrite)
2. **Extracting** changes at session end (TodoWrite → claude-todo)

This workflow preserves task IDs through content prefixes `[T###]`, enabling round-trip tracking without schema coupling.

## Subcommands

### sync --inject

Transforms claude-todo tasks into TodoWrite JSON format.

| Option | Description | Default |
|--------|-------------|---------|
| `--max-tasks N` | Maximum tasks to inject | `8` |
| `--focused-only` | Only inject the currently focused task | `false` |
| `--phase SLUG` | Filter tasks to specific phase (overrides project.currentPhase) | `project.currentPhase` |
| `--output FILE` | Write JSON to file instead of stdout | stdout |
| `--no-save-state` | Skip saving session state (for debugging/testing) | save state |
| `--quiet`, `-q` | Suppress info messages | show messages |

**Selection Strategy (tiered):**
- Tier 1: Current focused task (always included)
- Tier 2: Direct dependencies of focused task
- Tier 3: Other high-priority tasks in same phase

**Output Format:**
```json
{
  "todos": [
    {
      "content": "[T001] [!] Task title",
      "status": "in_progress",
      "activeForm": "Working on task title"
    }
  ]
}
```

**Content Prefix Format:**
- `[T###]` - Task ID (always present, required for round-trip)
- `[!]` - High/critical priority marker
- `[BLOCKED]` - Blocked status marker

### sync --extract

Parses TodoWrite state and merges changes back to claude-todo.

| Option | Description | Default |
|--------|-------------|---------|
| `--dry-run` | Show changes without modifying files | apply changes |
| `--quiet`, `-q` | Suppress info messages | show messages |

**Change Detection:**
| Type | Description | Action |
|------|-------------|--------|
| `completed` | Task status=completed in TodoWrite | Mark done in claude-todo |
| `progressed` | Task status=in_progress (was pending) | Update to active |
| `new_tasks` | No `[T###]` prefix | Create in claude-todo |
| `removed` | Injected ID missing from TodoWrite | Log only (no deletion) |

**Conflict Resolution:**
- claude-todo is authoritative for task existence
- TodoWrite is authoritative for session progress
- Warns but doesn't fail on conflicts

### sync --status

Shows current sync session state.

```bash
claude-todo sync --status
```

Displays:
- Active session ID
- Injection timestamp
- Injected task IDs
- Phase distribution
- State file location

### sync --clear

Clears sync state without merging changes. Used for recovery from stale or abandoned sessions.

```bash
claude-todo sync --clear
```

**Use Cases:**
- Recovery from crashed session without merging incomplete work
- Cleaning up stale sync state before starting new session
- Resetting after manual state file corruption
- Abandoning session without applying changes

## Examples

### Session Start Workflow

```bash
# Start session and inject tasks
claude-todo session start
claude-todo sync --inject

# Inject focused task only
claude-todo sync --inject --focused-only

# Inject tasks from specific phase
claude-todo sync --inject --phase core

# Save to file for debugging (without saving session state)
claude-todo sync --inject --output /tmp/inject.json --no-save-state
```

### Session End Workflow

```bash
# Extract changes from TodoWrite state
claude-todo sync --extract /path/to/todowrite-state.json

# Preview changes without applying
claude-todo sync --extract --dry-run /path/to/todowrite-state.json

# End session
claude-todo session end
```

### Recovery Workflow

```bash
# Check if stale sync state exists
claude-todo sync --status

# Clear stale state without merging (abandoned session)
claude-todo sync --clear

# Verify cleanup
claude-todo sync --status  # Should show "No active sync session"
```

### Phase-Specific Workflow

```bash
# Focus work on specific phase (e.g., polish phase)
claude-todo phase set polish
claude-todo sync --inject --phase polish --max-tasks 5

# Work on polish tasks...

# Extract changes
claude-todo sync --extract /tmp/todowrite-state.json
```

### Debugging Workflow

```bash
# Generate injection without saving state (for testing)
claude-todo sync --inject --no-save-state --output /tmp/test-inject.json

# Inspect the output
cat /tmp/test-inject.json | jq .

# Test extraction without applying
claude-todo sync --extract --dry-run /tmp/test-inject.json
```

### Full Cycle Example

```bash
# 1. Session start
claude-todo session start
claude-todo focus set T042

# 2. Inject to TodoWrite
claude-todo sync --inject --output /tmp/session.json
# Use this JSON to populate TodoWrite

# 3. Work in Claude Code session...
# (Claude uses TodoWrite, marks tasks complete, adds new tasks)

# 4. Export TodoWrite state to file (manually or via hook)

# 5. Extract changes
claude-todo sync --extract /tmp/todowrite-final.json

# 6. Session end
claude-todo session end
```

## Option Use Cases

### --phase SLUG

**When to use:**
- Working on specific project phase (e.g., `setup`, `core`, `polish`)
- Want to focus Claude Code session on phase-specific tasks
- Overriding project.currentPhase for isolated phase work

**Example:**
```bash
# Work exclusively on polish phase tasks
claude-todo sync --inject --phase polish
```

**Behavior:**
- Filters injected tasks to specified phase
- Overrides `project.currentPhase` if set
- Combines with tiered selection (focused task, dependencies, high-priority)

### --no-save-state

**When to use:**
- Testing injection output without creating session state
- Debugging TodoWrite format generation
- One-way export scenarios (no extraction planned)
- Generating example JSON for documentation

**Example:**
```bash
# Test injection format without session tracking
claude-todo sync --inject --no-save-state --output /tmp/test.json
```

**Behavior:**
- Skips creating `.claude/sync/todowrite-session.json`
- Extraction will not be possible (no state for comparison)
- Useful for read-only operations

### --clear

**When to use:**
- Session crashed or abandoned without proper extraction
- Stale sync state blocking new session
- Manual state file corruption detected
- Testing sync workflows repeatedly

**Example:**
```bash
# Recover from crashed session
claude-todo sync --status  # Verify stale state
claude-todo sync --clear   # Remove without merging
```

**Behavior:**
- Deletes `.claude/sync/todowrite-session.json`
- Does NOT apply changes from TodoWrite
- Safe to run (no data loss in claude-todo)

## Status Mapping

| claude-todo | → TodoWrite | TodoWrite | → claude-todo |
|-------------|-------------|-----------|---------------|
| `pending` | `pending` | `pending` | `pending` |
| `active` | `in_progress` | `in_progress` | `active` |
| `blocked` | `pending` + `[BLOCKED]` | `completed` | `done` |
| `done` | (excluded) | | |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Invalid arguments or missing file |
| `2` | JSON parse error |
| `3` | No tasks to inject |

## Session State

Injection creates a state file at `.claude/sync/todowrite-session.json`:

```json
{
  "session_id": "session_20251215_143022_a1b2c3",
  "injected_at": "2025-12-15T14:30:22Z",
  "injected_tasks": ["T001", "T002", "T003"],
  "snapshot": { ... }
}
```

This file enables:
- Tracking which tasks were injected
- Detecting removed tasks during extraction
- Session recovery on unexpected termination

## Related Commands

- `session` - Manage work sessions
- `focus` - Set active task focus
- `export --format todowrite` - One-way export (no round-trip)
