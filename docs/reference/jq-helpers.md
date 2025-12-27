# jq-helpers Library Reference

**Location**: `lib/jq-helpers.sh`
**Layer**: 1 (Core Infrastructure)
**Dependencies**: none
**Function Count**: 14

## Overview

Reusable jq wrapper functions for common task operations. Provides a consistent API for JSON manipulation with proper error handling and input validation.

This library centralizes all jq operations to ensure:
- Consistent error handling across the codebase
- Input validation for all parameters
- Standardized return codes
- Reduced duplication of jq patterns

## Functions

### Task Field Operations

#### get_task_field

Extract a field from a task JSON object.

```bash
get_task_field "$task_json" "field_name"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `task_json` | string | Yes | JSON string representing a task object |
| `field_name` | string | Yes | Name of the field to extract |

**Output**: Field value (raw string), empty if field not found

**Example**:
```bash
task='{"id":"T001","title":"Example","status":"pending"}'
title=$(get_task_field "$task" "title")
echo "$title"  # Output: Example
```

---

#### get_task_by_id

Get a single task by ID from a todo file.

```bash
get_task_by_id "T001" "$TODO_FILE"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `task_id` | string | Yes | Task ID to find (e.g., T001) |
| `todo_file` | string | Yes | Path to todo.json file |

**Output**: Task JSON object, empty if not found

**Example**:
```bash
task=$(get_task_by_id "T001" "$TODO_FILE")
if [[ -n "$task" ]]; then
    echo "Found task: $(get_task_field "$task" "title")"
fi
```

---

#### task_exists

Check if a task exists by ID.

```bash
task_exists "T001" "$TODO_FILE" && echo "exists"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `task_id` | string | Yes | Task ID to check |
| `todo_file` | string | Yes | Path to todo.json file |

**Returns**: Exit code 0 if task exists, 1 if not found

**Example**:
```bash
if task_exists "$TASK_ID" "$TODO_FILE"; then
    echo "Task $TASK_ID exists"
else
    echo "Task $TASK_ID not found"
fi
```

---

### Task Filtering

#### get_tasks_by_status

Filter tasks by status.

```bash
get_tasks_by_status "pending" "$TODO_FILE"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `status` | string | Yes | Task status (pending\|active\|blocked\|done) |
| `todo_file` | string | Yes | Path to todo.json file |

**Output**: JSON array of matching tasks

**Example**:
```bash
pending_tasks=$(get_tasks_by_status "pending" "$TODO_FILE")
count=$(echo "$pending_tasks" | jq 'length')
echo "Found $count pending tasks"
```

---

#### get_task_with_field

Filter tasks by any field=value match.

```bash
get_task_with_field "priority" "high" "$TODO_FILE"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `field` | string | Yes | Field name (e.g., status, priority, phase, type) |
| `value` | string | Yes | Value to match |
| `todo_file` | string | Yes | Path to todo.json file |

**Output**: JSON array of matching tasks

**Example**:
```bash
# Get all high-priority tasks
high_priority=$(get_task_with_field "priority" "high" "$TODO_FILE")

# Get all epic-type tasks
epics=$(get_task_with_field "type" "epic" "$TODO_FILE")
```

---

#### filter_tasks_multi

Filter tasks with multiple AND conditions.

```bash
filter_tasks_multi "$TODO_FILE" "status=pending" "priority=high"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `todo_file` | string | Yes | Path to todo.json file |
| `pairs...` | string | Yes | One or more field=value pairs |

**Output**: JSON array of tasks matching ALL conditions

**Example**:
```bash
# Get pending high-priority tasks
tasks=$(filter_tasks_multi "$TODO_FILE" "status=pending" "priority=high")

# Get core phase epics
core_epics=$(filter_tasks_multi "$TODO_FILE" "phase=core" "type=epic")

# Complex filter: pending tasks in testing phase with critical priority
critical=$(filter_tasks_multi "$TODO_FILE" \
    "status=pending" \
    "phase=testing" \
    "priority=critical")
```

---

#### get_phase_tasks

Filter tasks by phase.

```bash
get_phase_tasks "core" "$TODO_FILE"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `phase` | string | Yes | Phase slug (e.g., setup, core, testing, polish) |
| `todo_file` | string | Yes | Path to todo.json file |

**Output**: JSON array of matching tasks

**Example**:
```bash
core_tasks=$(get_phase_tasks "core" "$TODO_FILE")
echo "Core phase has $(echo "$core_tasks" | jq 'length') tasks"
```

---

### Counting Operations

#### count_tasks_by_status

Count tasks with given status.

```bash
count_tasks_by_status "pending" "$TODO_FILE"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `status` | string | Yes | Task status to count |
| `todo_file` | string | Yes | Path to todo.json file |

**Output**: Integer count

**Example**:
```bash
pending=$(count_tasks_by_status "pending" "$TODO_FILE")
done=$(count_tasks_by_status "done" "$TODO_FILE")
echo "Progress: $done done, $pending pending"
```

---

#### get_task_count

Get total task count.

```bash
get_task_count "$TODO_FILE"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `todo_file` | string | Yes | Path to todo.json file |

**Output**: Integer count of all tasks

**Example**:
```bash
total=$(get_task_count "$TODO_FILE")
echo "Total tasks: $total"
```

---

### Hierarchy Operations

#### has_children

Check if task has children.

```bash
has_children "T001" "$TODO_FILE" && echo "has children"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `task_id` | string | Yes | Task ID to check |
| `todo_file` | string | Yes | Path to todo.json file |

