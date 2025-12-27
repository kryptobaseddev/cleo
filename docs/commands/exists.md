# exists Command

Check if a task ID exists without listing all tasks, with clean exit codes for scripting and CI/CD integration.

## Usage

```bash
cleo exists <task-id> [OPTIONS]
```

## Description

The `exists` command provides a fast, lightweight way to verify whether a specific task ID exists in the system. Unlike `list` or `show`, it returns only a boolean result with appropriate exit codes, making it ideal for shell scripts, CI/CD pipelines, and automation workflows.

This command is particularly useful for:
- Validating task IDs before operations in scripts
- CI/CD pipeline conditional logic based on task presence
- Pre-flight checks before task updates or completions
- Automated workflow decision trees
- Quick existence verification without parsing full task lists

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<task-id>` | Yes | Task ID to check (e.g., T001, T042) |

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--quiet` | `-q` | No output, exit code only (for scripting) | `false` |
| `--verbose` | `-v` | Show which file contains the task | `false` |
| `--include-archive` | `-a` | Search archive file in addition to active tasks | `false` |
| `--format json` | `-f json` | JSON output with metadata | `text` |
| `--help` | `-h` | Show help message | |

## Exit Codes

| Code | Meaning | Description |
|------|---------|-------------|
| `0` | Success | Task exists |
| `1` | Not found | Task does not exist |
| `2` | Invalid input | Invalid task ID format |
| `3` | System error | File read error or system failure |

Exit codes enable reliable conditional logic in scripts:

```bash
if cleo exists T001 --quiet; then
  echo "Task exists"
else
  echo "Task not found"
fi
```

## Examples

### Basic Existence Check

```bash
# Check if task exists (active tasks only)
cleo exists T001
```

Output (task exists):
```
✓ Task T001 exists
```

Output (task not found):
```
✗ Task T001 not found
```

Exit code: `0` (exists) or `1` (not found)

### Quiet Mode for Scripting

```bash
# No output, exit code only
cleo exists T001 --quiet
```

No output. Check exit code:
- `0` = exists
- `1` = not found
- `2` = invalid ID format
- `3` = file read error

**Use case**: Conditional script logic without parsing output

```bash
if cleo exists T042 --quiet; then
  cleo update T042 --priority high
else
  echo "Task T042 not found, skipping update"
fi
```

### Verbose Mode

```bash
# Show which file contains the task
cleo exists T001 --verbose
```

Output (active task):
```
✓ Task T001 exists
  Location: .cleo/todo.json (active tasks)
  Status: pending
  Title: Implement user authentication
```

Output (archived task with `--include-archive`):
```
✓ Task T001 exists
  Location: .cleo/todo-archive.json (archived tasks)
  Status: done
  Title: Setup project structure
```

### Include Archive

```bash
# Search both active and archived tasks
cleo exists T001 --include-archive
```

Without `--include-archive`:
- Searches only `todo.json` (active tasks)
- Returns not found if task is archived

With `--include-archive`:
- Searches both `todo.json` and `todo-archive.json`
- Returns exists if found in either file

**Use case**: Verify task ID hasn't been reused across active and archive

### JSON Output

```bash
# Machine-readable format with metadata
cleo exists T001 --format json
```

Output structure (task exists):
```json
{
  "_meta": {
    "version": "2.1.0",
    "timestamp": "2025-12-15T10:00:00Z",
    "command": "exists",
    "taskId": "T001"
  },
  "exists": true,
  "location": "todo.json",
  "task": {
    "id": "T001",
    "title": "Implement user authentication",
    "status": "pending",
    "priority": "high",
    "createdAt": "2025-12-10T10:00:00Z"
  }
}
```

Output structure (task not found):
```json
{
  "_meta": {
    "version": "2.1.0",
    "timestamp": "2025-12-15T10:00:00Z",
    "command": "exists",
    "taskId": "T999"
  },
  "exists": false,
  "location": null,
  "task": null
}
```

**Parse with jq**:
```bash
# Extract exists boolean
cleo exists T001 --format json | jq -r '.exists'
# Output: true or false

# Get task location if exists
cleo exists T001 --format json | jq -r '.location // "not found"'
```

