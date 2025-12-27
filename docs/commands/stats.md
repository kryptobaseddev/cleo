# stats Command

Generate comprehensive statistics from the todo system.

## Usage

```bash
cleo stats [OPTIONS]
```

## Description

The `stats` command generates detailed statistics from `todo.json`, `todo-archive.json`, and `todo-log.json`. It provides insights into task completion rates, activity patterns, and project health.

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--period PERIOD` | `-p` | Analysis period (see below) | `30` |
| `--format FORMAT` | `-f` | Output format: `text`, `json` | `text` |
| `--help` | `-h` | Show help message | |

### Period Values

| Named | Alias | Days |
|-------|-------|------|
| `today` | `t` | 1 |
| `week` | `w` | 7 |
| `month` | `m` | 30 |
| `quarter` | `q` | 90 |
| `year` | `y` | 365 |

Or use any positive integer for custom days.

## Examples

### Basic Statistics

```bash
# Default 30-day statistics
cleo stats

# Last week
cleo stats -p week

# Last 7 days (same as week)
cleo stats -p 7
```

Output:
```
================================================
[STATS] CLAUDE TODO SYSTEM STATISTICS
================================================

[STATUS] CURRENT STATE
----------------
Pending:      10 Tasks
In Progress:  1 Task
Completed:    5 Tasks
Total Active: 16 Tasks

[METRICS] COMPLETION METRICS (Last 30 Days)
----------------
Tasks Completed:     12 Tasks
Tasks Created:       15 Tasks
Completion Rate:     80.00%
Avg Time to Complete: 4.5h

[ACTIVITY] ACTIVITY METRICS (Last 30 Days)
----------------
Tasks Created:    15 Tasks
Tasks Completed:  12 Tasks
Tasks Archived:   8 Tasks
Busiest Day:      Tuesday

[ARCHIVE] ARCHIVE STATISTICS
----------------
Total Archived:    45 Tasks
Archived (Period): 8 Tasks

[ALL-TIME] ALL-TIME STATISTICS
----------------
Total Created: 120 Tasks
Total Completed: 105 Tasks

================================================
Generated: 2025-12-13T10:00:00Z
================================================
```

### JSON Output

```bash
cleo stats -f json
```

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "version": "0.12.0",
    "command": "stats",
    "timestamp": "2025-12-13T10:00:00Z",
    "period_days": 30
  },
  "data": {
    "current_state": {
      "pending": 10,
      "in_progress": 1,
      "completed": 5,
      "total_active": 16
    },
    "completion_metrics": {
      "period_days": 30,
      "completed_in_period": 12,
      "created_in_period": 15,
      "completion_rate": 80.00,
      "avg_completion_hours": 4.5
    },
    "activity_metrics": {
      "created_in_period": 15,
      "completed_in_period": 12,
      "archived_in_period": 8,
      "busiest_day": "Tuesday"
    },
    "archive_stats": {
      "total_archived": 45,
      "archived_in_period": 8
    },
    "all_time": {
      "total_tasks_created": 120,
      "total_tasks_completed": 105
    }
  }
}
```

### Period Examples

```bash
# Today only
cleo stats -p today

# Last quarter
cleo stats -p quarter

# Custom: last 14 days
cleo stats -p 14

# Last month in JSON
cleo stats -p month -f json
```

## Statistics Categories

### Current State

| Metric | Description |
|--------|-------------|
| Pending | Tasks with `status: pending` |
| In Progress | Tasks with `status: active` |
| Completed | Tasks with `status: done` |
| Total Active | All tasks in `todo.json` |

### Completion Metrics

| Metric | Description |
|--------|-------------|
| Tasks Completed | Completions in period |
| Tasks Created | New tasks in period |
| Completion Rate | `(completed / created) * 100` |
| Avg Time to Complete | Hours from creation to completion |

### Activity Metrics

| Metric | Description |
|--------|-------------|
| Tasks Created | Tasks added in period |
| Tasks Completed | Tasks finished in period |
| Tasks Archived | Tasks archived in period |
| Busiest Day | Day of week with most activity |

### Archive Statistics

| Metric | Description |
|--------|-------------|
| Total Archived | All archived tasks |
| Archived (Period) | Archived in period |

### All-Time Statistics

| Metric | Description |
|--------|-------------|
| Total Created | All tasks ever created |
| Total Completed | All tasks ever completed |

## Dependencies

Requires `jq` and `bc` for calculations.

## See Also

- [dash](dash.md) - Project dashboard
- [list](list.md) - View tasks
- [archive](archive.md) - Archive statistics
