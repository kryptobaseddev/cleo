# labels Command

**Alias**: `tags` - Use `cleo tags` as shorthand for `cleo labels`

List and analyze labels (tags) across all tasks with distribution analytics and visual representations.

## Usage

```bash
cleo labels [SUBCOMMAND] [OPTIONS]
```

## Description

The `labels` command provides comprehensive label analytics for your tasks. Labels (also called tags) are used to categorize and organize tasks by feature, component, technology, or any other classification scheme.

This command helps you:
- Understand how tasks are distributed across categories
- Find all tasks related to a specific label
- Identify which labels are most active
- Detect labels with high-priority tasks
- Organize and filter your task backlog

## Subcommands

| Subcommand | Description |
|------------|-------------|
| (none) | List all labels with task counts (default) |
| `show LABEL` | Display all tasks tagged with the specified label |
| `stats` | Show detailed statistics and analytics for all labels |

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--format FORMAT` | `-f` | Output format: `text` or `json` | `text` |
| `--help` | `-h` | Show help message | |

## Examples

### List All Labels

```bash
# Show all labels with task counts
cleo labels
```

Output:
```
LABELS (8 labels, 24 tasks)

  backend        ███████████████████  14 tasks  1 critical
  frontend       ███████████████      10 tasks
  security       ██████                4 tasks  1 critical
  testing        ████                  3 tasks
  docs           ███                   2 tasks
  performance    ██                    1 task   1 critical
  ui             ██                    1 task
  database       █                     1 task
```

### Show Tasks for Specific Label

```bash
# List all tasks with the 'backend' label
cleo labels show backend
```

Output:
```
TASKS WITH LABEL: backend (14 tasks)

  ✓ [T015] Implement user authentication
  → [T023] Fix database connection pooling
  ○ [T018] Add error logging middleware
  ○ [T022] Optimize API response times
  ○ [T019] Refactor user service
  ○ [T024] Add request validation
  ... (8 more)
```

### Detailed Statistics

```bash
# Show comprehensive label analytics
cleo labels stats
```

Output:
```
LABEL STATISTICS

Total Labels: 8
Total Tagged Tasks: 24
Untagged Tasks: 2

DISTRIBUTION BY STATUS
  backend     (14): 1 active, 8 pending, 2 blocked, 3 done
  frontend    (10): 0 active, 6 pending, 1 blocked, 3 done
  security     (4): 0 active, 3 pending, 0 blocked, 1 done
  testing      (3): 0 active, 2 pending, 0 blocked, 1 done

DISTRIBUTION BY PRIORITY
  backend     (14): 2 critical, 4 high, 6 medium, 2 low
  frontend    (10): 0 critical, 3 high, 5 medium, 2 low
  security     (4): 1 critical, 2 high, 1 medium, 0 low

LABEL COMBINATIONS (Most Common)
  backend + security      (3 tasks)
  frontend + ui           (2 tasks)
  backend + database      (2 tasks)
  backend + performance   (1 task)
```

### JSON Output

```bash
# Machine-readable format for scripting
cleo labels --format json
```

Output structure:
```json
{
  "_meta": {
    "version": "2.1.0",
    "timestamp": "2025-12-12T10:00:00Z",
    "totalLabels": 8,
    "totalTasks": 24,
    "untaggedTasks": 2
  },
  "labels": [
    {
      "name": "backend",
      "count": 14,
      "hasCritical": true,
      "hasHigh": true,
      "statusBreakdown": {
        "pending": 8,
        "active": 1,
        "blocked": 2,
        "done": 3
      },
      "priorityBreakdown": {
        "critical": 2,
        "high": 4,
        "medium": 6,
        "low": 2
      }
    }
  ]
}
```

## Use Cases

### Feature Organization

```bash
# See all tasks for a feature
cleo labels show feature-auth

# Check progress on frontend work
cleo labels show frontend
```

### Sprint Planning

```bash
# Analyze label distribution to understand work areas
cleo labels stats

