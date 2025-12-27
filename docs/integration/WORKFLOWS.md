# Workflow Patterns Guide

Comprehensive patterns and workflows for effective task management with cleo.

---

## Table of Contents

1. [Session Management](#session-management)
2. [Task Lifecycle](#task-lifecycle)
3. [CLAUDE.md Integration](#claudemd-integration)
4. [Best Practices](#best-practices)
5. [Common Recipes](#common-recipes)
6. [Advanced Operations](#advanced-operations)

---

## Session Management

### Session Protocol

#### Session Start Pattern

```bash
# 1. Start work session
cleo session start

# 2. Review current state
cleo list

# 3. Check focus and session notes
cleo focus show

# 4. Identify today's priorities
cleo list --priority critical,high --status pending
```

**What to look for**:
- Active tasks requiring continuation
- Blocked tasks with resolved dependencies
- High-priority pending work
- Recent session notes for context

#### Active Work Pattern

```bash
# 1. Set focus to ONE task only
cleo focus set T001

# 2. Add related subtasks as needed
cleo add "Implement validation logic" --depends T001

# 3. Track progress with task notes
cleo update T001 --notes "Completed database schema"

# 4. Update session progress
cleo focus note "Working on authentication validation"

# 5. Complete tasks as finished
cleo complete T001
```

**Key Rules**:
- **ONE active task only** (enforced by focus system)
- Add notes for context preservation
- Create subtasks for discovered work
- Complete promptly to maintain accuracy

#### Session End Pattern

```bash
# 1. Complete all finished tasks
cleo complete T002

# 2. Archive completed tasks
cleo archive

# 3. Update blocked tasks with current status
cleo update T003 --blocked-by "Waiting for API design approval"

# 4. End work session
cleo session end

# 5. Optional: Create session backup
cleo backup --name "session-$(date -Idate)"
```

**Cleanup checklist**:
- [ ] All finished work marked complete
- [ ] Blocked tasks updated with reasons
- [ ] Session notes reflect current state
- [ ] Archive applied for old completed tasks
- [ ] Backup created for recovery point

---

## Task Lifecycle

### Status Flow Diagram

```
┌──────────┐
│ pending  │ ◄───── Initial creation (default)
└────┬─────┘
     │
     │ Work begins
     ▼
┌──────────┐
│  active  │ ◄───── Focus set, work in progress
└────┬─────┘
     │
     ├───► ┌──────────┐
     │     │ blocked  │ ◄───── Impediment identified
     │     └────┬─────┘
     │          │
     │          └────► Resume when unblocked
     │
     │ Task completed
     ▼
┌──────────┐
│   done   │ ◄───── Completion recorded
└────┬─────┘
     │
     │ Archive policy applied
     ▼
┌──────────┐
│ archived │ ◄───── Moved after retention period
└──────────┘
```

### Status Transitions

| From State | To State | Trigger | Command |
|------------|----------|---------|---------|
| `pending` | `active` | Work starts | `focus set <id>` |
| `active` | `done` | Task complete | `complete <id>` |
| `active` | `blocked` | Impediment found | `update <id> --blocked-by "reason"` |
| `blocked` | `active` | Blocker resolved | `focus set <id>` |
| `pending` | `blocked` | Pre-blocked task | `update <id> --blocked-by "reason"` |
| `done` | `archived` | After retention | `archive` (auto or manual) |

### Archive Policies

#### Default Policy

```json
{
  "archive": {
    "enabled": true,
    "daysUntilArchive": 7,
    "maxCompletedTasks": 15,
    "preserveRecentCount": 3,
    "archiveOnSessionEnd": true
  }
}
```

**Policy behavior**:
- Completed tasks older than 7 days → eligible for archive
- If completed count > 15 → trigger archive suggestion
- Always preserve 3 most recent completed tasks
- Check archive eligibility when session ends

#### Custom Retention Examples

**Weekly sprint cycles**:
```json
{
  "archive": {
    "daysUntilArchive": 14,
    "maxCompletedTasks": 30,
    "preserveRecentCount": 10
  }
}
```

**Long-term project tracking**:
```json
{
  "archive": {
    "daysUntilArchive": 30,
    "maxCompletedTasks": 100,
    "preserveRecentCount": 20
  }
}
```

**Aggressive cleanup**:
```json
{
  "archive": {
    "daysUntilArchive": 3,
    "maxCompletedTasks": 5,
    "preserveRecentCount": 1
  }
}
```

---

## CLAUDE.md Integration

### Project Instructions Pattern

Add to `.cleo/CLAUDE.md`:

```markdown
# Project Instructions for Claude Code

## Task Management

Use `cleo` CLI for all task operations.

### Session Protocol

**START**:
```bash
cleo session start
cleo list
cleo focus show
```

**WORK**:
```bash
cleo focus set <task-id>    # ONE task only
cleo add "Subtask"          # Add related tasks
cleo update <id> --notes "Progress"
cleo focus note "Working on X"
```

**END**:
```bash
cleo complete <task-id>
cleo archive
cleo session end
```

### Current Sprint

<!-- CLAUDE-TODO-START -->
Run: cleo list --status pending,active --format markdown
<!-- CLAUDE-TODO-END -->
```

### TodoWrite Integration Pattern

When Claude Code creates internal todos, sync to cleo:

```typescript
// Claude Code internal todo
TodoWrite([
  {
    content: "Implement JWT middleware",
    activeForm: "Implementing JWT middleware",
    status: "in_progress"
  }
])

// Sync to persistent system
// → cleo add "Implement JWT middleware" --status active
```

**Status mapping**:
| TodoWrite | cleo |
|-----------|-------------|
| `pending` | `pending` |
| `in_progress` | `active` |
| `completed` | `done` |

### Automated Completion Pattern

```bash
#!/bin/bash
# .cleo/hooks/on-commit.sh - Link commits to tasks

# Extract task IDs from commit message
TASK_IDS=$(git log -1 --pretty=%B | grep -oE 'T[0-9]{3}' | sort -u)

for task_id in $TASK_IDS; do
  # Check if task exists and is active
  STATUS=$(cleo list --format json | \
    jq -r ".tasks[] | select(.id == \"$task_id\") | .status")

  if [[ "$STATUS" == "active" ]]; then
    echo "Completing task: $task_id"
    cleo complete "$task_id"
  fi
done
```

---

## Best Practices

### Task Creation Best Practices

1. **Use imperative form for titles**
   - ✅ "Fix navigation bug"
   - ❌ "Fixed navigation bug"
   - ❌ "Fixing navigation bug"

2. **Add meaningful descriptions**
   - ✅ "Add JWT-based authentication with email/password login"
   - ❌ "Auth stuff"

3. **Set realistic priorities**
   - `critical`: System down, data loss, security breach
   - `high`: Important feature, significant bug
   - `medium`: Normal work items
   - `low`: Nice-to-have, cleanup, documentation

4. **Use labels consistently**
   - Create label taxonomy: `backend`, `frontend`, `security`, `testing`, `docs`
   - Use compound labels: `feature-auth`, `bug-ui`, `refactor-db`

5. **Define acceptance criteria for complex tasks**
   ```bash
   cleo add "Implement payment processing" \
     --acceptance "Successful test payment,Error handling verified,Refund flow working"
   ```

### Focus Management Best Practices

1. **Single active task rule**
   - ONE task active at a time
   - Use `focus set` to enforce
   - Update session notes for context

2. **Track progress with notes**
   ```bash
   cleo update T001 --notes "Completed database schema design"
   cleo update T001 --notes "Implemented migration scripts"
   ```

3. **Use session notes for interruptions**
   ```bash
   cleo focus note "Completed validation logic, next: error handling"
   ```

### Dependency Management Best Practices

1. **Model actual dependencies**
   ```bash
   # API design must complete before implementation
   API_TASK=$(cleo add "Design REST API schema" --format json | jq -r '.id')
   cleo add "Implement API endpoints" --depends "$API_TASK"
   ```

2. **Use blocked-by for external dependencies**
   ```bash
   cleo add "Deploy to production" \
     --blocked-by "Waiting for security review approval"
   ```

3. **Check for circular dependencies**
   - System validates with `detectCircularDeps: true`
   - Manual verification: review dependency chains

### Archive Best Practices

1. **Regular archive maintenance**
   ```bash
   # Weekly cleanup
   cleo archive --dry-run  # Preview first
   cleo archive             # Apply
   ```

2. **Preserve important completed tasks**
   ```json
   {
     "archive": {
       "preserveRecentCount": 5  // Keep last 5 completed
     }
   }
   ```

3. **Export before major archiving**
   ```bash
   cleo export --format json --output backup-$(date -Idate).json
   cleo archive --all
   ```

---

## Common Recipes

### Recipe 1: Sprint Planning

```bash
#!/bin/bash
# sprint-setup.sh - Initialize new sprint tasks

SPRINT="sprint-12"

# Define sprint tasks
TASKS=(
  "Design authentication UI|high|frontend,ui"
  "Implement JWT middleware|high|backend,security"
  "Add login endpoint|high|backend,api"
  "Add logout endpoint|medium|backend,api"
  "Write auth tests|medium|testing"
  "Update API documentation|low|docs"
)

echo "Creating tasks for $SPRINT..."

for task_spec in "${TASKS[@]}"; do
  IFS='|' read -r title priority labels <<< "$task_spec"
  cleo add "$title" \
    --status pending \
    --priority "$priority" \
    --labels "$labels,$SPRINT"
done

# Generate sprint checklist
cleo list --label "$SPRINT" --format markdown > "SPRINT-$SPRINT.md"

echo "Sprint tasks created: $(cleo list --label $SPRINT --format json | jq '.tasks | length')"
```

### Recipe 2: Bug Triage Workflow

```bash
#!/bin/bash
# triage-bugs.sh - Process incoming bug reports

# Bug report data (typically from issue tracker)
BUGS=(
  "BUG-101|Login fails with special characters|critical"
  "BUG-102|Dashboard refresh button broken|medium"
  "BUG-103|Profile image upload timeout|high"
)

for bug_spec in "${BUGS[@]}"; do
  IFS='|' read -r bug_id title priority <<< "$bug_spec"

  # Create investigation task
  cleo add "Investigate $bug_id: $title" \
    --status pending \
    --priority "$priority" \
    --labels "bug,investigation" \
    --description "Root cause analysis for $bug_id" \
    --notes "Reported on $(date -Idate)"
done

# List all bugs by priority
echo "Bug Triage Report:"
cleo list --label bug --sort priority --reverse --format table
```

### Recipe 3: Daily Standup Report

```bash
#!/bin/bash
# standup-report.sh - Generate daily standup summary

REPORT_FILE="standup-$(date -Idate).md"

cat > "$REPORT_FILE" << EOF
# Daily Standup - $(date '+%Y-%m-%d')

## Yesterday (Completed)
EOF

cleo list \
  --status done \
  --since $(date -d '1 day ago' -Idate) \
  --format markdown >> "$REPORT_FILE"

cat >> "$REPORT_FILE" << EOF

## Today (In Progress)
EOF

cleo list \
  --status active \
  --format markdown >> "$REPORT_FILE"

cat >> "$REPORT_FILE" << EOF

## Blockers
EOF

cleo list \
  --status blocked \
  --format markdown >> "$REPORT_FILE"

cat >> "$REPORT_FILE" << EOF

## Statistics
\`\`\`
EOF

cleo stats --period 7 >> "$REPORT_FILE"

echo "\`\`\`" >> "$REPORT_FILE"

echo "Standup report generated: $REPORT_FILE"
```

### Recipe 4: Release Preparation

```bash
#!/bin/bash
# prepare-release.sh - Pre-release task checklist

RELEASE_VERSION="v2.0.0"

# Release task sequence
RELEASE_TASKS=(
  "Update version numbers|critical|release,version"
  "Run full test suite|critical|testing,release"
  "Update CHANGELOG.md|high|docs,release"
  "Create release notes|high|docs,release"
  "Tag release in git|high|release,git"
  "Build production artifacts|critical|build,release"
  "Deploy to staging|high|deployment,staging"
  "QA approval|critical|qa,release"
  "Deploy to production|critical|deployment,production"
  "Post-release monitoring|medium|ops,release"
)

echo "Creating release tasks for $RELEASE_VERSION..."

PREV_TASK_ID=""

for task_spec in "${RELEASE_TASKS[@]}"; do
  IFS='|' read -r title priority labels <<< "$task_spec"

  # Create task with dependency on previous task
  if [[ -n "$PREV_TASK_ID" ]]; then
    TASK_ID=$(cleo add "$title" \
      --status pending \
      --priority "$priority" \
      --labels "$labels,$RELEASE_VERSION" \
      --depends "$PREV_TASK_ID" \
      --format json | jq -r '.id')
  else
    TASK_ID=$(cleo add "$title" \
      --status pending \
      --priority "$priority" \
      --labels "$labels,$RELEASE_VERSION" \
      --format json | jq -r '.id')
  fi

  PREV_TASK_ID="$TASK_ID"
done

# Generate release checklist
cleo list \
  --label "$RELEASE_VERSION" \
  --sort createdAt \
  --format markdown > "RELEASE-$RELEASE_VERSION.md"

echo "Release checklist created: RELEASE-$RELEASE_VERSION.md"
```

### Recipe 5: End-of-Sprint Cleanup

```bash
#!/bin/bash
# sprint-cleanup.sh - Post-sprint cleanup and reporting

SPRINT_LABEL="sprint-12"

echo "========================================="
echo "Sprint $SPRINT_LABEL Cleanup"
echo "========================================="

# Generate completion report
echo ""
echo "Sprint Completion Summary:"
cleo list --label "$SPRINT_LABEL" --format json | \
  jq -r '.tasks | group_by(.status) | map({status: .[0].status, count: length}) | .[] | "\(.status): \(.count)"'

# Archive completed tasks
echo ""
echo "Archiving completed tasks..."
cleo archive --force

# Report incomplete tasks for next sprint
INCOMPLETE=$(cleo list \
  --label "$SPRINT_LABEL" \
  --status pending,active,blocked \
  --format json | jq '.tasks | length')

if [[ "$INCOMPLETE" -gt 0 ]]; then
  echo ""
  echo "Incomplete Sprint Tasks (carry over to next sprint):"
  cleo list \
    --label "$SPRINT_LABEL" \
    --status pending,active,blocked \
    --format markdown
fi

# Generate statistics
echo ""
echo "Sprint Statistics:"
cleo stats --period 14

# Create backup
echo ""
echo "Creating sprint backup..."
cleo backup --name "sprint-$SPRINT_LABEL-end"

echo ""
echo "Cleanup complete!"
```

---

## Advanced Operations

### Batch Task Creation

```bash
#!/bin/bash
# batch-create.sh - Create multiple related tasks

# Read from CSV file
while IFS=',' read -r title priority labels; do
  cleo add "$title" \
    --priority "$priority" \
    --labels "$labels"
done < tasks.csv

# Or from JSON
jq -c '.[]' tasks.json | while read -r task; do
  TITLE=$(echo "$task" | jq -r '.title')
  PRIORITY=$(echo "$task" | jq -r '.priority')
  LABELS=$(echo "$task" | jq -r '.labels | join(",")')

  cleo add "$TITLE" \
    --priority "$PRIORITY" \
    --labels "$LABELS"
done
```

### Dependency Chain Management

```bash
#!/bin/bash
# create-pipeline.sh - Create dependent task pipeline

# Task sequence with dependencies
PIPELINE=(
  "Design database schema"
  "Implement migrations"
  "Create data models"
  "Build API endpoints"
  "Add authentication"
  "Write integration tests"
)

PREV_ID=""

for task_title in "${PIPELINE[@]}"; do
  if [[ -n "$PREV_ID" ]]; then
    TASK_ID=$(cleo add "$task_title" \
      --depends "$PREV_ID" \
      --format json | jq -r '.id')
  else
    TASK_ID=$(cleo add "$task_title" \
      --format json | jq -r '.id')
  fi

  echo "Created: $TASK_ID - $task_title"
  PREV_ID="$TASK_ID"
done
```

### Bulk Status Updates

```bash
#!/bin/bash
# bulk-update.sh - Update multiple tasks

# Mark all pending backend tasks as blocked
cleo list --status pending --label backend --format json | \
  jq -r '.tasks[].id' | \
  while read -r task_id; do
    cleo update "$task_id" \
      --blocked-by "Waiting for API specification"
  done

# Add label to all high-priority tasks
cleo list --priority high --format json | \
  jq -r '.tasks[].id' | \
  while read -r task_id; do
    cleo update "$task_id" --labels "urgent"
  done
```

### Export and Integration

```bash
#!/bin/bash
# export-tasks.sh - Export to various formats

# Export to GitHub Issues format
cleo list --format json | \
  jq -r '.tasks[] | "## \(.title)\n\n\(.description // "")\n\nPriority: \(.priority)\nLabels: \(.labels | join(", "))\n"' \
  > github-issues.md

# Export to CSV for spreadsheet (via export command)
cleo export --format csv > tasks.csv

# Export to JIRA import format
cleo list --format json | \
  jq -r '.tasks[] | [.title, .description, .priority, (.labels | join(";"))] | @csv' \
  > jira-import.csv

# Export to Trello checklist
cleo list --status pending --format json | \
  jq -r '.tasks[] | "- [ ] \(.title)"' > trello-checklist.md
```

### Archive Management

```bash
#!/bin/bash
# archive-utils.sh - Archive management utilities

# Check archive size
ARCHIVE_COUNT=$(cat .cleo/todo-archive.json | jq '.tasks | length')
echo "Archive contains $ARCHIVE_COUNT tasks"

# Extract specific archived task
cat .cleo/todo-archive.json | \
  jq '.tasks[] | select(.id == "T008")'

# List archived tasks from specific date range
cat .cleo/todo-archive.json | \
  jq '.tasks[] | select(.completedAt >= "2025-11-01" and .completedAt <= "2025-11-30")'

# Export old archived tasks and prune
CUTOFF_DATE="2025-10-01"
jq --arg date "$CUTOFF_DATE" \
  '.tasks | map(select(.completedAt < $date))' \
  .cleo/todo-archive.json > old-archive-backup.json

# Keep only recent archives
jq --arg date "$CUTOFF_DATE" \
  '.tasks = (.tasks | map(select(.completedAt >= $date)))' \
  .cleo/todo-archive.json > .cleo/todo-archive.json.new

mv .cleo/todo-archive.json.new .cleo/todo-archive.json
```

### Log Analysis

```bash
#!/bin/bash
# analyze-log.sh - Extract insights from change log

# Count operations by type
echo "Operation counts:"
jq '[.entries[] | .operation] | group_by(.) | map({key: .[0], count: length}) | from_entries' \
  .cleo/todo-log.json

# Find tasks with most changes
echo "Tasks with most changes:"
jq '[.entries[] | .task_id] | group_by(.) | map({task: .[0], changes: length}) | sort_by(.changes) | reverse | .[0:5]' \
  .cleo/todo-log.json

# Tasks completed in last 7 days
SEVEN_DAYS_AGO=$(date -d '7 days ago' -Iseconds)
echo "Recent completions:"
jq --arg since "$SEVEN_DAYS_AGO" \
  '.entries[] | select(.operation == "complete" and .timestamp > $since) | .task_id' \
  .cleo/todo-log.json

# Average time between task creation and completion
jq -r '.entries[] | select(.operation == "create") | .task_id' .cleo/todo-log.json | \
  while read -r task_id; do
    CREATE_TIME=$(jq -r --arg id "$task_id" \
      '.entries[] | select(.operation == "create" and .task_id == $id) | .timestamp' \
      .cleo/todo-log.json)

    COMPLETE_TIME=$(jq -r --arg id "$task_id" \
      '.entries[] | select(.operation == "complete" and .task_id == $id) | .timestamp' \
      .cleo/todo-log.json)

    if [[ -n "$COMPLETE_TIME" && "$COMPLETE_TIME" != "null" ]]; then
      echo "$task_id: $CREATE_TIME → $COMPLETE_TIME"
    fi
  done
```

---

## Summary

This guide provides proven patterns for:

✅ **Session Management**: Structured start/work/end protocols
✅ **Task Lifecycle**: Complete status flow and archive policies
✅ **Integration**: CLAUDE.md and TodoWrite patterns
✅ **Best Practices**: Task creation, focus, dependencies, archiving
✅ **Common Recipes**: Sprint planning, bug triage, standups, releases
✅ **Advanced Operations**: Batch processing, exports, analysis

For additional help:
- **Usage Guide**: Complete command reference
- **Configuration Guide**: Settings and customization
- **Schema Reference**: Data structure details
- **Troubleshooting**: Common issues and solutions
