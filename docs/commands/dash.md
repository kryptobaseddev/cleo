# dash Command

**Alias**: `overview`

Generate a comprehensive dashboard view of your todo system with task summaries, focus tracking, phase progress, and activity metrics.

## Usage

```bash
cleo dash [OPTIONS]
```

## Description

The `dash` command provides a comprehensive overview of your entire todo system in a single view. It combines multiple aspects of your tasks including current focus, status distribution, priority breakdown, blocked tasks, phase progress, label analytics, and recent activity metrics.

This command is ideal for:
- Starting your work session to understand priorities
- Quick status updates on project progress
- Identifying bottlenecks and blocked work
- Tracking activity trends over time
- Understanding label distribution across tasks

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--compact` | `-c` | Condensed single-line summary view | `false` |
| `--period DAYS` | | Stats period in days for activity metrics | `7` |
| `--no-chart` | | Disable ASCII charts and progress bars | Show charts |
| `--sections LIST` | | Comma-separated list of sections to display | `all` |
| `--format FORMAT` | `-f` | Output format: `text` or `json` | `text` |
| `--help` | `-h` | Show help message | |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (validation failed, file read error, invalid option) |

## Sections

The dashboard is composed of modular sections that can be shown or hidden:

| Section | Description |
|---------|-------------|
| `focus` | Current focus task and session note |
| `summary` | Task counts by status (pending, active, blocked, done) |
| `priority` | High and critical priority tasks |
| `blocked` | Tasks that are currently blocked with reasons |
| `phases` | Phase progress bars showing completion percentage |
| `labels` | Top labels with task counts and visual bars |
| `activity` | Recent activity metrics (tasks created/completed in period) |
| `all` | All sections above (default) |

## Examples

### Basic Dashboard

```bash
# Full dashboard with all sections
cleo dash
```

Output:
```
╔══════════════════════════════════════════════════════════╗
║                  CLAUDE-TODO DASHBOARD                   ║
╚══════════════════════════════════════════════════════════╝

📍 CURRENT FOCUS
  Task: T015 - Implement user authentication
  Phase: core
  Note: Working on JWT integration

📊 TASK SUMMARY
  Pending:  12 tasks
  Active:    1 task
  Blocked:   3 tasks
  Done:      8 tasks
  Total:    24 tasks

⚠️  HIGH PRIORITY
  • T015 [critical] Implement user authentication
  • T018 [high] Add error logging
  • T022 [high] Fix performance issue

🚫 BLOCKED TASKS
  • T020 - Waiting for API documentation
  • T021 - Dependencies not installed
  • T023 - External service unavailable

📦 PHASE PROGRESS
  setup   ████████████████████ 100% (5/5)
  core    ████████░░░░░░░░░░░░  40% (4/10)
  polish  ░░░░░░░░░░░░░░░░░░░░   0% (0/4)

🏷️  TOP LABELS
  backend    ██████████████     14 tasks
  frontend   ██████████         10 tasks
  security   ████                4 tasks

📈 ACTIVITY (Last 7 days)
  Created:    6 tasks
  Completed:  8 tasks
  Velocity:   1.1 tasks/day
```

### Compact View

```bash
# Single-line summary for scripting or status bars
cleo dash --compact
```

Output:
```
CLAUDE-TODO: 24 total | 12 pending | 1 active | 3 blocked | 8 done | Focus: T015
```

### Custom Sections

```bash
# Show only focus and blocked tasks
cleo dash --sections focus,blocked

# Show only priority tasks and activity
cleo dash --sections priority,activity
```

### Extended Period

```bash
# Show 14-day activity metrics instead of 7
cleo dash --period 14

# Show 30-day activity trends
cleo dash --period 30
```

### No Charts

```bash
# Disable ASCII charts and progress bars (plain text only)
cleo dash --no-chart
```

### JSON Output

```bash
# Machine-readable JSON format for scripting
cleo dash --format json
```

Output structure:
```json
{
  "_meta": {
    "version": "2.1.0",
    "timestamp": "2025-12-12T10:00:00Z",
    "period_days": 7
  },
  "focus": {
    "taskId": "T015",
    "title": "Implement user authentication",
    "phase": "core",
    "sessionNote": "Working on JWT integration"
  },
  "summary": {
    "pending": 12,
    "active": 1,
    "blocked": 3,
    "done": 8,
    "total": 24
  },
  "priority": {
    "critical": [
      {
        "id": "T015",
        "title": "Implement user authentication",
        "priority": "critical"
      }
    ],
    "high": [
      {
        "id": "T018",
        "title": "Add error logging",
        "priority": "high"
      }
    ]
  },
  "blocked": [
    {
      "id": "T020",
      "title": "Deploy to staging",
      "blockedReason": "Waiting for API documentation"
    }
  ],
  "phases": [
    {
      "name": "setup",
      "completed": 5,
      "total": 5,
      "percentage": 100
    },
    {
      "name": "core",
      "completed": 4,
      "total": 10,
      "percentage": 40
    }
  ],
  "labels": [
    {
      "name": "backend",
      "count": 14
    },
    {
      "name": "frontend",
      "count": 10
    }
  ],
  "activity": {
    "created": 6,
    "completed": 8,
    "velocity": 1.14
  }
}
```

## Use Cases

### Morning Standup

```bash
# Quick overview at start of day
cleo dash
```

Use this to understand what's blocked, what needs attention, and what to focus on next.

### Project Status Report

```bash
# Generate comprehensive status for team updates
cleo dash --period 14 --format markdown > status-report.md
```

### Focus Mode

```bash
# See only what matters right now
cleo dash --sections focus,priority,blocked
```

### CI/CD Integration

```bash
# Get machine-readable dashboard for build systems
cleo dash --format json | jq '.blocked | length'
```

This can be used to fail builds if too many tasks are blocked, or track completion velocity over time.

### Shell Prompt Integration

```bash
# Add to your shell prompt (e.g., .bashrc or .zshrc)
PROMPT_COMMAND='PS1="$(cleo dash --compact --quiet) \$ "'
```

## Color Output

The dashboard respects standard color environment variables:

```bash
# Disable colors
NO_COLOR=1 cleo dash

# Force colors even in pipes
FORCE_COLOR=1 cleo dash | less -R
```

## Related Commands

- `cleo stats` - Detailed statistics and analytics
- `cleo list --status pending` - List pending tasks
- `cleo focus show` - Show current focus task
- `cleo labels` - Analyze label distribution

## Tips

1. **Bookmark This View**: Start every work session with `cleo dash` to orient yourself
2. **Track Blockers**: The blocked section helps identify dependencies blocking progress
3. **Monitor Velocity**: Use `--period` to track how completion rate changes over time
4. **Custom Dashboards**: Use `--sections` to create focused views for different contexts
5. **Automation**: Use `--format json` to integrate with other tools and scripts

## Version History

- **v0.8.0**: Initial implementation with all dashboard sections
- **v0.8.2**: Added compact mode and section filtering
