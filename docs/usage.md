# Usage Guide

Complete guide to using the claude-todo task management system.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Basic Workflow](#basic-workflow)
3. [Task Lifecycle](#task-lifecycle)
4. [Command Reference](#command-reference)
5. [Advanced Operations](#advanced-operations)
6. [CLAUDE.md Integration](#claudemd-integration)
7. [Filtering and Searching](#filtering-and-searching)
8. [Configuration](#configuration)
9. [Examples and Recipes](#examples-and-recipes)

---

## Quick Start

### First-Time Setup

```bash
# 1. Install globally
./install.sh

# 2. Navigate to your project
cd /path/to/your/project

# 3. Initialize todo system
claude-todo init

# 4. Create your first task
claude-todo add "Implement user authentication" \
  --status pending \
  --priority high \
  --description "Add JWT-based authentication with email/password login"
```

### Daily Workflow

```bash
# List current tasks
claude-todo list

# Mark task complete
claude-todo complete <task-id>

# View statistics
claude-todo stats
```

### Command Aliases (v0.6.0+)

Built-in aliases for faster workflows:

```bash
claude-todo ls              # Same as: list
claude-todo done T001       # Same as: complete T001
claude-todo new "Task"      # Same as: add "Task"
claude-todo edit T001       # Same as: update T001
claude-todo rm              # Same as: archive
claude-todo check           # Same as: validate
```

Aliases can be customized in `~/.claude-todo/config.json`:

```json
{
  "cli": {
    "aliases": {
      "ls": "list",
      "done": "complete",
      "s": "stats"
    }
  }
}
```

### Debug Mode

Validate your CLI installation and troubleshoot issues:

```bash
# Run comprehensive validation
claude-todo --validate

# Show all available commands (core + aliases + plugins)
claude-todo --list-commands

# Enable debug output for any command
CLAUDE_TODO_DEBUG=1 claude-todo list
```

### Plugins (v0.6.0+)

Create custom commands by adding scripts to `~/.claude-todo/plugins/`:

```bash
# Create a custom command
cat > ~/.claude-todo/plugins/my-report.sh << 'EOF'
#!/usr/bin/env bash
###PLUGIN
# description: Generate my custom report
###END
echo "My custom report!"
EOF

chmod +x ~/.claude-todo/plugins/my-report.sh

# Use it
claude-todo my-report
```

Project-local plugins can be placed in `./.claude/plugins/`.

---

## Basic Workflow

### 1. Creating Tasks

#### Simple Task Creation

```bash
# Minimal task (title only)
claude-todo add "Fix login bug"

# Task with status and priority
claude-todo add "Add user dashboard" \
  --status pending \
  --priority high

# Complete task with all fields
claude-todo add "Implement payment processing" \
  --status pending \
  --priority critical \
  --description "Integrate Stripe API for subscription payments" \
  --files "src/payments/stripe.ts,src/api/checkout.ts" \
  --acceptance "Successful test payment,Error handling verified" \
  --labels "backend,payment,api"
```

#### Task Field Details

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Brief task summary (imperative form) |
| `status` | enum | Yes | One of: `pending`, `active`, `blocked`, `done` |
| `priority` | enum | No | One of: `low`, `medium`, `high`, `critical` |
| `description` | string | No | Detailed task explanation |
| `files` | array | No | Comma-separated file paths affected by task |
| `acceptance` | array | No | Comma-separated acceptance criteria |
| `depends` | array | No | Comma-separated task IDs this task depends on |
| `blockedBy` | array | No | Comma-separated task IDs blocking this task |
| `notes` | string | No | Additional notes or context |
| `labels` | array | No | Comma-separated tags for categorization |

### 2. Listing Tasks

#### Basic Listing

```bash
# List all active tasks (default)
claude-todo list

# List tasks with specific status
claude-todo list --status pending
claude-todo list --status active
claude-todo list --status blocked
claude-todo list --status done

# List all tasks including archived
claude-todo list --all
```

#### Output Formats

```bash
# Human-readable terminal output (default)
claude-todo list --format text

# JSON output for scripting
claude-todo list --format json

# Markdown format for documentation
claude-todo list --format markdown

# ASCII table format
claude-todo list --format table
```

#### Filtering Options

```bash
# Filter by priority
claude-todo list --priority high

# Filter by label
claude-todo list --label backend

# Tasks created after specific date
claude-todo list --since 2025-12-01

# Limit number of results
claude-todo list --limit 10
```

### 3. Completing Tasks

#### Basic Completion

```bash
# Complete a task by ID
claude-todo complete T001

# Complete without triggering auto-archive
claude-todo complete T001 --skip-archive
```

#### What Happens on Completion

1. Task status changes from `pending`/`active` → `done`
2. `completedAt` timestamp added automatically
3. Operation logged to `todo-log.json`
4. Auto-archive triggered if enabled in config
5. Success message displays task ID and completion time

### 4. Archiving Tasks

#### Manual Archive

```bash
# Archive completed tasks based on config retention
claude-todo archive

# Preview what would be archived
claude-todo archive --dry-run

# Force archive (respects preserveRecentCount)
claude-todo archive --force

# Archive ALL completed tasks (ignores preserve setting)
claude-todo archive --all
```

#### Automatic Archive

Configure in `.claude/todo-config.json`:

```json
{
  "archive": {
    "enabled": true,
    "daysUntilArchive": 7,
    "archiveOnSessionEnd": true
  }
}
```

When enabled, tasks are automatically archived after completion when they exceed `daysUntilArchive` threshold.

---

## Task Lifecycle

### Status Flow

```
┌──────────┐
│ pending  │ ◄───── Initial creation
└────┬─────┘
     │
     ▼
┌──────────┐
│  active  │ ◄───── Work begins
└────┬─────┘
     │
     ├───► ┌──────────┐
     │     │ blocked  │ ◄───── Impediment identified
     │     └────┬─────┘
     │          │
     │          └────► Resume when unblocked
     │
     ▼
┌──────────┐
│   done   │ ◄───── Task completed
└────┬─────┘
     │
     ▼
┌──────────┐
│ archived │ ◄───── Moved to archive after retention period
└──────────┘
```

### Status Transitions

| From | To | Trigger | Command |
|------|-----|---------|---------|
| `pending` | `active` | Work starts | Update status manually |
| `active` | `done` | Task complete | `complete-task.sh` |
| `active` | `blocked` | Impediment found | Update status manually |
| `blocked` | `active` | Blocker resolved | Update status manually |
| `done` | `archived` | After retention period | `archive.sh` |

### Archive Policies

**Default Policy**:
- Completed tasks older than 7 days → archived
- Max archive size: 1000 tasks
- Manual archive available anytime

**Custom Retention**:
```json
{
  "archive": {
    "daysUntilArchive": 30,         // Keep completed tasks 30 days
    "maxCompletedTasks": 50,        // Archive when completed count exceeds this
    "preserveRecentCount": 5,       // Always keep this many recent completed tasks
    "archiveOnSessionEnd": false    // Manual archive only
  }
}
```

---

## Command Reference

### init.sh

Initialize todo system in a project.

```bash
claude-todo init [OPTIONS]
```

**Options**:
- `--force`: Overwrite existing todo files
- `--template <path>`: Use custom template instead of default

**Examples**:
```bash
# Standard initialization
claude-todo init

# Force re-initialization
claude-todo init --force

# Initialize with custom template
claude-todo init --template ~/my-todo-template.json
```

**Output**:
- Creates `.claude/` directory
- Copies template files
- Initializes empty log file
- Validates all files
- Updates `.gitignore`

---

### add-task.sh

Create a new task with validation.

```bash
claude-todo add "TASK_TITLE" [OPTIONS]
```

**Required Arguments**:
- `TASK_TITLE`: Task description (quoted if contains spaces)

**Options**:
- `--status <status>`: Task status (default: `pending`)
- `--priority <priority>`: Task priority (default: `medium`)
- `--description <text>`: Detailed description
- `--files <paths>`: Comma-separated file paths
- `--acceptance <criteria>`: Comma-separated acceptance criteria
- `--depends <ids>`: Comma-separated task IDs this depends on
- `--blocked-by <ids>`: Comma-separated blocking task IDs
- `--notes <text>`: Additional notes
- `--labels <tags>`: Comma-separated labels

**Examples**:
```bash
# Simple task
claude-todo add "Fix navigation bug"

# Task with priority
claude-todo add "Security audit" --priority critical

# Complex task with all fields
claude-todo add "Implement user authentication" \
  --status pending \
  --priority high \
  --description "Add JWT-based auth with email/password" \
  --files "src/auth/jwt.ts,src/middleware/auth.ts" \
  --acceptance "Login endpoint works,Token refresh implemented,Error handling complete" \
  --labels "backend,security,authentication" \
  --notes "Reference: https://jwt.io/introduction"

# Dependent task
claude-todo add "Add logout endpoint" \
  --depends T001 \
  --description "Implement logout with token invalidation"

# Blocked task
claude-todo add "Deploy to production" \
  --blocked-by T002 \
  --status blocked \
  --notes "Blocked until security review completes"
```

**Validation**:
- Title must not be empty
- Status must be valid enum value
- Duplicate titles trigger warning
- Dependencies/blockers validated against existing tasks
- All fields validated against schema

---

### update-task.sh

Update an existing task's fields.

```bash
claude-todo update TASK_ID [OPTIONS]
```

**Required Arguments**:
- `TASK_ID`: Task identifier (e.g., T001)

**Scalar Field Options**:
- `--title "New title"`: Update task title
- `--status STATUS`: Change status (pending|active|blocked)
  - Note: Use `complete-task.sh` for done status
- `--priority PRIORITY`: Update priority (critical|high|medium|low)
- `--description DESC`: Update description
- `--phase PHASE`: Update phase slug
- `--blocked-by REASON`: Set blocked reason (status becomes blocked)

**Array Field Options** (append by default):
- `--labels LABELS`: Append comma-separated labels
- `--set-labels LABELS`: Replace all labels with these
- `--clear-labels`: Remove all labels

- `--files FILES`: Append comma-separated file paths
- `--set-files FILES`: Replace all files with these
- `--clear-files`: Remove all files

- `--acceptance CRIT`: Append comma-separated acceptance criteria
- `--set-acceptance CRIT`: Replace all acceptance criteria
- `--clear-acceptance`: Remove all acceptance criteria

- `--depends IDS`: Append comma-separated task IDs
- `--set-depends IDS`: Replace all dependencies
- `--clear-depends`: Remove all dependencies

- `--notes NOTE`: Add a timestamped note (appends only)

**Examples**:
```bash
# Update priority
claude-todo update T001 --priority high

# Add labels (appends to existing)
claude-todo update T002 --labels "bug,urgent"

# Replace all labels
claude-todo update T003 --set-labels "frontend,ui"

# Set task as blocked
claude-todo update T004 --blocked-by "Waiting for API spec"

# Add a note
claude-todo update T005 --notes "Started implementation"

# Multiple updates at once
claude-todo update T006 --priority critical --labels "security" --notes "Security review required"

# Clear and set new values
claude-todo update T007 --clear-files --set-labels "backend,api"
```

**Validation**:
- Task must exist and not be completed (done status)
- Status transitions validated (can't set to done - use complete-task.sh)
- Only one active task allowed (active status constraint enforced)
- Labels must be lowercase alphanumeric with hyphens
- Dependencies must reference existing task IDs
- All updates logged to audit trail

**Array Behavior**:
- Default: Append mode (--labels adds to existing)
- Replace: Use --set-* variants (--set-labels replaces all)
- Clear: Use --clear-* variants (--clear-labels removes all)
- Notes: Always append with timestamp (no replace/clear)

---

### list-tasks.sh

Display current tasks with filtering.

```bash
claude-todo list [OPTIONS]
```

**Options**:
- `--status <status>`: Filter by status (`pending`, `active`, `blocked`, `done`)
- `--priority <priority>`: Filter by priority (`low`, `medium`, `high`, `critical`)
- `--phase <phase>`: Filter by phase slug
- `--label <label>`: Filter by label
- `--since <date>`: Show tasks created after date (ISO 8601: YYYY-MM-DD)
- `--until <date>`: Show tasks created before date (ISO 8601: YYYY-MM-DD)
- `--limit <n>`: Limit results to N tasks
- `--all`: Include archived tasks
- `--format <format>`: Output format (`text`, `json`, `markdown`, `table`)
- `--sort <field>`: Sort by field (`status`, `priority`, `createdAt`, `title`)
- `--reverse`: Reverse sort order
- `--compact, -c`: Compact one-line per task view
- `--flat`: Don't group by priority (flat list)
- `-v, --verbose`: Show all task details

**Examples**:
```bash
# All active tasks (default)
claude-todo list

# Only pending tasks
claude-todo list --status pending

# High priority tasks
claude-todo list --priority high

# Backend tasks only
claude-todo list --label backend

# Recent tasks (last 7 days)
claude-todo list --since 2025-11-28

# Top 5 tasks
claude-todo list --limit 5

# JSON output for scripting
claude-todo list --format json

# Markdown checklist
claude-todo list --format markdown

# All tasks including archived
claude-todo list --all

# Sort by creation date, newest first
claude-todo list --sort createdAt --reverse

# Compact view
claude-todo list --compact

# Verbose mode with all details
claude-todo list -v
```

**Output Formats**:

**Text (default)**:
```
📋 Active Tasks (3)

[pending] Fix navigation bug
  ID: T001
  Priority: medium
  Created: 2025-12-05T10:00:00Z

[active] Implement authentication
  ID: T002
  Priority: high
  Files: src/auth/jwt.ts, src/middleware/auth.ts
  Created: 2025-12-05T09:30:00Z
```

**JSON**:
```json
{
  "tasks": [
    {
      "id": "T002",
      "title": "Implement authentication",
      "status": "active",
      "priority": "high",
      "files": ["src/auth/jwt.ts", "src/middleware/auth.ts"],
      "createdAt": "2025-12-05T09:30:00Z"
    }
  ],
  "total": 3
}
```

**Markdown**:
```markdown
## Active Tasks

- [ ] Fix navigation bug (pending)
- [x] Implement authentication (active)
- [ ] Add user dashboard (pending)
```

---

### complete-task.sh

Mark a task as complete.

```bash
claude-todo complete <TASK_ID> [OPTIONS]
```

**Required Arguments**:
- `TASK_ID`: Task identifier

**Options**:
- `--skip-archive`: Don't trigger auto-archive even if configured

**Examples**:
```bash
# Simple completion
claude-todo complete T003

# Complete without triggering auto-archive
claude-todo complete T003 --skip-archive
```

**Validation**:
- Task must exist
- Task must not already be completed
- Valid status transition required (`pending`/`active`/`blocked` → `done`)

**Side Effects**:
- Updates task status to `done`
- Adds `completedAt` timestamp
- Logs completion to `todo-log.json`
- Triggers auto-archive if enabled
- Creates backup before modification

---

### archive.sh

Archive completed tasks.

```bash
claude-todo archive [OPTIONS]
```

**Options**:
- `--dry-run`: Preview without making changes
- `--force`: Archive all completed (except preserved count)
- `--all`: Archive ALL completed tasks (bypasses retention AND preserve)
- `--count N`: Override maxCompletedTasks setting

**Examples**:
```bash
# Archive based on config (default: 7 days)
claude-todo archive

# Preview what would be archived
claude-todo archive --dry-run

# Force archive all completed (respects preserveRecentCount)
claude-todo archive --force

# Archive ALL completed tasks (ignores preserve setting)
claude-todo archive --all

# Override max completed tasks threshold
claude-todo archive --count 20
```

**Output**:
```
📦 Archiving completed tasks...

Candidates: 15 tasks
Age threshold: 7 days
Archive policy: enabled

Archiving:
  ✓ T004 (completed 8 days ago)
  ✓ T005 (completed 10 days ago)
  ✓ T006 (completed 14 days ago)

Summary:
  Archived: 3 tasks
  Remaining active: 12 tasks
  Archive size: 48 tasks

Archive location: .claude/todo-archive.json
```

**Validation**:
- Only `done` tasks archived
- Age threshold enforced unless `--force`
- Archive size limits respected
- Referential integrity maintained

---

### export.sh

Export tasks to various formats for integration with external tools.

```bash
claude-todo export [OPTIONS]
```

**Options**:
- `--format <format>`: Output format: `todowrite`, `json`, `markdown` (default: todowrite)
- `--status <status>`: Comma-separated status filter (default: pending,active)
- `--max <n>`: Maximum tasks to export (default: 10)
- `--output <file>`: Write to file instead of stdout
- `--quiet`: Suppress informational messages

**Examples**:
```bash
# Export to TodoWrite format (for Claude Code)
claude-todo export --format todowrite

# Export only active tasks
claude-todo export --format todowrite --status active

# Export as markdown checklist
claude-todo export --format markdown

# Export to file
claude-todo export --format todowrite --output tasks.json

# Quiet mode (no info messages)
claude-todo export --quiet
```

**TodoWrite Format**:
```json
{
  "todos": [
    {
      "content": "Implement authentication",
      "activeForm": "Implementing authentication",
      "status": "in_progress"
    }
  ]
}
```

**Status Mapping**:
| claude-todo | TodoWrite |
|-------------|-----------|
| pending | pending |
| active | in_progress |
| blocked | pending |
| done | completed |

**Grammar Transformation**:
The `activeForm` field is automatically derived from the task title:
- "Fix bug" → "Fixing bug"
- "Add feature" → "Adding feature"
- "Implement auth" → "Implementing auth"

---

### validate.sh

Validate all todo JSON files.

```bash
claude-todo validate [OPTIONS]
```

**Options**:
- `--fix`: Attempt automatic repairs
- `--strict`: Enable strict validation mode
- `--file <path>`: Validate specific file only
- `--verbose`: Show detailed validation output

**Examples**:
```bash
# Validate all files
claude-todo validate

# Validate with automatic fixes
claude-todo validate --fix

# Strict mode (no warnings ignored)
claude-todo validate --strict

# Validate specific file
claude-todo validate --file .claude/todo.json

# Verbose validation
claude-todo validate --verbose
```

**Validation Checks**:

1. **Schema Validation**:
   - JSON syntax correctness
   - Required fields present
   - Field types match schema
   - Enum values valid

2. **Anti-Hallucination Checks**:
   - ID uniqueness within file
   - ID uniqueness across todo + archive
   - Status values from allowed enum
   - Timestamp sanity (not future dates)
   - `completedAt` after `createdAt`
   - No duplicate task titles

3. **Referential Integrity**:
   - Dependencies reference valid tasks
   - Blockers reference valid tasks
   - Archive contains only `done` tasks
   - Log entries reference valid tasks

**Output**:
```
🔍 Validating todo system files...

✅ .claude/todo.json
   Schema: VALID
   Tasks: 12
   Issues: None

⚠️  .claude/todo-archive.json
   Schema: VALID
   Tasks: 48
   Warnings:
     - Task T007 has no completedAt timestamp
     - Recommend: Add completion timestamp

✅ .claude/todo-config.json
   Schema: VALID
   Configuration: Valid

✅ .claude/todo-log.json
   Schema: VALID
   Entries: 156

Summary:
  Files validated: 4
  Errors: 0
  Warnings: 1

Exit code: 0 (success)
```

**Exit Codes**:
- `0`: All valid
- `1`: Schema errors
- `2`: Semantic errors
- `3`: Both schema and semantic errors

---

### stats.sh

Display task statistics and reports.

```bash
claude-todo stats [OPTIONS]
```

**Options**:
- `--period <days>`: Analysis period in days (default: 30)
- `--format <format>`: Output format (`text`, `json`, `csv`)
- `--chart`: Include ASCII charts
- `--detailed`: Show detailed breakdown

**Examples**:
```bash
# Default stats (30-day period)
claude-todo stats

# Last 7 days
claude-todo stats --period 7

# Last 90 days with charts
claude-todo stats --period 90 --chart

# Detailed statistics
claude-todo stats --detailed

# JSON output for dashboards
claude-todo stats --format json

# CSV export for spreadsheets
claude-todo stats --format csv
```

**Output**:
```
📊 Task Statistics

Current State:
  Pending:    8 tasks
  Active:     4 tasks
  Blocked:    1 task
  Done:       12 tasks
  ───────────────────
  Total:      25 tasks

Last 30 Days:
  Created:    18 tasks
  Completed:  12 tasks
  Completion Rate: 66.7%
  Avg Time to Complete: 3.2 days

Priority Distribution:
  Critical:   2 tasks (8%)
  High:       6 tasks (24%)
  Medium:     12 tasks (48%)
  Low:        5 tasks (20%)

Label Distribution:
  backend:    10 tasks
  frontend:   8 tasks
  security:   3 tasks
  docs:       2 tasks

Archived:
  Total:      48 tasks
  Oldest:     2025-09-15
  Newest:     2025-11-28

Productivity Trends:
  Week 1:     █████████░ 9 tasks
  Week 2:     ███████░░░ 7 tasks
  Week 3:     ████████░░ 8 tasks
  Week 4:     ██████████ 10 tasks

Top Blockers:
  1. Security review pending (blocks 3 tasks)
  2. API design incomplete (blocks 2 tasks)
```

---

### backup.sh

Create backup of todo files.

```bash
claude-todo backup [OPTIONS]
```

**Options**:
- `--destination <dir>`: Backup destination (default: `.claude/.backups/`)
- `--compress`: Compress backup with gzip
- `--name <name>`: Custom backup name

**Examples**:
```bash
# Default backup
claude-todo backup

# Backup to custom location
claude-todo backup --destination ~/backups/todo-backup

# Compressed backup
claude-todo backup --compress

# Named backup
claude-todo backup --name "before-major-refactor"
```

**Output**:
```
💾 Creating backup...

Backing up:
  ✓ .claude/todo.json
  ✓ .claude/todo-archive.json
  ✓ .claude/todo-config.json
  ✓ .claude/todo-log.json

Backup created:
  Location: .claude/.backups/backup-2025-12-05-100000/
  Size: 48 KB
  Files: 4

Validation: ✅ Backup integrity verified
```

---

### restore.sh

Restore todo files from backup.

```bash
claude-todo restore <BACKUP_DIR> [OPTIONS]
```

**Required Arguments**:
- `BACKUP_DIR`: Path to backup directory

**Options**:
- `--force`: Skip confirmation prompt
- `--verify`: Verify backup before restore
- `--no-backup`: Don't backup current files before restore

**Examples**:
```bash
# List available backups
ls -la .claude/.backups/

# Restore from specific backup
claude-todo restore .claude/.backups/backup-2025-12-05-100000/

# Verify backup before restore
claude-todo restore .claude/.backups/backup-2025-12-05-100000/ --verify

# Force restore without confirmation
claude-todo restore .claude/.backups/backup-2025-12-05-100000/ --force
```

**Workflow**:
1. Validates backup directory exists
2. Verifies backup file integrity
3. Backs up current files (unless `--no-backup`)
4. Copies backup files to `.claude/`
5. Validates restored files
6. Confirms success or rolls back on error

**Output**:
```
🔄 Restoring from backup...

Backup: .claude/.backups/backup-2025-12-05-100000/
Date: 2025-12-05 10:00:00

Validation: ✅ Backup files valid

Creating safety backup of current files...
  ✓ Current files backed up to: .claude/.backups/pre-restore-2025-12-05-103000/

Restoring files:
  ✓ todo.json (15 tasks)
  ✓ todo-archive.json (48 tasks)
  ✓ todo-config.json
  ✓ todo-log.json (156 entries)

Post-restore validation: ✅ All files valid

✅ Restore completed successfully
```

---

## Advanced Operations

### Batch Task Creation

Create multiple tasks from a script or file:

```bash
#!/bin/bash
# create-sprint-tasks.sh

TASKS=(
  "Design authentication UI|high|frontend,ui"
  "Implement JWT middleware|high|backend,security"
  "Add login endpoint|high|backend,api"
  "Add logout endpoint|medium|backend,api"
  "Write auth tests|medium|testing"
  "Update API documentation|low|docs"
)

for task_spec in "${TASKS[@]}"; do
  IFS='|' read -r title priority labels <<< "$task_spec"
  claude-todo add "$title" \
    --status pending \
    --priority "$priority" \
    --labels "$labels"
done
```

### Task Dependencies

Manage task dependencies and blockers:

```bash
# Create base task
BASE_TASK=$(claude-todo add "Design API schema" \
  --priority high --format json | jq -r '.id')

# Create dependent task
claude-todo add "Implement API endpoints" \
  --depends "$BASE_TASK" \
  --status pending \
  --notes "Blocked until API schema is finalized"

# Create blocker-aware task
claude-todo add "Deploy to staging" \
  --blocked-by "$BASE_TASK" \
  --status blocked
```

### Bulk Status Updates

Update multiple task statuses:

```bash
#!/bin/bash
# start-sprint.sh - Mark all pending tasks as active

PENDING_TASKS=$(claude-todo list --status pending --format json | \
  jq -r '.tasks[].id')

for task_id in $PENDING_TASKS; do
  # Update status to active
  # Note: Would need update-task.sh script (extension point)
  echo "Activating: $task_id"
done
```

### Export Tasks

Export tasks to external formats:

```bash
# Export to CSV
claude-todo list --format json | \
  jq -r '.tasks[] | [.id, .title, .status, .priority] | @csv' > tasks.csv

# Export to GitHub Issues format
claude-todo list --format json | \
  jq '.tasks[] | "## \(.title)\n\n\(.description // "")\n\nPriority: \(.priority)\nLabels: \(.labels | join(", "))"'

# Export pending tasks to Markdown checklist
claude-todo list --status pending --format markdown > TODO.md
```

### Archive Management

Manage archive file size:

```bash
# Check archive size
wc -l .claude/todo-archive.json

# Archive all completed tasks immediately
claude-todo archive --all

# Extract specific archived task
cat .claude/todo-archive.json | jq '.tasks[] | select(.id == "T008")'

# List all archived tasks from specific date
cat .claude/todo-archive.json | \
  jq '.tasks[] | select(.completedAt | startswith("2025-11"))'
```

### Log Analysis

Analyze change log for insights:

```bash
# Count operations by type
cat .claude/todo-log.json | jq '[.entries[] | .operation] | group_by(.) | map({key: .[0], count: length}) | from_entries'

# Find tasks with most changes
cat .claude/todo-log.json | jq '[.entries[] | .task_id] | group_by(.) | map({task: .[0], changes: length}) | sort_by(.changes) | reverse | .[0:5]'

# Tasks completed in last 7 days
SEVEN_DAYS_AGO=$(date -d '7 days ago' -Iseconds)
cat .claude/todo-log.json | \
  jq --arg since "$SEVEN_DAYS_AGO" '.entries[] | select(.operation == "complete" and .timestamp > $since)'
```

---

## CLAUDE.md Integration

### Overview

The claude-todo system integrates with Claude Code through `.claude/CLAUDE.md` for automated task management during development sessions.

### Session Workflow

#### 1. Session Initialization

```markdown
<!-- .claude/CLAUDE.md -->

# Project Instructions for Claude Code

## Current Tasks

<!-- CLAUDE-TODO-START -->
Run: claude-todo list --status pending --format markdown
<!-- CLAUDE-TODO-END -->

## Active Sprint

Priority tasks for this session:
- Implement authentication
- Add user dashboard
- Fix navigation bug
```

#### 2. During Development

Claude Code can:
- Create tasks: `claude-todo add "New task"`
- Complete tasks: `claude-todo complete <id>`
- List tasks: `claude-todo list`
- Check stats: `claude-todo stats`

#### 3. Session End

```bash
# Archive completed tasks
claude-todo archive

# Create session backup
claude-todo backup --name "session-2025-12-05"

# Review statistics
claude-todo stats --period 1
```

### Automated Task Tracking

#### TodoWrite Integration

When Claude Code uses `TodoWrite` tool:

```typescript
// Claude Code creates internal todos
TodoWrite([
  { content: "Implement JWT middleware", status: "pending", activeForm: "Implementing JWT middleware" },
  { content: "Add login endpoint", status: "pending", activeForm: "Adding login endpoint" }
])

// Automatically sync to claude-todo system
claude-todo add "Implement JWT middleware" --status pending
claude-todo add "Add login endpoint" --status pending
```

#### Task Completion Automation

```bash
# When Claude Code marks internal todo complete
# Trigger: TodoWrite status change to "completed"

claude-todo complete <task-id>
```

### Best Practices

1. **Session Start**:
   - List active tasks: `claude-todo list`
   - Review high-priority items
   - Understand dependencies

2. **During Session**:
   - Create tasks for new work discovered
   - Complete tasks as work finishes
   - Add notes for context

3. **Session End**:
   - Archive completed tasks
   - Update blocked tasks
   - Create backup

4. **Cross-Session**:
   - Reference task IDs in commits
   - Link tasks to PRs
   - Maintain audit trail

---

## Filtering and Searching

### Status-Based Filtering

```bash
# All pending work
claude-todo list --status pending

# Currently active tasks
claude-todo list --status active

# Blocked tasks requiring attention
claude-todo list --status blocked

# Recently completed
claude-todo list --status done --limit 10
```

### Priority Filtering

```bash
# Critical tasks only
claude-todo list --priority critical

# High + Critical
claude-todo list --priority high,critical

# Non-urgent work
claude-todo list --priority low,medium
```

### Label-Based Filtering

```bash
# All backend tasks
claude-todo list --label backend

# Security-related work
claude-todo list --label security

# Frontend UI tasks
claude-todo list --label frontend --label ui
```

### Date-Based Filtering

```bash
# Tasks from last week
claude-todo list --since 2025-11-28

# Tasks from specific date range
claude-todo list \
  --since 2025-11-01 \
  --until 2025-11-30

# Today's tasks
claude-todo list --since $(date -Idate)
```

### Complex Queries

```bash
# High-priority backend tasks
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
```

### Using jq for Advanced Filtering

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

# Long-running active tasks (>7 days)
claude-todo list --status active --format json | \
  jq --arg date "$(date -d '7 days ago' -Iseconds)" \
    '.tasks[] | select(.createdAt < $date)'
```

---

## Configuration

### Configuration File Location

`.claude/todo-config.json` (per-project)

### Configuration Options

```json
{
  "$schema": "../schemas/config.schema.json",
  "version": "2.1.0",

  "archive": {
    "enabled": true,
    "daysUntilArchive": 7,
    "maxCompletedTasks": 15,
    "preserveRecentCount": 3,
    "archiveOnSessionEnd": true
  },

  "validation": {
    "strictMode": false,
    "checksumEnabled": true,
    "enforceAcceptance": true,
    "requireDescription": false,
    "maxActiveTasks": 1,
    "validateDependencies": true,
    "detectCircularDeps": true
  },

  "logging": {
    "enabled": true,
    "retentionDays": 30,
    "level": "standard",
    "logSessionEvents": true
  },

  "defaults": {
    "priority": "medium",
    "phase": "core",
    "labels": []
  },

  "session": {
    "requireSessionNote": true,
    "warnOnNoFocus": true,
    "autoStartSession": true,
    "sessionTimeoutHours": 24
  },

  "display": {
    "showArchiveCount": true,
    "showLogSummary": true,
    "warnStaleDays": 30
  }
}
```

### Configuration Fields

#### Archive Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable archive functionality |
| `daysUntilArchive` | integer | `7` | Days after completion before eligible for archive |
| `maxCompletedTasks` | integer | `15` | Max completed tasks before triggering archive |
| `preserveRecentCount` | integer | `3` | Always keep this many recent completed tasks |
| `archiveOnSessionEnd` | boolean | `true` | Check archive eligibility when session ends |

#### Validation Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strictMode` | boolean | `false` | Treat warnings as errors |
| `checksumEnabled` | boolean | `true` | Enable checksum verification (anti-hallucination) |
| `enforceAcceptance` | boolean | `true` | Require acceptance criteria for high/critical tasks |
| `requireDescription` | boolean | `false` | Require description field for all tasks |
| `maxActiveTasks` | integer | `1` | Maximum concurrent active tasks |
| `validateDependencies` | boolean | `true` | Check all depends[] references exist and are valid |
| `detectCircularDeps` | boolean | `true` | Detect and block circular dependencies |

#### Logging Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable change logging |
| `retentionDays` | integer | `30` | Days to retain log entries |
| `level` | string | `"standard"` | Log level (`minimal`, `standard`, `verbose`) |
| `logSessionEvents` | boolean | `true` | Log session start/end events |

#### Display Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `showArchiveCount` | boolean | `true` | Show archived task count in status output |
| `showLogSummary` | boolean | `true` | Show recent log summary |
| `warnStaleDays` | integer | `30` | Warn about tasks pending longer than this |

### Environment Variables

Override config with environment variables:

```bash
# Archive settings
export CLAUDE_TODO_ARCHIVE_DAYS=14
export CLAUDE_TODO_MAX_ARCHIVE_SIZE=5000

# Validation
export CLAUDE_TODO_STRICT_MODE=false
export CLAUDE_TODO_ALLOW_DUPLICATES=true

# Display
export CLAUDE_TODO_COLORS=false
export CLAUDE_TODO_DATE_FORMAT=relative

# Run command with overrides
claude-todo list
```

---

## Examples and Recipes

### Example 1: Sprint Planning

```bash
#!/bin/bash
# sprint-setup.sh - Initialize new sprint tasks

SPRINT_LABEL="sprint-12"

# Authentication tasks
claude-todo add "Design authentication UI" \
  --priority high \
  --labels "frontend,ui,$SPRINT_LABEL" \
  --acceptance "Mockups approved,Responsive design,Accessibility compliant"

AUTH_API=$(claude-todo add "Implement auth API" \
  --priority high \
  --labels "backend,api,$SPRINT_LABEL" \
  --format json | jq -r '.id')

claude-todo add "Integrate auth UI with API" \
  --depends "$AUTH_API" \
  --priority high \
  --labels "frontend,integration,$SPRINT_LABEL"

claude-todo add "Write auth tests" \
  --priority medium \
  --labels "testing,$SPRINT_LABEL" \
  --description "Unit tests for API + E2E tests for UI flow"

# List sprint tasks
claude-todo list --label "$SPRINT_LABEL" --format markdown > SPRINT.md
```

### Example 2: Bug Triage Workflow

```bash
#!/bin/bash
# triage-bugs.sh - Process bug reports

# Create bug tracking tasks
for bug_id in BUG-101 BUG-102 BUG-103; do
  claude-todo add "Investigate $bug_id" \
    --status pending \
    --priority high \
    --labels "bug,investigation" \
    --description "Root cause analysis for $bug_id" \
    --notes "Reported by QA team on 2025-12-05"
done

# List all bugs
claude-todo list --label bug --format table
```

### Example 3: Daily Standup Report

```bash
#!/bin/bash
# standup-report.sh - Generate daily standup summary

echo "# Daily Standup - $(date -Idate)"
echo ""

echo "## Yesterday (Completed)"
claude-todo list \
  --status done \
  --since $(date -d '1 day ago' -Idate) \
  --format markdown

echo ""
echo "## Today (In Progress)"
claude-todo list \
  --status active \
  --format markdown

echo ""
echo "## Blockers"
claude-todo list \
  --status blocked \
  --format markdown

echo ""
echo "## Statistics"
claude-todo stats --period 7
```

### Example 4: Release Preparation

```bash
#!/bin/bash
# prepare-release.sh - Pre-release checklist

RELEASE_VERSION="v2.0.0"

# Create release tasks
TASKS=(
  "Update version numbers|critical|release"
  "Run full test suite|critical|testing,release"
  "Update CHANGELOG.md|high|docs,release"
  "Create release notes|high|docs,release"
  "Tag release in git|high|release"
  "Build production artifacts|critical|build,release"
  "Deploy to staging|high|deployment,release"
  "QA approval|critical|qa,release"
  "Deploy to production|critical|deployment,release"
  "Post-release monitoring|medium|ops,release"
)

echo "Creating release tasks for $RELEASE_VERSION..."

for task_spec in "${TASKS[@]}"; do
  IFS='|' read -r title priority labels <<< "$task_spec"
  claude-todo add "$title" \
    --status pending \
    --priority "$priority" \
    --labels "$labels,$RELEASE_VERSION"
done

# Generate release checklist
claude-todo list \
  --label "$RELEASE_VERSION" \
  --sort priority \
  --reverse \
  --format markdown > "RELEASE-$RELEASE_VERSION.md"

echo "Release checklist created: RELEASE-$RELEASE_VERSION.md"
```

### Example 5: End-of-Sprint Cleanup

```bash
#!/bin/bash
# sprint-cleanup.sh - Clean up after sprint completion

SPRINT_LABEL="sprint-12"

echo "Sprint $SPRINT_LABEL Cleanup"
echo "=============================="

# Archive completed tasks
echo "Archiving completed tasks..."
claude-todo archive --force

# Report incomplete tasks
echo ""
echo "Incomplete Sprint Tasks:"
claude-todo list \
  --label "$SPRINT_LABEL" \
  --status pending,active,blocked \
  --format markdown

# Generate sprint statistics
echo ""
echo "Sprint Statistics:"
claude-todo stats --period 14

# Create sprint backup
echo ""
echo "Creating backup..."
claude-todo backup --name "sprint-$SPRINT_LABEL-end"

echo ""
echo "Cleanup complete!"
```

### Example 6: Task Dependency Graph

```bash
#!/bin/bash
# dependency-graph.sh - Visualize task dependencies

# Extract tasks with dependencies
claude-todo list --format json | \
  jq -r '.tasks[] | select(.depends | length > 0) |
         "\(.title) depends on: \(.depends | join(", "))"'

# Generate DOT graph format
echo "digraph tasks {"
claude-todo list --format json | \
  jq -r '.tasks[] | select(.depends | length > 0) |
         .depends[] as $dep | "  \"\($dep)\" -> \"\(.id)\";"'
echo "}"
```

---

## Troubleshooting

### Common Issues

**Issue**: Validation errors after manual JSON edits

**Solution**:
```bash
# Validate and attempt automatic fixes
claude-todo validate --fix

# If automatic fix fails, restore from backup
claude-todo restore .claude/.backups/todo.json.1
```

**Issue**: Task not found by ID

**Solution**:
```bash
# Check if task was archived
claude-todo list --all | grep <task-id>

# Search in archive file directly
cat .claude/todo-archive.json | jq '.tasks[] | select(.id == "<task-id>")'
```

**Issue**: Archive not working

**Solution**:
```bash
# Check archive configuration
cat .claude/todo-config.json | jq '.archive'

# Force archive all completed tasks
claude-todo archive --force
```

**Issue**: Backup restoration failed

**Solution**:
```bash
# Verify backup integrity first
claude-todo validate --file .claude/.backups/todo.json.1

# List all available backups
ls -lah .claude/.backups/

# Restore from specific backup
claude-todo restore .claude/.backups/backup-2025-12-05-100000/
```

---

## Next Steps

- **Configuration**: See [configuration.md](configuration.md) for detailed config options
- **Schema Reference**: See [schema-reference.md](schema-reference.md) for complete data structure
- **Troubleshooting**: See [troubleshooting.md](troubleshooting.md) for common issues
- **Installation**: See [installation.md](installation.md) for setup details

---

## Quick Reference Card

```
# Essential Commands
init.sh              # Initialize project
add-task.sh "title"  # Create task
update-task.sh ID    # Update task fields
list-tasks.sh        # Show tasks
complete-task.sh ID  # Mark complete
archive.sh           # Archive old tasks
validate.sh          # Check integrity
stats.sh             # View statistics
backup.sh            # Create backup
restore.sh DIR       # Restore backup

# Common Filters
--status pending     # Pending tasks only
--priority high      # High priority
--label backend      # Backend tasks
--since 2025-12-01   # Recent tasks
--sort createdAt     # Sort by date
--reverse            # Reverse order
--limit 10           # First 10 tasks
--format json        # JSON output

# Status Values
pending, active, blocked, done

# Priority Values
low, medium, high, critical
```