# Find all tasks in a specific area
cleo labels show backend --format json | jq '.tasks[].priority'
```

### Prioritization

```bash
# Find high-priority security tasks
cleo labels show security | grep -E "critical|high"

# See which labels have the most critical work
cleo labels stats | grep "critical"
```

### Label Management

```bash
# List all labels to find inconsistencies
cleo labels

# Common issues to look for:
#   - Similar labels (e.g., "backend" vs "back-end")
#   - Typos (e.g., "fronted" instead of "frontend")
#   - Unused labels (count = 0 or very low)
```

## Label Best Practices

### Naming Conventions

Use consistent, descriptive label names:

```bash
# Good labels (lowercase, hyphenated)
feature-auth, bug-fix, backend, frontend, high-priority

# Avoid inconsistent naming
Feature-Auth, BugFix, back_end, Front End
```

### Label Categories

Organize labels into logical categories:

**Technology/Component**:
- `backend`, `frontend`, `database`, `api`, `ui`

**Feature/Epic**:
- `feature-auth`, `feature-payments`, `feature-reporting`

**Type**:
- `bug`, `enhancement`, `refactor`, `docs`, `testing`

**Status/Flag**:
- `blocked`, `needs-review`, `urgent`, `tech-debt`

### Adding Labels to Tasks

```bash
# Add labels when creating tasks
cleo add "Fix login bug" --labels bug,backend,security

# Update labels on existing tasks
cleo update T001 --labels backend,api,feature-auth

# Labels are comma-separated, no spaces
```

### Finding Unlabeled Tasks

```bash
# Use jq to find tasks without labels
jq '.tasks[] | select(.labels == null or (.labels | length) == 0)' .cleo/todo.json
```

## Label Analytics Workflows

### Weekly Review

```bash
# See which areas had most activity
cleo labels stats

# Check if any labels are getting too large
cleo labels | grep -E "\d{2,} tasks"
```

### Focus Area Analysis

```bash
# Show all backend tasks and their priorities
cleo labels show backend

# Export for external analysis
cleo labels show backend --format json > backend-tasks.json
```

### Label Cleanup

```bash
# Find rarely used labels
cleo labels stats | grep -E "^\s+\w+\s+\([1-2] tasks\)"

# Review and consolidate similar labels
cleo labels | sort
```

## Integration Examples

### Shell Function for Quick Label Search

```bash
# Add to .bashrc or .zshrc
ct-label() {
  cleo labels show "$1" --format json | jq -r '.tasks[] | "\(.id) \(.title)"'
}

# Usage: ct-label backend
```

### Git Commit Hook

```bash
# .git/hooks/commit-msg
# Ensure commit references labeled task
LABELS=$(cleo labels --format json | jq -r '.labels[].name')
# Validate commit message contains task with known label
```

### Label-Based Filtering

```bash
# Combine with list command for advanced filtering
cleo list --label backend --priority high --status pending

# Export specific label tasks to TodoWrite
cleo labels show backend --format json | \
  jq '.tasks' | \
  cleo export --format todowrite
```

## Color Output

The labels command respects standard color controls:

```bash
# Disable colors
NO_COLOR=1 cleo labels

# Force colors in pipes
FORCE_COLOR=1 cleo labels | less -R
```

## Related Commands

- `cleo list --label LABEL` - List tasks filtered by label
- `cleo add --labels L1,L2` - Add task with labels
- `cleo update ID --labels L1,L2` - Update task labels
- `cleo dash` - Dashboard shows top labels

## Tips

1. **Consistent Naming**: Use lowercase, hyphenated labels for consistency
2. **Hierarchical Labels**: Use prefixes for related labels (e.g., `feature-auth`, `feature-payments`)
3. **Limit Label Count**: Too many labels reduce their usefulness. Aim for 5-15 active labels.
4. **Review Regularly**: Use `labels stats` weekly to identify cleanup opportunities
5. **Combine with Phases**: Use labels for components, phases for workflow stages

## Version History

- **v0.8.0**: Initial implementation with list, show, and stats subcommands
- **v0.8.2**: Added visual bars and priority highlighting
