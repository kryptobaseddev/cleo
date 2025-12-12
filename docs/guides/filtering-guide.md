# Task Filtering and Query Guide

Complete reference for filtering, searching, and querying tasks in the claude-todo system.

---

## Table of Contents

1. [Basic Filters](#basic-filters)
2. [Date-Based Filtering](#date-based-filtering)
3. [Advanced Queries](#advanced-queries)
4. [jq Power User Techniques](#jq-power-user-techniques)
5. [Output Format Control](#output-format-control)
6. [Sort and Limit Options](#sort-and-limit-options)
7. [Practical Examples](#practical-examples)

---

## Basic Filters

### Status-Based Filtering

Filter tasks by their current workflow state.

```bash
# All pending work
claude-todo list --status pending
claude-todo list -s pending          # Short flag

# Currently active tasks
claude-todo list --status active

# Blocked tasks requiring attention
claude-todo list --status blocked

# Recently completed
claude-todo list --status done --limit 10

# Multiple statuses (comma-separated)
claude-todo list --status pending,active
```

**Available Status Values**:
- `pending`: Not yet started
- `active`: Currently in progress
- `blocked`: Waiting on dependency or blocker
- `done`: Completed (ready for archive)

### Priority Filtering

Filter tasks by urgency level.

```bash
# Critical tasks only
claude-todo list --priority critical
claude-todo list -p critical         # Short flag

# High priority tasks
claude-todo list --priority high

# Multiple priorities (comma-separated)
claude-todo list --priority high,critical

# Non-urgent work
claude-todo list --priority low,medium
```

**Available Priority Values**:
- `critical`: Immediate attention required
- `high`: Important, schedule soon
- `medium`: Normal priority (default)
- `low`: Can be deferred

### Label-Based Filtering

Filter tasks by categorization tags.

```bash
# All backend tasks
claude-todo list --label backend
claude-todo list -l backend          # Short flag

# Security-related work
claude-todo list --label security

# Frontend UI tasks (multiple labels)
claude-todo list --label frontend --label ui
claude-todo list -l frontend -l ui   # Short flags

# Sprint-specific tasks
claude-todo list --label sprint-12
```

**Label Best Practices**:
- Use lowercase with hyphens: `feature-auth`, `bug-critical`
- Organize by: domain (`backend`, `frontend`), type (`bug`, `feature`), sprint (`sprint-12`)
- Multiple labels for cross-categorization

### Phase Filtering

Filter tasks by project workflow phase.

```bash
# Setup phase tasks
claude-todo list --phase setup

# Core implementation tasks
claude-todo list --phase core

# Polish and refinement tasks
claude-todo list --phase polish
```

---

## Date-Based Filtering

### Single Date Filters

```bash
# Tasks created after specific date
claude-todo list --since 2025-12-01

# Tasks created before specific date
claude-todo list --until 2025-12-31

# Tasks from today
claude-todo list --since $(date -Idate)

# Tasks from last 7 days
claude-todo list --since $(date -d '7 days ago' -Idate)

# Tasks from last week
claude-todo list --since 2025-11-28
```

**Date Format**: ISO 8601 format `YYYY-MM-DD`

### Date Range Filters

Combine `--since` and `--until` for specific ranges.

```bash
# Tasks from November 2025
claude-todo list \
  --since 2025-11-01 \
  --until 2025-11-30

# Tasks from Q4 2025
claude-todo list \
  --since 2025-10-01 \
  --until 2025-12-31

# Last 30 days
claude-todo list \
  --since $(date -d '30 days ago' -Idate)
```

### Dynamic Date Calculations

```bash
# Yesterday's tasks
claude-todo list --since $(date -d 'yesterday' -Idate)

# This week's tasks
claude-todo list --since $(date -d 'last monday' -Idate)

# Last month's tasks
claude-todo list \
  --since $(date -d 'last month' +%Y-%m-01) \
  --until $(date -d 'this month' +%Y-%m-01)
```

---

## Advanced Queries

### Multi-Filter Combinations

Combine multiple filters for precise queries.

```bash
# High-priority backend tasks that are pending
claude-todo list \
  --priority high \
  --label backend \
  --status pending

# Blocked critical tasks
claude-todo list \
  --status blocked \
  --priority critical \
  --format json

# Recent active work, newest first
claude-todo list \
  --status active \
  --since 2025-12-01 \
  --sort createdAt \
  --reverse

# Critical frontend tasks from last sprint
claude-todo list \
  --priority critical \
  --label frontend \
  --label sprint-11 \
  --since 2025-11-01 \
  --until 2025-11-30
```

### Negation Patterns (via jq)

Filter out specific values using jq.

```bash
# All tasks EXCEPT low priority
claude-todo list --format json | \
  jq '.tasks[] | select(.priority != "low")'

# All tasks NOT labeled as "docs"
claude-todo list --format json | \
  jq '.tasks[] | select(.labels | contains(["docs"]) | not)'

# Active tasks NOT blocked
claude-todo list --status active --format json | \
  jq '.tasks[] | select(.status != "blocked")'
```

### Pattern Matching

Use jq for pattern-based filtering.

```bash
# Tasks with "auth" in title
claude-todo list --format json | \
  jq '.tasks[] | select(.title | test("auth"; "i"))'

# Tasks with files in specific directory
claude-todo list --format json | \
  jq '.tasks[] | select(.files | map(test("^src/auth/")) | any)'

# Tasks with descriptions containing specific text
claude-todo list --format json | \
  jq '.tasks[] | select(.description // "" | contains("security"))'
```

---

## jq Power User Techniques

### Field-Specific Filters

```bash
# Tasks with specific files
claude-todo list --format json | \
  jq '.tasks[] | select(.files | map(contains("auth")) | any)'

# Tasks with acceptance criteria
claude-todo list --format json | \
  jq '.tasks[] | select(.acceptance | length > 0)'

# Tasks with dependencies
claude-todo list --format json | \
  jq '.tasks[] | select(.depends | length > 0)'

# Tasks with notes
claude-todo list --format json | \
  jq '.tasks[] | select(.notes | length > 0)'
```

### Time-Based Analysis

```bash
# Long-running active tasks (>7 days)
claude-todo list --status active --format json | \
  jq --arg date "$(date -d '7 days ago' -Iseconds)" \
    '.tasks[] | select(.createdAt < $date)'

# Recently completed tasks (last 24 hours)
claude-todo list --status done --format json | \
  jq --arg date "$(date -d '1 day ago' -Iseconds)" \
    '.tasks[] | select(.completedAt > $date)'

# Tasks created this month
claude-todo list --format json | \
  jq --arg month "$(date +%Y-%m)" \
    '.tasks[] | select(.createdAt | startswith($month))'
```

### Custom Projections

Extract specific fields from tasks.

```bash
# Extract only ID and title
claude-todo list --format json | \
  jq '.tasks[] | {id, title}'

# Create CSV-like output
claude-todo list --format json | \
  jq -r '.tasks[] | [.id, .title, .status, .priority] | @csv'

# Custom formatted summary
claude-todo list --format json | \
  jq -r '.tasks[] | "\(.id): \(.title) [\(.status)/\(.priority)]"'

# Task titles as array
claude-todo list --format json | \
  jq '[.tasks[].title]'
```

### Aggregation and Counting

```bash
# Count tasks by status
claude-todo list --format json | \
  jq '[.tasks[].status] | group_by(.) | map({status: .[0], count: length})'

# Count tasks by priority
claude-todo list --format json | \
  jq '[.tasks[].priority] | group_by(.) | map({priority: .[0], count: length})'

# Count tasks by label
claude-todo list --format json | \
  jq '[.tasks[].labels[]] | group_by(.) | map({label: .[0], count: length}) | sort_by(.count) | reverse'

# Average number of files per task
claude-todo list --format json | \
  jq '[.tasks[].files | length] | add / length'
```

### Dependency Analysis

```bash
# Tasks blocking other tasks
claude-todo list --format json | \
  jq '.tasks[] | select(.depends | length > 0) |
      "\(.title) depends on: \(.depends | join(", "))"'

# Unblocked pending tasks (no dependencies)
claude-todo list --status pending --format json | \
  jq '.tasks[] | select(.depends | length == 0)'

# Count dependencies per task
claude-todo list --format json | \
  jq '.tasks[] | {id, title, dependency_count: (.depends | length)}'
```

---

## Output Format Control

### Available Formats

```bash
# Human-readable text (default)
claude-todo list --format text
claude-todo list -f text

# JSON with metadata envelope
claude-todo list --format json

# JSON Lines (streaming, one task per line)
claude-todo list --format jsonl

# Markdown checklist
claude-todo list --format markdown

# ASCII table
claude-todo list --format table

# CSV export (RFC 4180 compliant)
claude-todo list --format csv

# TSV export (tab-separated values)
claude-todo list --format tsv
```

### Format-Specific Options

#### Text Format

```bash
# Default text output
claude-todo list

# Verbose mode (all details)
claude-todo list --verbose
claude-todo list -v

# Compact mode (one-line per task)
claude-todo list --compact
claude-todo list -c

# Flat list (no priority grouping)
claude-todo list --flat

# Quiet mode (suppress info messages)
claude-todo list --quiet
claude-todo list -q
```

#### JSON Format

```bash
# Standard JSON with metadata
claude-todo list --format json

# Pretty-printed JSON
claude-todo list --format json | jq '.'

# Minified JSON
claude-todo list --format json | jq -c '.'

# Extract just tasks array
claude-todo list --format json | jq '.tasks'
```

**JSON Structure**:
```json
{
  "_meta": {
    "version": "2.1.0",
    "timestamp": "2025-12-12T10:00:00Z",
    "count": 3,
    "filtered": true,
    "filters": {
      "status": ["pending", "active"]
    }
  },
  "tasks": [...]
}
```

#### CSV/TSV Format

```bash
# Standard CSV with header
claude-todo list --format csv

# TSV with header
claude-todo list --format tsv

# CSV without header
claude-todo list --format csv --no-header

# Custom delimiter (pipe-separated)
claude-todo list --format csv --delimiter '|'

# Save to file
claude-todo list --format csv > tasks.csv
```

#### Markdown Format

```bash
# Markdown checklist
claude-todo list --format markdown

# Save to file
claude-todo list --format markdown > TODO.md

# Specific status as checklist
claude-todo list --status pending --format markdown > PENDING.md
```

**Markdown Output**:
```markdown
## Active Tasks

- [ ] Fix navigation bug (pending)
- [x] Implement authentication (active)
- [ ] Add user dashboard (pending)
```

---

## Sort and Limit Options

### Sorting

```bash
# Sort by status (default order)
claude-todo list --sort status

# Sort by priority (critical → low)
claude-todo list --sort priority

# Sort by creation date (oldest first)
claude-todo list --sort createdAt

# Sort by title (alphabetical)
claude-todo list --sort title

# Reverse sort order (newest first)
claude-todo list --sort createdAt --reverse
```

**Available Sort Fields**:
- `status`: Workflow state order
- `priority`: Urgency level order
- `createdAt`: Task creation timestamp
- `title`: Alphabetical order

### Limiting Results

```bash
# First 10 tasks
claude-todo list --limit 10

# Top 5 high-priority tasks
claude-todo list --priority high --limit 5

# Latest 3 completed tasks
claude-todo list --status done --sort createdAt --reverse --limit 3
```

### Pagination Pattern

Combine sort, limit, and offset (via jq) for pagination.

```bash
# Page 1 (tasks 0-9)
claude-todo list --limit 10

# Page 2 (tasks 10-19)
claude-todo list --format json | jq '.tasks[10:20]'

# Page 3 (tasks 20-29)
claude-todo list --format json | jq '.tasks[20:30]'
```

---

## Practical Examples

### Daily Workflow Queries

```bash
# Morning standup: What's on my plate today?
claude-todo list --status active,pending --priority high,critical

# End of day: What did I complete?
claude-todo list --status done --since $(date -Idate)

# Weekly review: What's blocked?
claude-todo list --status blocked
```

### Sprint Management

```bash
# Current sprint tasks
claude-todo list --label sprint-12

# Sprint progress (completed vs total)
TOTAL=$(claude-todo list --label sprint-12 --format json | jq '.tasks | length')
DONE=$(claude-todo list --label sprint-12 --status done --format json | jq '.tasks | length')
echo "Sprint Progress: $DONE / $TOTAL tasks completed"

# Sprint burndown data
claude-todo list --label sprint-12 --format json | \
  jq '[.tasks[].status] | group_by(.) | map({status: .[0], count: length})'
```

### Team Coordination

```bash
# Backend team tasks
claude-todo list --label backend --status pending,active

# Frontend team tasks
claude-todo list --label frontend --status pending,active

# Security review needed
claude-todo list --label security --status pending
```

### Release Planning

```bash
# Critical tasks before release
claude-todo list --priority critical --status pending,active

# Release blockers
claude-todo list --status blocked --priority high,critical

# Release checklist
claude-todo list --label release --format markdown > RELEASE-CHECKLIST.md
```

### Technical Debt Tracking

```bash
# All tech debt tasks
claude-todo list --label tech-debt

# Old tech debt (>90 days)
claude-todo list --label tech-debt --format json | \
  jq --arg date "$(date -d '90 days ago' -Iseconds)" \
    '.tasks[] | select(.createdAt < $date)'
```

### Bug Triage

```bash
# All open bugs
claude-todo list --label bug --status pending,active

# Critical bugs
claude-todo list --label bug --priority critical

# Bugs by age
claude-todo list --label bug --sort createdAt
```

---

## Quick Reference

### Common Filter Patterns

```bash
# High-priority work
claude-todo list -p high,critical

# Pending backend tasks
claude-todo list -s pending -l backend

# Recent activity (last 7 days)
claude-todo list --since $(date -d '7 days ago' -Idate)

# Compact JSON for scripting
claude-todo list -f json -c

# Markdown checklist of pending tasks
claude-todo list -s pending -f markdown
```

### Combining Filters

```bash
# Critical pending backend tasks from this sprint
claude-todo list \
  -p critical \
  -s pending \
  -l backend \
  -l sprint-12

# Recently created high-priority tasks
claude-todo list \
  -p high \
  --since $(date -d '3 days ago' -Idate) \
  --sort createdAt \
  --reverse
```

### Output Redirection

```bash
# Export to CSV
claude-todo list -f csv > tasks.csv

# Export to JSON
claude-todo list -f json > tasks.json

# Export to Markdown
claude-todo list -f markdown > TODO.md

# Append to log file
claude-todo list -f text >> task-report-$(date -Idate).log
```

---

## Best Practices

1. **Use Short Flags**: `-s`, `-p`, `-l`, `-f` for faster typing
2. **Combine Filters**: Start broad, then narrow with multiple filters
3. **Save Common Queries**: Create shell aliases for frequent filters
4. **Use JSON for Scripting**: Parse with jq for automation
5. **Export Regularly**: Create snapshots with CSV/Markdown exports
6. **Leverage Sorting**: Use `--sort` and `--reverse` for priority ordering

### Shell Aliases for Common Filters

```bash
# Add to ~/.bashrc or ~/.zshrc
alias ct-todo='claude-todo list -s pending'
alias ct-active='claude-todo list -s active'
alias ct-blocked='claude-todo list -s blocked'
alias ct-done='claude-todo list -s done --limit 10'
alias ct-critical='claude-todo list -p critical'
alias ct-today='claude-todo list --since $(date -Idate)'
alias ct-week='claude-todo list --since $(date -d "7 days ago" -Idate)'
```

---

## Next Steps

- **Usage Guide**: See [usage.md](../usage.md) for complete command reference
- **Output Reference**: See [CLI-OUTPUT-REFERENCE.md](../../claudedocs/CLI-OUTPUT-REFERENCE.md) for format details
- **Configuration**: See [configuration.md](../configuration.md) for filter customization
