# update Command

**Alias**: `edit`

Update existing task fields with validation and logging.

## Usage

```bash
cleo update TASK_ID [OPTIONS]
```

## Description

The `update` command modifies an existing task's fields. It supports both scalar fields (title, status, priority) and array fields (labels, files, dependencies) with append, replace, or clear operations.

Completed tasks (`status: done`) are immutable and cannot be updated.

## Arguments

| Argument | Description | Required |
|----------|-------------|----------|
| `TASK_ID` | Task ID to update (e.g., T001) | Yes |

## Scalar Field Options

| Option | Short | Description |
|--------|-------|-------------|
| `--title TEXT` | `-t` | Update task title |
| `--status STATUS` | `-s` | Change status: `pending`, `active`, `blocked` |
| `--priority PRIORITY` | `-p` | Update priority: `critical`, `high`, `medium`, `low` |
| `--description DESC` | `-d` | Update description |
| `--phase PHASE` | `-P` | Update phase slug |
| `--add-phase` | | Create new phase if it doesn't exist |
| `--blocked-by REASON` | | Set blocked reason (status becomes blocked) |

## Array Field Options

Array fields support three operations:

| Operation | Behavior |
|-----------|----------|
| Append (default) | Add to existing array |
| Set | Replace entire array |
| Clear | Remove all items |

### Labels

| Option | Description |
|--------|-------------|
| `--labels LABELS` | `-l` | Append comma-separated labels |
| `--set-labels LABELS` | Replace all labels |
| `--clear-labels` | Remove all labels |

### Files

| Option | Description |
|--------|-------------|
| `--files FILES` | `-f` | Append comma-separated file paths |
| `--set-files FILES` | Replace all files |
| `--clear-files` | Remove all files |

### Acceptance Criteria

| Option | Description |
|--------|-------------|
| `--acceptance CRIT` | Append comma-separated criteria |
| `--set-acceptance CRIT` | Replace all criteria |
| `--clear-acceptance` | Remove all criteria |

### Dependencies

| Option | Description |
|--------|-------------|
| `--depends IDS` | Append comma-separated task IDs |
| `--set-depends IDS` | Replace all dependencies |
| `--clear-depends` | Remove all dependencies |

### Notes

| Option | Short | Description |
|--------|-------|-------------|
| `--notes NOTE` | `-n` | Add timestamped note (always appends) |

## Examples

### Scalar Field Updates

```bash
# Update priority
cleo update T001 --priority high

# Update status
cleo update T002 --status active

# Update title
cleo update T003 --title "New improved title"

# Set blocked with reason
cleo update T004 --blocked-by "Waiting for API spec"
```

### Array Operations

```bash
# Append labels
cleo update T001 --labels bug,urgent

# Replace all labels
cleo update T002 --set-labels "frontend,ui"

# Clear labels
cleo update T003 --clear-labels

# Add dependencies
cleo update T004 --depends T001,T002

# Replace dependencies
cleo update T005 --set-depends T003
```

### Phase Management

```bash
# Change to existing phase
cleo update T001 --phase core

# Create new phase
cleo update T002 --phase optimization --add-phase
```

### Adding Notes

```bash
# Add progress note
cleo update T001 --notes "Started implementation"

# Notes are timestamped automatically:
# "2025-12-13 10:00:00 UTC: Started implementation"
```

### Combined Updates

```bash
# Multiple updates at once
cleo update T001 \
  --priority high \
  --labels urgent,backend \
  --notes "Escalated per client request"
```

## Output

```
[INFO] Task T001 updated successfully

Task ID: T001
Changes:
  - priority: medium -> high
  - labels: added [urgent, backend]
  - notes: added entry

View with: jq '.tasks[] | select(.id == "T001")' .cleo/todo.json
```

## Validation Rules

| Rule | Error |
|------|-------|
| Task not found | Task ID does not exist |
| Task completed | Cannot update done tasks |
| Invalid status | Must be `pending`, `active`, `blocked` |
| Invalid priority | Must be `critical`, `high`, `medium`, `low` |
| Dependency not found | Referenced task must exist |
| Self-dependency | Task cannot depend on itself |
| Circular dependency | Would create dependency cycle |
| Single active | Only one task can be active |

## Exit Codes

| Code | Meaning | Recoverable |
|------|---------|:-----------:|
| `0` | Success | N/A |
| `1` | General error (invalid arguments or unknown options) | No |
| `2` | Invalid argument value | No |
| `3` | File operation failure | No |
| `4` | Task not found | No |
| `6` | Validation failure (schema, circular dependency, etc.) | No |
| `7` | Lock timeout | **Yes** |
| `10` | Parent task not found | No |
| `11` | Max hierarchy depth exceeded (max 3 levels) | No |
| `12` | Max siblings exceeded (configurable, default unlimited) | No |
| `13` | Invalid parent type (subtasks cannot have children) | No |
| `20` | Checksum mismatch | **Yes** |
| `102` | No change (idempotent operation) | N/A |

### Idempotency (Exit Code 102)

The update command is idempotent. When updating with identical values, it returns:
- Exit code: `102` (EXIT_NO_CHANGE)
- JSON: `{"success": true, "noChange": true, "message": "..."}`

LLM agents **SHOULD** treat exit code 102 as success without retry.

See [Exit Codes Reference](../reference/exit-codes.md) for full retry protocol.

## See Also

- [add](add.md) - Create tasks
- [complete](complete.md) - Mark tasks done
- [list](list.md) - View tasks
- [focus](focus.md) - Set active task