**Returns**: Exit code 0 if task has children, 1 otherwise

**Notes**: Checks for tasks where `parentId` matches the given task_id.

**Example**:
```bash
if has_children "$TASK_ID" "$TODO_FILE"; then
    echo "Cannot delete: task has children"
    exit 1
fi
```

---

### Metadata Operations

#### get_focus_task

Get current focus task ID.

```bash
get_focus_task "$TODO_FILE"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `todo_file` | string | Yes | Path to todo.json file |

**Output**: Task ID string, empty if no focus set

**Example**:
```bash
focus=$(get_focus_task "$TODO_FILE")
if [[ -n "$focus" ]]; then
    echo "Currently focused on: $focus"
else
    echo "No focus set"
fi
```

---

#### get_current_phase

Get current project phase.

```bash
get_current_phase "$TODO_FILE"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `todo_file` | string | Yes | Path to todo.json file |

**Output**: Phase slug string, empty if no phase set

**Example**:
```bash
phase=$(get_current_phase "$TODO_FILE")
echo "Current project phase: ${phase:-not set}"
```

---

#### get_all_task_ids

Get all task IDs from todo file.

```bash
get_all_task_ids "$TODO_FILE"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `todo_file` | string | Yes | Path to todo.json file |

**Output**: Task IDs, one per line

**Example**:
```bash
# Iterate over all task IDs
while IFS= read -r task_id; do
    echo "Processing $task_id"
done < <(get_all_task_ids "$TODO_FILE")

# Count total tasks
total=$(get_all_task_ids "$TODO_FILE" | wc -l)
```

---

### Utility Operations

#### array_to_json

Convert bash array to JSON array.

```bash
array_to_json "item1" "item2" "item3"
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `@` | strings | No | Array elements to convert |

**Output**: JSON array string

**Notes**: Trims leading/trailing whitespace from each element.

**Example**:
```bash
# Convert labels to JSON array
labels=("bug" "security" "urgent")
json_labels=$(array_to_json "${labels[@]}")
echo "$json_labels"  # Output: ["bug","security","urgent"]

# Empty array
empty=$(array_to_json)
echo "$empty"  # Output: []
```

---

## Return Codes

All functions follow consistent return code conventions:

| Code | Meaning | Description |
|------|---------|-------------|
| 0 | Success | Operation completed successfully |
| 1 | Invalid arguments | Missing or invalid input parameters |
| 2 | File not found | Specified todo file does not exist |

---

## Usage in Scripts

### Basic Pattern

```bash
#!/usr/bin/env bash
source "$LIB_DIR/jq-helpers.sh"

# Validate task exists before operations
if ! task_exists "$TASK_ID" "$TODO_FILE"; then
    echo "Error: Task $TASK_ID not found" >&2
    exit 1
fi

# Get task data
task=$(get_task_by_id "$TASK_ID" "$TODO_FILE")
title=$(get_task_field "$task" "title")
status=$(get_task_field "$task" "status")

echo "Task: $title ($status)"
```

### Filtering Pattern

```bash
source "$LIB_DIR/jq-helpers.sh"

# Get pending tasks with high priority
tasks=$(filter_tasks_multi "$TODO_FILE" "status=pending" "priority=high")

# Process each task
echo "$tasks" | jq -c '.[]' | while IFS= read -r task; do
    id=$(get_task_field "$task" "id")
    title=$(get_task_field "$task" "title")
    echo "[$id] $title"
done
```

### Status Reporting Pattern

```bash
source "$LIB_DIR/jq-helpers.sh"

# Generate status summary
echo "Task Status Summary"
echo "==================="
echo "Pending: $(count_tasks_by_status "pending" "$TODO_FILE")"
echo "Active:  $(count_tasks_by_status "active" "$TODO_FILE")"
echo "Blocked: $(count_tasks_by_status "blocked" "$TODO_FILE")"
echo "Done:    $(count_tasks_by_status "done" "$TODO_FILE")"
echo "Total:   $(get_task_count "$TODO_FILE")"
```

### Hierarchy Check Pattern

```bash
source "$LIB_DIR/jq-helpers.sh"

# Prevent deletion of tasks with children
if has_children "$TASK_ID" "$TODO_FILE"; then
    echo "Error: Cannot delete task with children" >&2
    echo "Use --children cascade to delete children too" >&2
    exit 16  # EXIT_HAS_CHILDREN
fi
```

---

## Best Practices

1. **Always validate existence first**: Use `task_exists` before operations that assume a task exists.

2. **Use filter functions over raw jq**: Prefer library functions for consistent error handling.

3. **Handle empty results**: Functions return empty strings/arrays when no matches found.

4. **Check return codes**: All functions use standard return codes for error handling.

5. **Source once per script**: The library uses source guards to prevent double-loading.

---

## See Also

- [Architecture Documentation](/mnt/projects/cleo/docs/architecture/ARCHITECTURE.md) - System design overview
- [Schema Reference](/mnt/projects/cleo/docs/architecture/SCHEMAS.md) - Task JSON structure
- [File Operations Library](/mnt/projects/cleo/lib/file-ops.sh) - Atomic write patterns
