# show Command

Display detailed view of a single task with all fields, dependencies, and related information.

## Usage

```bash
cleo show <task-id> [OPTIONS]
```

## Description

The `show` command provides a comprehensive view of a single task, displaying all available fields and contextual information. This is the recommended way to inspect task details rather than parsing JSON output manually.

This command is ideal for:
- Viewing full task description and notes
- Understanding dependency relationships (what this task blocks/is blocked by)
- Reviewing task history and activity
- Finding related tasks by shared labels
- Quick task inspection during development

## Arguments

| Argument | Description |
|----------|-------------|
| `<task-id>` | Task ID to display (e.g., T001, T042) |

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--format FORMAT` | `-f` | Output format: `text` or `json` | `text` |
| `--include-archive` | | Search archive if not found in active tasks | `false` |
| `--history` | | Show task history from log (last 10 entries) | `false` |
| `--related` | | Show related tasks (same labels, max 5) | `false` |
| `--help` | `-h` | Show help message | |

## Exit Codes

| Code | Meaning | Use Case |
|------|---------|----------|
| `0` | Success | Task found and displayed |
| `1` | Task not found | ID doesn't exist |
| `2` | Invalid task ID format | Malformed ID (not T###) |
| `3` | File read error | System/permission error |

## Examples

### Basic Usage

```bash
# Show task details
cleo show T001

# Show with task history
cleo show T001 --history

# Show related tasks by labels
cleo show T001 --related

# Combine options
cleo show T001 --history --related
```

### Search Archive

```bash
# Search archived tasks too
cleo show T050 --include-archive
```

### JSON Output

```bash
# Get JSON for scripting
cleo show T001 --format json

# Extract specific field
cleo show T001 -f json | jq '.description'

# Get all notes
cleo show T001 -f json | jq '.notes[]'
```

## Sample Output

### Text Format

```
╭─────────────────────────────────────────────────────────────────╮
│  T204 ○ [high]
│  FEATURE: Multi-Phase Consensus Research Framework Plugin
├─────────────────────────────────────────────────────────────────┤
│  Status:      pending
│  Priority:    high
│  Phase:       setup
│  Labels:      consensus-framework, feature-request, future, plugin
│  Created:     2025-12-15
├─────────────────────────────────────────────────────────────────┤
│  Description
│    Build a reusable plugin/command for cleo that
│    implements the Multi-Phase Consensus Research Framework.
│    This would be a programmatically callable tool with
│    prompt-style instructions for any project...
├─────────────────────────────────────────────────────────────────┤
│  Blocking (tasks that depend on this)
│    → T215: T204.1: Configuration Schema Design
│    → T216: T204.2: Parameterized Prompt Templates
│    → T217: T204.3: State Management Design
├─────────────────────────────────────────────────────────────────┤
│  Notes (6)
│    • 2025-12-15 04:33:49 UTC: DOCS: claudedocs/CONSENSUS-...
│    • 2025-12-15 05:01:35 UTC: ASSESSMENT: Current spec...
│    • 2025-12-15 05:01:42 UTC: SUFFICIENT: Process structure...
│    ... and 3 more
├─────────────────────────────────────────────────────────────────┤
│  Files
│    claudedocs/CONSENSUS-FRAMEWORK-SPEC.md
╰─────────────────────────────────────────────────────────────────╯
```

### JSON Format

```json
{
  "id": "T204",
  "title": "FEATURE: Multi-Phase Consensus Research Framework Plugin",
  "status": "pending",
  "priority": "high",
  "phase": "setup",
  "createdAt": "2025-12-15T04:30:21Z",
  "description": "Build a reusable plugin/command...",
  "labels": ["consensus-framework", "feature-request", "future", "plugin"],
  "notes": ["2025-12-15 04:33:49 UTC: DOCS: ..."],
  "files": ["claudedocs/CONSENSUS-FRAMEWORK-SPEC.md"],
  "_source": "active",
  "_dependents": [
    "T215: T204.1: Configuration Schema Design",
    "T216: T204.2: Parameterized Prompt Templates"
  ]
}
```

## Task Fields Displayed

| Field | Description |
|-------|-------------|
| `id` | Task identifier (T###) |
| `title` | Task title/summary |
| `status` | pending, active, blocked, done |
| `priority` | critical, high, medium, low |
| `phase` | Project phase (setup, core, polish) |
| `labels` | Tags/categories |
| `createdAt` | Creation timestamp |
| `completedAt` | Completion timestamp (if done) |
| `description` | Full task description |
| `depends` | Tasks this depends on |
| `blockedBy` | Reason for blocked status |
| `notes` | Timestamped progress notes |
| `files` | Associated file references |
| `acceptance` | Acceptance criteria list |

## Additional Context (with flags)

| Flag | Additional Data |
|------|-----------------|
| `--history` | Log entries for this task (last 10) |
| `--related` | Other tasks sharing same labels (max 5) |
| (always) | Tasks that depend on this one (blocking) |

## Use Cases

### Quick Task Inspection

```bash
# What exactly is T042 about?
cleo show T042
```

### Understanding Dependencies

```bash
# What blocks T050 and what does T050 block?
cleo show T050
# Shows: Depends On (what this needs) and Blocking (what needs this)
```

### Reviewing Progress

```bash
# See all notes and history for a task
cleo show T001 --history
```

### Finding Context

```bash
# What other tasks are related to this one?
cleo show T001 --related
```

### Scripting

```bash
# Check if task has acceptance criteria
if cleo show T001 -f json | jq -e '.acceptance | length > 0' > /dev/null; then
  echo "Task has acceptance criteria"
fi

# Get task description for AI processing
DESCRIPTION=$(cleo show T001 -f json | jq -r '.description')
```

## Related Commands

- `list` - View multiple tasks in summary format
- `exists` - Quick check if task ID exists
- `deps` - Dependency tree visualization
- `update` - Modify task fields

## See Also

- [List Command](../usage.md#list-tasks) - Multiple task listing
- [Exists Command](exists.md) - Task existence validation
- [Dependencies](deps.md) - Dependency visualization
