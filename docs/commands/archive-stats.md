# cleo archive-stats

Generate analytics and insights from archived tasks.

## Synopsis

```bash
cleo archive-stats [OPTIONS]
```

## Description

The `archive-stats` command analyzes the task archive to provide statistics and insights about completed work. It generates reports on task distribution, cycle times, and trends.

## Options

| Option | Description |
|--------|-------------|
| `--by-phase` | Group statistics by project phase |
| `--by-label` | Group statistics by task labels |
| `--format <format>` | Output format: text (default) or json |
| `--json` | Shortcut for `--format json` |
| `--human` | Shortcut for `--format text` |
| `--quiet` | Suppress non-essential output |
| `--help` | Show help message |

## Output

The command provides:

- **Summary Statistics**: Total archived tasks, completion rates
- **Phase Breakdown**: Task counts and cycle times per phase
- **Label Breakdown**: Distribution of tasks across labels
- **Priority Distribution**: High/medium/low task breakdown
- **Cycle Time Analysis**: Average, median, and distribution of completion times
- **Archiving Trends**: Tasks archived over time periods

## Examples

```bash
# Basic archive statistics
cleo archive-stats

# Statistics grouped by phase
cleo archive-stats --by-phase

# Statistics grouped by label
cleo archive-stats --by-label

# JSON output for scripting
cleo archive-stats --json

# Combined phase and label breakdown
cleo archive-stats --by-phase --by-label
```

## JSON Output Structure

```json
{
  "summary": {
    "totalArchived": 150,
    "avgCycleTimeDays": 2.5,
    "medianCycleTimeDays": 1.8
  },
  "byPhase": {
    "setup": { "count": 20, "avgCycleTimeDays": 1.2 },
    "core": { "count": 80, "avgCycleTimeDays": 3.1 },
    "testing": { "count": 30, "avgCycleTimeDays": 2.0 },
    "polish": { "count": 20, "avgCycleTimeDays": 1.5 }
  },
  "byPriority": {
    "critical": 10,
    "high": 45,
    "medium": 70,
    "low": 25
  }
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 3 | Archive file not found |
| 100 | No archived tasks |

## See Also

- `cleo archive` - Archive completed tasks
- `cleo unarchive` - Restore archived tasks
- `cleo history` - Completion timeline