### Combined Options

```bash
# Verbose JSON output including archive
cleo exists T001 --verbose --format json --include-archive
```

## Use Cases

### Pre-Flight Validation

```bash
# Validate task ID before bulk update
if cleo exists T042 --quiet; then
  cleo update T042 \
    --priority critical \
    --labels urgent,security \
    --notes "Escalated due to security concern"
else
  echo "ERROR: Task T042 not found"
  exit 1
fi
```

### CI/CD Pipeline Conditional Logic

```yaml
# GitHub Actions example
- name: Check if task exists
  id: check-task
  run: |
    if cleo exists ${{ env.TASK_ID }} --quiet; then
      echo "exists=true" >> $GITHUB_OUTPUT
    else
      echo "exists=false" >> $GITHUB_OUTPUT
    fi

- name: Update task (conditional)
  if: steps.check-task.outputs.exists == 'true'
  run: cleo update ${{ env.TASK_ID }} --status done
```

### Task ID Validation Loop

```bash
# Validate multiple task IDs
TASK_IDS=("T001" "T002" "T003" "T042")

for task_id in "${TASK_IDS[@]}"; do
  if cleo exists "$task_id" --quiet; then
    echo "✓ $task_id exists"
  else
    echo "✗ $task_id missing"
  fi
done
```

### Dependency Chain Verification

```bash
# Verify all dependencies exist before adding dependent task
DEPENDENCIES=("T001" "T002" "T005")
ALL_EXIST=true

for dep_id in "${DEPENDENCIES[@]}"; do
  if ! cleo exists "$dep_id" --quiet; then
    echo "ERROR: Dependency $dep_id not found"
    ALL_EXIST=false
  fi
done

if $ALL_EXIST; then
  cleo add "Integration test" --depends T001,T002,T005
else
  echo "Cannot add task: missing dependencies"
  exit 1
fi
```

### Archive Search

```bash
# Check if task was completed and archived
if cleo exists T001 --include-archive --quiet; then
  # Check where it exists
  LOCATION=$(cleo exists T001 --include-archive --format json | \
    jq -r '.location')

  if [[ "$LOCATION" == "todo-archive.json" ]]; then
    echo "Task T001 is archived (completed)"
  else
    echo "Task T001 is active"
  fi
else
  echo "Task T001 never existed"
fi
```

### ID Collision Prevention

```bash
# Before manually creating task with specific ID, verify it's unique
NEW_ID="T100"

if cleo exists "$NEW_ID" --include-archive --quiet; then
  echo "ERROR: Task ID $NEW_ID already exists"
  exit 1
else
  echo "✓ Task ID $NEW_ID is available"
  # Safe to create task with this ID
fi
```

### Integration with Other Commands

```bash
# Safe update wrapper
safe_update() {
  local task_id="$1"
  shift

  if cleo exists "$task_id" --quiet; then
    cleo update "$task_id" "$@"
  else
    echo "ERROR: Cannot update non-existent task: $task_id" >&2
    return 1
  fi
}

# Usage
safe_update T001 --priority high
```

## Error Handling

### Invalid Task ID Format

```bash
# Invalid ID format
cleo exists INVALID
```

Output:
```
ERROR: Invalid task ID format: INVALID
Expected format: T followed by digits (e.g., T001, T042)
```

Exit code: `2`

Valid task ID formats:
- `T001` - Standard format
- `T042` - Any numeric suffix
- `T1` - Single digit allowed
- Case sensitive: must be uppercase `T`

Invalid formats:
- `t001` - lowercase not allowed
- `001` - missing T prefix
- `TASK001` - wrong prefix
- `T` - missing number

### File Read Errors

```bash
# If todo.json is missing or unreadable
cleo exists T001
```

Output:
```
ERROR: Cannot read todo.json
Check file exists and has correct permissions
```

Exit code: `3`

**Recovery**:
```bash
# Verify file exists
ls -la .cleo/todo.json

# Check permissions
chmod 644 .cleo/todo.json

# Validate JSON
cleo validate
```

