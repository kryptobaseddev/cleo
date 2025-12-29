# add Command

**Alias**: `new`

Add a new task to the todo system with validation and logging.

## Usage

```bash
cleo add "Task Title" [OPTIONS]
```

## Description

The `add` command creates a new task in `todo.json` with automatic ID generation, validation, and audit logging. Tasks require an action-oriented title and can include optional metadata like priority, labels, dependencies, and phase assignment.

This command includes:
- Automatic unique task ID generation (T001, T002, etc.)
- File locking to prevent race conditions
- Duplicate title detection (warning only)
- Circular dependency prevention
- Phase creation with `--add-phase`

## Arguments

| Argument | Description | Required |
|----------|-------------|----------|
| `TITLE` | Task title (action-oriented, e.g., "Implement auth") | Yes |

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--status STATUS` | `-s` | Task status: `pending`, `active`, `blocked`, `done` | `pending` |
| `--priority PRIORITY` | `-p` | Priority: `critical`, `high`, `medium`, `low` | `medium` |
| `--description DESC` | `-d` | Detailed description | |
| `--labels LABELS` | `-l` | Comma-separated labels (e.g., `bug,security`) | |
| `--phase PHASE` | `-P` | Phase slug (must exist or use `--add-phase`) | |
| `--add-phase` | | Create new phase if it doesn't exist | `false` |
| `--files FILES` | | Comma-separated file paths | |
| `--acceptance CRIT` | | Comma-separated acceptance criteria | |
| `--depends IDS` | `-D` | Comma-separated task IDs (e.g., `T001,T002`) | |
| `--notes NOTE` | | Initial timestamped note | |
| `--quiet` | `-q` | Suppress messages, output only task ID | `false` |
| `--format FORMAT` | `-f` | Output format: `text`, `json` | Auto-detect |
| `--human` | | Force human-readable text output | |
| `--json` | | Force JSON output (for LLM agents) | |
| `--help` | `-h` | Show help message | |

### Hierarchy Options (v0.17.0)

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--type TYPE` | `-t` | Task type: `epic`, `task`, `subtask` | Inferred |
| `--parent ID` | | Parent task ID for hierarchy (e.g., `T001`) | `null` |
| `--size SIZE` | | Scope-based size: `small`, `medium`, `large` (NOT time) | `null` |

**Hierarchy Constraints:**
- Maximum depth: 3 levels (epic → task → subtask)
- Maximum siblings: Unlimited by default (configurable via `hierarchy.maxSiblings`)
- Subtasks cannot have children
- Type is inferred if not specified (task under epic, subtask under task)

## Examples

### Basic Task Creation

```bash
# Simple task with defaults
cleo add "Implement user authentication"

# With priority
cleo add "Fix critical login bug" -p critical

# With labels
cleo add "Add form validation" -l frontend,ui
```

### Task with Dependencies

```bash
# Task that depends on other tasks
cleo add "Deploy to production" -D T001,T002 -p high

# With phase assignment
cleo add "Write unit tests" -P testing -D T003
```

### Phase Management

```bash
# Assign to existing phase
cleo add "Design API" -P setup

# Create new phase if needed
cleo add "Performance tuning" -P optimization --add-phase
```

### Scripting and Automation

```bash
# Quiet mode - returns only task ID
TASK_ID=$(cleo add "Automated task" -q)
echo "Created task: $TASK_ID"

# With acceptance criteria
cleo add "Implement search" \
  --acceptance "Returns results in <200ms,Supports fuzzy matching"
```

### Blocked Tasks

```bash
# Create blocked task (requires description)
cleo add "Waiting for API spec" -s blocked -d "Blocked by external team"
```

### Hierarchy (v0.17.0)

```bash
# Create an epic
cleo add "User Authentication System" --type epic --size large

# Create a task under the epic
cleo add "Login endpoint" --parent T001 --size medium

# Create a subtask under the task
cleo add "Validate email format" --parent T002 --type subtask --size small

# Type is inferred based on parent
cleo add "Session management" --parent T001  # Inferred as task
```

## Output

### Standard Output

```
[INFO] Generated task ID: T042
[INFO] Task added successfully

Task ID: T042
Title: Implement user authentication
Status: pending
Priority: medium

View with: jq '.tasks[] | select(.id == "T042")' .cleo/todo.json
```

### Quiet Mode Output

```
T042
```

## Validation Rules

| Rule | Behavior |
|------|----------|
| Title required | Error if empty |
| Title length | 3-200 characters |
| Duplicate title | Warning only (not blocked) |
| Status enum | Must be `pending`, `active`, `blocked`, `done` |
| Priority enum | Must be `critical`, `high`, `medium`, `low` |
| Dependency IDs | Must exist and be in T### format |
| Circular deps | Blocked with error |
| Single active | Error if `active` status and another task is active |
| Blocked status | Requires `--description` for blocker reason |

## Exit Codes

| Code | Meaning | Recoverable |
|------|---------|:-----------:|
| `0` | Success | N/A |
| `2` | Invalid input or arguments | No |
| `3` | File operation failure | No |
| `4` | Resource not found | No |
| `5` | Missing dependency (jq) | No |
| `6` | Validation error | No |
| `7` | Lock timeout | **Yes** |
| `10` | Parent task not found | No |
| `11` | Max depth exceeded | No |
| `12` | Max siblings exceeded | No |
| `13` | Invalid parent type (subtask cannot have children) | No |
| `20` | Checksum mismatch | **Yes** |
| `22` | ID collision | **Yes** |

### Retry Protocol (for LLM Agents)

Recoverable errors (7, 20, 22) support exponential backoff retry:
- **Lock timeout (7)**: Max 3 retries, 100ms initial delay, 2x backoff
- **Checksum mismatch (20)**: Max 5 retries, 50ms initial delay, 1.5x backoff
- **ID collision (22)**: Max 3 retries, immediate retry (regenerate ID)

See [Exit Codes Reference](../reference/exit-codes.md) for full retry protocol.

## See Also

- [update](update.md) - Modify existing tasks
- [list](list.md) - View tasks
- [focus](focus.md) - Set active task
- [complete](complete.md) - Mark tasks done
