# history Command

Show completion history timeline with analytics and velocity metrics.

## Usage

```bash
claude-todo history [OPTIONS]
```

## Description

The `history` command provides a timeline view of task completions with analytics including:
- Daily completion counts with sparkline visualization
- Phase distribution of completed tasks
- Label breakdown of completions
- Velocity metrics (tasks/day average and peak)

This command is ideal for:
- Reviewing productivity trends over time
- Understanding which phases have the most completions
- Identifying productive periods and patterns
- Generating completion reports for stakeholders

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--days N` | | Show last N days | `30` |
| `--since DATE` | | Show completions since date (YYYY-MM-DD) | |
| `--until DATE` | | Show completions until date (YYYY-MM-DD) | |
| `--format FORMAT` | `-f` | Output format: `text` or `json` | `text` |
| `--no-chart` | | Disable sparkline and bar charts | Show charts |
| `--help` | `-h` | Show help message | |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (invalid date format, file read error, validation failed) |

## Examples

### Basic Usage

```bash
# Show last 30 days of completions
claude-todo history

# Show last week
claude-todo history --days 7

# Show specific date range
claude-todo history --since 2025-12-01 --until 2025-12-15
```

### Output Format

```bash
# JSON output for scripting
claude-todo history --format json

# Text output without charts (for terminals without Unicode)
claude-todo history --no-chart
```

## Sample Output

### Text Format

```
╭─────────────────────────────────────────────────────────────────╮
│  COMPLETION HISTORY                                             │
│  Last 30 days                                                  │
╰─────────────────────────────────────────────────────────────────╯

  TIMELINE (Daily Completions)
  ────────────────────────────────────────────────────────────────
  Dec 01 ▁▁▁▃▅▇▅▃▁▁▁▁▃▅▇█▇▅▃▁▁▁▃▅▇▅▃▁▁▁

  VELOCITY METRICS
  ────────────────────────────────────────────────────────────────
  Total Completed:    87 tasks
  Average Rate:       2.9 tasks/day
  Peak Day:           Dec 15 (32 tasks)

  PHASE DISTRIBUTION
  ────────────────────────────────────────────────────────────────
  core     [████████████████████] 51 (59%)
  polish   [████████████░░░░░░░░] 21 (24%)
  setup    [██████░░░░░░░░░░░░░░]  8  (9%)

  TOP LABELS
  ────────────────────────────────────────────────────────────────
  consensus-framework (38)  backup-system (12)  cli (8)
```

### JSON Format

```json
{
  "_meta": {
    "command": "history",
    "generated": "2025-12-15T16:30:00Z",
    "period": {
      "days": 30,
      "since": "2025-11-15",
      "until": "2025-12-15"
    }
  },
  "velocity": {
    "total_completed": 87,
    "average_per_day": 2.9,
    "peak_day": "2025-12-15",
    "peak_count": 32
  },
  "timeline": [
    {"date": "2025-12-15", "count": 32},
    {"date": "2025-12-14", "count": 5},
    ...
  ],
  "phases": {
    "core": 51,
    "polish": 21,
    "setup": 8
  },
  "labels": {
    "consensus-framework": 38,
    "backup-system": 12,
    "cli": 8
  }
}
```

## Use Cases

### Sprint Retrospective

```bash
# Get completion stats for a 2-week sprint
claude-todo history --since 2025-12-01 --until 2025-12-14 --format json
```

### Productivity Analysis

```bash
# Analyze completion patterns over the last month
claude-todo history --days 30
```

### CI/CD Integration

```bash
# Export completion metrics for reporting
claude-todo history --format json | jq '.velocity'
```

## Related Commands

- `dash` - Project dashboard with current status
- `stats` - Overall task statistics
- `phases` - Phase management and progress
- `labels` - Label analytics

## See Also

- [Dashboard Command](dash.md) - Real-time project overview
- [Stats Command](../reference/stats.md) - Task statistics