### System Error Handling

```bash
# Robust script with full error handling
check_task_exists() {
  local task_id="$1"
  local exit_code

  cleo exists "$task_id" --quiet
  exit_code=$?

  case $exit_code in
    0)
      echo "Task exists"
      return 0
      ;;
    1)
      echo "Task not found"
      return 1
      ;;
    2)
      echo "ERROR: Invalid task ID format: $task_id" >&2
      return 2
      ;;
    3)
      echo "ERROR: System error reading task files" >&2
      return 3
      ;;
    *)
      echo "ERROR: Unexpected exit code: $exit_code" >&2
      return 255
      ;;
  esac
}

# Usage
if check_task_exists "T001"; then
  # Task exists, proceed
  cleo focus set T001
fi
```

## Automation Examples

### Pre-Commit Hook

```bash
#!/usr/bin/env bash
# .git/hooks/pre-commit

# Extract task IDs from commit message
TASK_IDS=$(git log -1 --pretty=%B | grep -oE 'T[0-9]+' | sort -u)

# Validate all referenced tasks exist
MISSING_TASKS=()
for task_id in $TASK_IDS; do
  if ! cleo exists "$task_id" --quiet; then
    MISSING_TASKS+=("$task_id")
  fi
done

# Fail commit if tasks don't exist
if [[ ${#MISSING_TASKS[@]} -gt 0 ]]; then
  echo "ERROR: Commit references non-existent tasks: ${MISSING_TASKS[*]}"
  echo "Please verify task IDs or create missing tasks"
  exit 1
fi
```

### Task Status Checker

```bash
#!/usr/bin/env bash
# check-task-status.sh - Show status of multiple tasks

TASK_IDS=("$@")

for task_id in "${TASK_IDS[@]}"; do
  if cleo exists "$task_id" --quiet; then
    # Get detailed info
    TASK_INFO=$(cleo exists "$task_id" --verbose --format json)
    STATUS=$(echo "$TASK_INFO" | jq -r '.task.status')
    TITLE=$(echo "$TASK_INFO" | jq -r '.task.title')
    echo "[$task_id] $STATUS - $TITLE"
  else
    echo "[$task_id] NOT FOUND"
  fi
done
```

Usage:
```bash
./check-task-status.sh T001 T002 T042 T999
```

### Bulk Validation Script

```bash
#!/usr/bin/env bash
# validate-task-refs.sh - Validate task references in files

# Find all task ID references in markdown files
TASK_REFS=$(grep -hroE 'T[0-9]+' docs/*.md | sort -u)

echo "Validating task references in documentation..."

INVALID_COUNT=0
for task_id in $TASK_REFS; do
  if ! cleo exists "$task_id" --include-archive --quiet; then
    echo "⚠ Invalid reference: $task_id"
    INVALID_COUNT=$((INVALID_COUNT + 1))
  fi
done

if [[ $INVALID_COUNT -eq 0 ]]; then
  echo "✓ All task references valid"
  exit 0
else
  echo "✗ Found $INVALID_COUNT invalid task references"
  exit 1
fi
```

### Monitoring Script

```bash
#!/usr/bin/env bash
# monitor-critical-tasks.sh

CRITICAL_TASKS=("T001" "T005" "T012")

echo "Monitoring critical tasks..."

for task_id in "${CRITICAL_TASKS[@]}"; do
  if cleo exists "$task_id" --quiet; then
    TASK_JSON=$(cleo exists "$task_id" --format json)
    STATUS=$(echo "$TASK_JSON" | jq -r '.task.status')

    if [[ "$STATUS" != "done" ]]; then
      echo "⚠ ALERT: Critical task $task_id not complete (status: $STATUS)"
      # Send alert (Slack, email, etc.)
    fi
  else
    echo "⚠ ALERT: Critical task $task_id not found"
  fi
done
```

## Performance Considerations

The `exists` command is optimized for speed:

