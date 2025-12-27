# sync Command

> Bidirectional synchronization between cleo and Claude Code's TodoWrite

## Usage

```bash
cleo sync --inject [OPTIONS]    # Session start: prepare tasks
cleo sync --extract [FILE]      # Session end: merge changes
cleo sync --status              # Show sync state
```

## Description

The `sync` command orchestrates bidirectional synchronization between cleo's persistent task storage and Claude Code's ephemeral TodoWrite system. It enables seamless task management across sessions by:

1. **Injecting** tasks at session start (cleo → TodoWrite)
2. **Extracting** changes at session end (TodoWrite → cleo)

This workflow preserves task IDs through content prefixes `[T###]`, enabling round-trip tracking without schema coupling.

## Subcommands

### sync --inject

Transforms cleo tasks into TodoWrite JSON format.

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

Parses TodoWrite state and merges changes back to cleo.

| Option | Description | Default |
|--------|-------------|---------|
| `--dry-run` | Show changes without modifying files | apply changes |
| `--quiet`, `-q` | Suppress info messages | show messages |

**Change Detection:**
| Type | Description | Action |
|------|-------------|--------|
| `completed` | Task status=completed in TodoWrite | Mark done in cleo |
| `progressed` | Task status=in_progress (was pending) | Update to active |
| `new_tasks` | No `[T###]` prefix | Create in cleo |
| `removed` | Injected ID missing from TodoWrite | Log only (no deletion) |

**Conflict Resolution:**
- cleo is authoritative for task existence
- TodoWrite is authoritative for session progress
- Warns but doesn't fail on conflicts

### sync --status

Shows current sync session state.

```bash
cleo sync --status
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
cleo sync --clear
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
cleo session start
cleo sync --inject

# Inject focused task only
cleo sync --inject --focused-only

# Inject tasks from specific phase
cleo sync --inject --phase core

# Save to file for debugging (without saving session state)
cleo sync --inject --output /tmp/inject.json --no-save-state
```

### Session End Workflow

```bash
# Extract changes from TodoWrite state
cleo sync --extract /path/to/todowrite-state.json

# Preview changes without applying
cleo sync --extract --dry-run /path/to/todowrite-state.json

# End session
cleo session end
```

### Recovery Workflow

```bash
# Check if stale sync state exists
cleo sync --status

# Clear stale state without merging (abandoned session)
cleo sync --clear

# Verify cleanup
cleo sync --status  # Should show "No active sync session"
```

### Phase-Specific Workflow

```bash
# Focus work on specific phase (e.g., polish phase)
cleo phase set polish
cleo sync --inject --phase polish --max-tasks 5

# Work on polish tasks...

# Extract changes
cleo sync --extract /tmp/todowrite-state.json
```

### Debugging Workflow

```bash
# Generate injection without saving state (for testing)
cleo sync --inject --no-save-state --output /tmp/test-inject.json

# Inspect the output
cat /tmp/test-inject.json | jq .

# Test extraction without applying
cleo sync --extract --dry-run /tmp/test-inject.json
```

### Full Cycle Example

```bash
# 1. Session start
cleo session start
cleo focus set T042

# 2. Inject to TodoWrite
cleo sync --inject --output /tmp/session.json
# Use this JSON to populate TodoWrite

# 3. Work in Claude Code session...
# (Claude uses TodoWrite, marks tasks complete, adds new tasks)

# 4. Export TodoWrite state to file (manually or via hook)

# 5. Extract changes
cleo sync --extract /tmp/todowrite-final.json

# 6. Session end
cleo session end
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
cleo sync --inject --phase polish
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
cleo sync --inject --no-save-state --output /tmp/test.json
```

**Behavior:**
- Skips creating `.cleo/sync/todowrite-session.json`
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
cleo sync --status  # Verify stale state
cleo sync --clear   # Remove without merging
```

**Behavior:**
- Deletes `.cleo/sync/todowrite-session.json`
- Does NOT apply changes from TodoWrite
- Safe to run (no data loss in cleo)

## Status Mapping

| cleo | → TodoWrite | TodoWrite | → cleo |
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

Injection creates a state file at `.cleo/sync/todowrite-session.json`:

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