- **Fast lookup**: O(n) linear search through task arrays
- **Early exit**: Stops searching once task is found
- **Minimal output**: No full task list generation
- **JSON streaming**: Uses jq for efficient JSON parsing

Benchmark (approximate):
- 10 tasks: <10ms
- 100 tasks: <50ms
- 1000 tasks: <200ms

**Performance tips**:
1. Use `--quiet` to skip output formatting
2. Avoid `--include-archive` if you know task is active
3. Batch checks in scripts rather than checking one-by-one in tight loops
4. Use `--format json` only when you need full task metadata

## Comparison with Other Commands

| Command | Purpose | Output | Exit Code | Speed |
|---------|---------|--------|-----------|-------|
| `exists T001` | Check if task exists | Boolean result | Meaningful | Fast |
| `list \| grep T001` | Find task in list | Full task details | Not meaningful | Slow |
| `show T001` | Display task details | Full task with metadata | Error on missing | Medium |
| `list --format json` | Get all tasks | Complete task list | Always 0 | Slowest |

**Use `exists` when**:
- You only need to know if task exists
- Writing shell scripts with conditional logic
- Validating input before operations
- Implementing CI/CD pipeline checks

**Use `show` when**:
- You need full task details
- Viewing task for human consumption
- Debugging task state

## Related Commands

- `cleo show ID` - Display full task details
- `cleo list` - List all tasks with filtering
- `cleo validate` - Validate all JSON files and task IDs
- `cleo update ID` - Update task (validates existence automatically)
- `cleo complete ID` - Complete task (validates existence automatically)

## Tips

1. **Use Quiet Mode in Scripts**: Always use `--quiet` in scripts to rely on exit codes
2. **Validate Before Operations**: Check existence before update/complete operations
3. **Include Archive When Needed**: Use `--include-archive` to search historical tasks
4. **Leverage Exit Codes**: Design scripts around the 4-level exit code system
5. **Combine with jq**: Use `--format json` with jq for complex conditional logic
6. **Error Handling**: Always handle exit codes 2 and 3 (errors) in production scripts
7. **Batch Validation**: Validate multiple tasks in a single script rather than calling exists repeatedly
8. **Document Dependencies**: Use exists checks to validate dependency chains

## Best Practices

### Script Template

```bash
#!/usr/bin/env bash
# task-operation-template.sh

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Configuration
TASK_ID="${1:-}"

# Validation
if [[ -z "$TASK_ID" ]]; then
  echo "ERROR: Task ID required" >&2
  exit 1
fi

# Check task exists
if ! cleo exists "$TASK_ID" --quiet; then
  echo "ERROR: Task $TASK_ID not found" >&2
  exit 1
fi

# Perform operation
echo "Processing task $TASK_ID..."
cleo update "$TASK_ID" --priority high

echo "✓ Task updated successfully"
```

### CI/CD Integration Pattern

```bash
# Validate task before marking complete
- name: Validate and complete task
  run: |
    set -e
    TASK_ID="T${GITHUB_RUN_NUMBER}"

    # Check exists with proper error handling
    if cleo exists "$TASK_ID" --quiet; then
      cleo complete "$TASK_ID" --notes "Completed by CI run $GITHUB_RUN_NUMBER"
      echo "✓ Task $TASK_ID completed"
    else
      echo "⚠ Task $TASK_ID not found, skipping"
      # Don't fail pipeline - task might not exist yet
    fi
```

## Version History

- **v0.10.2**: Initial implementation of exists command
- Added exit code system (0/1/2/3)
- Implemented quiet, verbose, and JSON output modes
- Added archive search support with `--include-archive`

## Security Considerations

The `exists` command is read-only and safe for automated use:

- **No data modification**: Only reads task files
- **No sensitive data exposure**: Returns only boolean existence or minimal task metadata
- **Safe in CI/CD**: No risk of data corruption from parallel execution
- **Exit code reliability**: Consistent exit codes for automation trust

**Recommendations**:
- Safe to use in pre-commit hooks
- Safe for parallel execution in CI/CD
- No special permissions required beyond read access to `.cleo/`
- Can be used in untrusted scripts (read-only operation)
