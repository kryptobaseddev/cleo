# Command Reference

Complete reference for all claude-todo commands with usage syntax, options, examples, and behavior details.

---

## Table of Contents

- [Quick Reference](#quick-reference)
- [Core Commands](#core-commands)
  - [init](#init)
  - [add](#add)
  - [update](#update)
  - [complete](#complete)
  - [list](#list)
- [Data Management](#data-management)
  - [archive](#archive)
  - [export](#export)
  - [validate](#validate)
- [Reporting & Analysis](#reporting--analysis)
  - [stats](#stats)
- [Backup & Recovery](#backup--recovery)
  - [backup](#backup)
  - [restore](#restore)
- [Command Aliases](#command-aliases)

---

## Quick Reference

| Command | Purpose | Common Usage |
|---------|---------|--------------|
| `init` | Initialize project | `claude-todo init` |
| `add` | Create task | `claude-todo add "Task title" -p high` |
| `update` | Update task | `claude-todo update T001 -s active` |
| `complete` | Mark task done | `claude-todo complete T001` |
| `list` | Display tasks | `claude-todo list -s pending -f json` |
| `archive` | Archive completed | `claude-todo archive --dry-run` |
| `export` | Export tasks | `claude-todo export -f csv` |
| `validate` | Validate files | `claude-todo validate --fix` |
| `stats` | Show statistics | `claude-todo stats --period 7` |
| `backup` | Create backup | `claude-todo backup --compress` |
| `restore` | Restore backup | `claude-todo restore <dir>` |

---

## Core Commands

### init

Initialize the todo system in a project.

**Usage:**
```bash
claude-todo init [OPTIONS]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--force` | Overwrite existing todo files |
| `--template <path>` | Use custom template instead of default |
| `-h, --help` | Display help message |

**Examples:**
```bash
# Standard initialization
claude-todo init

# Force re-initialization
claude-todo init --force

# Initialize with custom template
claude-todo init --template ~/my-todo-template.json
```

**Creates:**
- `.claude/` directory
- `todo.json` (active tasks)
- `todo-archive.json` (completed tasks)
- `todo-config.json` (configuration)
- `todo-log.json` (change history)

**Side Effects:**
- Adds `.claude/*.json` to `.gitignore`
- Integrates with `CLAUDE.md` if present (unless `--no-claude-md`)
- Validates all created files

---

### add

Create a new task with validation.

**Usage:**
```bash
claude-todo add "TASK_TITLE" [OPTIONS]
```

**Required Arguments:**
- `TASK_TITLE`: Task description (quoted if contains spaces)

**Options:**
| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| `--status` | `-s` | enum | `pending` | Task status |
| `--priority` | `-p` | enum | `medium` | Task priority |
| `--description` | | string | | Detailed description |
| `--files` | | array | | Comma-separated file paths |
| `--acceptance` | | array | | Comma-separated acceptance criteria |
| `--depends` | | array | | Task IDs this depends on |
| `--blocked-by` | | array | | Blocking task IDs |
| `--notes` | | string | | Additional notes |
| `--labels` | `-l` | array | | Comma-separated tags |
| `--phase` | | string | | Project phase slug |
| `--format` | `-f` | enum | `text` | Output format |
| `--quiet` | `-q` | flag | | Suppress messages |

**Status Values:** `pending`, `active`, `blocked`, `done`
**Priority Values:** `low`, `medium`, `high`, `critical`

**Examples:**
```bash
# Simple task
claude-todo add "Fix navigation bug"

# Task with priority
claude-todo add "Security audit" -p critical

# Complex task with all fields
claude-todo add "Implement user authentication" \
  -s pending \
  -p high \
  --description "Add JWT-based auth with email/password" \
  --files "src/auth/jwt.ts,src/middleware/auth.ts" \
  --acceptance "Login endpoint works,Token refresh implemented" \
  -l "backend,security" \
  --notes "Reference: https://jwt.io/introduction"

# Dependent task
claude-todo add "Add logout endpoint" \
  --depends T001 \
  --description "Implement logout with token invalidation"

# Quiet mode with JSON output
claude-todo add "Deploy to staging" -p high -f json -q
```

**Validation:**
- Title must not be empty
- Status must be valid enum value
- Dependencies/blockers must reference existing tasks
- Duplicate titles trigger warning
- All fields validated against schema

**Side Effects:**
- Generates unique task ID (format: `T###`)
- Adds `createdAt` timestamp
- Logs operation to `todo-log.json`
- Creates backup before write
- Returns task ID on success

---

### update

Update an existing task's fields.

**Usage:**
```bash
claude-todo update TASK_ID [OPTIONS]
```

**Required Arguments:**
- `TASK_ID`: Task identifier (e.g., T001)

**Scalar Field Options:**
| Option | Type | Description |
|--------|------|-------------|
| `--title "text"` | string | Update task title |
| `--status STATUS` | enum | Change status (pending\|active\|blocked) |
| `--priority PRIORITY` | enum | Update priority |
| `--description DESC` | string | Update description |
| `--phase PHASE` | string | Update phase slug |
| `--blocked-by REASON` | string | Set blocked reason (status becomes blocked) |

**Array Field Options:**

**Append Mode (default):**
| Option | Description |
|--------|-------------|
| `--labels LABELS` | Append comma-separated labels |
| `--files FILES` | Append comma-separated file paths |
| `--acceptance CRIT` | Append comma-separated criteria |
| `--depends IDS` | Append task ID dependencies |
| `--notes NOTE` | Add timestamped note (always appends) |

**Replace Mode:**
| Option | Description |
|--------|-------------|
| `--set-labels LABELS` | Replace all labels |
| `--set-files FILES` | Replace all files |
| `--set-acceptance CRIT` | Replace all acceptance criteria |
| `--set-depends IDS` | Replace all dependencies |

**Clear Mode:**
| Option | Description |
|--------|-------------|
| `--clear-labels` | Remove all labels |
| `--clear-files` | Remove all files |
| `--clear-acceptance` | Remove all acceptance criteria |
| `--clear-depends` | Remove all dependencies |

**Examples:**
```bash
# Update priority
claude-todo update T001 --priority high

# Add labels (appends to existing)
claude-todo update T002 --labels "bug,urgent"

# Replace all labels
claude-todo update T003 --set-labels "frontend,ui"

# Set task as blocked
claude-todo update T004 --blocked-by "Waiting for API spec"

# Add a note (always timestamped)
claude-todo update T005 --notes "Started implementation"

# Multiple updates at once
claude-todo update T006 -p critical -l "security" --notes "Urgent review"

# Clear and set new values
claude-todo update T007 --clear-files --set-labels "backend,api"
```

**Validation:**
- Task must exist and not be completed (done status)
- Status transitions validated (cannot set to done - use `complete`)
- Only one active task allowed (enforced)
- Labels must be lowercase alphanumeric with hyphens
- Dependencies must reference existing task IDs
- All updates logged to audit trail

**Side Effects:**
- Adds `updatedAt` timestamp
- Logs operation with before/after state
- Creates backup before write
- Notes automatically timestamped

---

### complete

Mark a task as complete.

**Usage:**
```bash
claude-todo complete TASK_ID [OPTIONS]
```

**Required Arguments:**
- `TASK_ID`: Task identifier

**Options:**
| Option | Description |
|--------|-------------|
| `--skip-archive` | Don't trigger auto-archive even if configured |
| `--format` | Output format (`text`, `json`) |
| `--quiet` | Suppress messages |

**Examples:**
```bash
# Simple completion
claude-todo complete T003

# Complete without triggering auto-archive
claude-todo complete T003 --skip-archive

# JSON output, quiet mode
claude-todo complete T003 -f json -q
```

**Validation:**
- Task must exist
- Task must not already be completed
- Valid status transition required (`pending`/`active`/`blocked` → `done`)

**Side Effects:**
- Updates task status to `done`
- Adds `completedAt` timestamp
- Logs completion to `todo-log.json`
- Triggers auto-archive if enabled
- Creates backup before modification

---

### list

Display tasks with filtering and formatting options.

**Usage:**
```bash
claude-todo list [OPTIONS]
```

**Filter Options:**
| Option | Short | Type | Description |
|--------|-------|------|-------------|
| `--status` | `-s` | enum | Filter by status |
| `--priority` | `-p` | enum | Filter by priority |
| `--phase` | | string | Filter by phase slug |
| `--label` | `-l` | string | Filter by label |
| `--since` | | date | Tasks created after date (YYYY-MM-DD) |
| `--until` | | date | Tasks created before date |
| `--limit` | | integer | Limit results to N tasks |
| `--all` | | flag | Include archived tasks |

**Display Options:**
| Option | Short | Description |
|--------|-------|-------------|
| `--format` | `-f` | Output format (`text`, `json`, `jsonl`, `csv`, `tsv`, `markdown`, `table`) |
| `--sort` | | Sort by field (`status`, `priority`, `createdAt`, `title`) |
| `--reverse` | | Reverse sort order |
| `--compact` | `-c` | Compact one-line per task view |
| `--flat` | | Don't group by priority (flat list) |
| `--verbose` | `-v` | Show all task details |
| `--quiet` | `-q` | Suppress informational messages |

**CSV/TSV Options:**
| Option | Description |
|--------|-------------|
| `--delimiter` | Custom delimiter character |
| `--no-header` | Omit header row |

**Examples:**
```bash
# All active tasks (default)
claude-todo list

# Only pending tasks
claude-todo list -s pending

# High priority tasks
claude-todo list -p high

# Backend tasks only
claude-todo list -l backend

# Recent tasks (last 7 days)
claude-todo list --since 2025-12-05

# JSON output for scripting
claude-todo list -f json

# CSV export
claude-todo list -f csv > tasks.csv

# Compact view of pending tasks
claude-todo list -s pending -c

# Verbose mode with all details
claude-todo list -v

# Sort by creation date, newest first
claude-todo list --sort createdAt --reverse
```

**Output Formats:**

**Text (default):**
```
📋 Active Tasks (3)

[pending] Fix navigation bug
  ID: T001
  Priority: medium
  Created: 2025-12-05T10:00:00Z
```

**JSON:**
```json
{
  "_meta": {
    "version": "2.1.0",
    "timestamp": "2025-12-12T10:00:00Z",
    "count": 3,
    "filtered": true,
    "filters": {"status": ["pending"]}
  },
  "tasks": [...]
}
```

**JSONL (streaming, one task per line):**
```
{"id":"T001","title":"Fix bug","status":"pending"}
{"id":"T002","title":"Add feature","status":"active"}
```

**CSV/TSV (RFC 4180 compliant):**
```csv
id,title,status,priority,labels
T001,"Fix bug",pending,medium,"backend,security"
T002,"Add feature",active,high,"frontend"
```

---

## Data Management

### archive

Archive completed tasks based on retention policy.

**Usage:**
```bash
claude-todo archive [OPTIONS]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--dry-run` | Preview without making changes |
| `--force` | Archive all completed (respects preserveRecentCount) |
| `--all` | Archive ALL completed tasks (bypasses preserve setting) |
| `--count N` | Override maxCompletedTasks setting |

**Examples:**
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

**Configuration:**
Controlled by `.claude/todo-config.json`:
```json
{
  "archive": {
    "enabled": true,
    "daysUntilArchive": 7,
    "preserveRecentCount": 3,
    "archiveOnSessionEnd": true
  }
}
```

**Validation:**
- Only `done` tasks archived
- Age threshold enforced unless `--force`
- Archive size limits respected
- Referential integrity maintained

**Side Effects:**
- Moves tasks from `todo.json` to `todo-archive.json`
- Logs operation to `todo-log.json`
- Creates backups of both files
- Updates checksum

---

### export

Export tasks to various formats for integration with external tools.

**Usage:**
```bash
claude-todo export [OPTIONS]
```

**Options:**
| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| `--format` | `-f` | enum | `todowrite` | Output format |
| `--status` | `-s` | array | `pending,active` | Status filter |
| `--max` | | integer | `10` | Maximum tasks to export |
| `--output` | | path | stdout | Write to file |
| `--quiet` | `-q` | flag | | Suppress messages |
| `--delimiter` | | char | auto | Custom delimiter (CSV/TSV) |
| `--no-header` | | flag | | Omit header row (CSV/TSV) |

**Format Values:** `todowrite`, `json`, `jsonl`, `csv`, `tsv`, `markdown`

**Examples:**
```bash
# Export to TodoWrite format (for Claude Code)
claude-todo export -f todowrite

# Export only active tasks
claude-todo export -f todowrite -s active

# Export as markdown checklist
claude-todo export -f markdown

# Export to CSV file
claude-todo export -f csv --output tasks.csv

# Export to TSV without header
claude-todo export -f tsv --no-header

# Export to JSONL for streaming
claude-todo export -f jsonl --output tasks.jsonl

# Custom delimiter (pipe-separated)
claude-todo export -f csv --delimiter '|' --output tasks.psv
```

**TodoWrite Format:**
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

**Status Mapping:**
| claude-todo | TodoWrite |
|-------------|-----------|
| pending | pending |
| active | in_progress |
| blocked | pending |
| done | completed |

---

### validate

Validate all todo JSON files against schemas and anti-hallucination checks.

**Usage:**
```bash
claude-todo validate [OPTIONS]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--fix` | Attempt automatic repairs |
| `--strict` | Enable strict validation mode |
| `--file <path>` | Validate specific file only |
| `--verbose` | Show detailed validation output |

**Examples:**
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

**Validation Checks:**

**1. Schema Validation:**
- JSON syntax correctness
- Required fields present
- Field types match schema
- Enum values valid

**2. Anti-Hallucination Checks:**
- ID uniqueness within file
- ID uniqueness across todo + archive
- Status values from allowed enum
- Timestamp sanity (not future dates)
- `completedAt` after `createdAt`
- No duplicate task titles

**3. Referential Integrity:**
- Dependencies reference valid tasks
- Blockers reference valid tasks
- Archive contains only `done` tasks
- Log entries reference valid tasks

**Exit Codes:**
- `0`: All valid
- `1`: Schema errors
- `2`: Semantic errors
- `3`: Both schema and semantic errors

---

## Reporting & Analysis

### stats

Display task statistics and productivity reports.

**Usage:**
```bash
claude-todo stats [OPTIONS]
```

**Options:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--period` | integer | `30` | Analysis period in days |
| `--format` | enum | `text` | Output format (`text`, `json`, `csv`) |
| `--chart` | flag | | Include ASCII charts |
| `--detailed` | flag | | Show detailed breakdown |

**Examples:**
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
claude-todo stats -f json

# CSV export for spreadsheets
claude-todo stats -f csv > stats.csv
```

**Output Sections:**
- Current State (by status)
- Period Analysis (created/completed)
- Priority Distribution
- Label Distribution
- Archive Statistics
- Productivity Trends

---

## Backup & Recovery

### backup

Create backup of todo files.

**Usage:**
```bash
claude-todo backup [OPTIONS]
```

**Options:**
| Option | Type | Description |
|--------|------|-------------|
| `--destination` | path | Backup destination (default: `.claude/.backups/`) |
| `--compress` | flag | Compress backup with gzip |
| `--name` | string | Custom backup name |

**Examples:**
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

**Backs Up:**
- `todo.json`
- `todo-archive.json`
- `todo-config.json`
- `todo-log.json`

**Side Effects:**
- Creates timestamped backup directory
- Validates backup integrity
- Reports backup location and size

---

### restore

Restore todo files from backup.

**Usage:**
```bash
claude-todo restore BACKUP_DIR [OPTIONS]
```

**Required Arguments:**
- `BACKUP_DIR`: Path to backup directory

**Options:**
| Option | Description |
|--------|-------------|
| `--force` | Skip confirmation prompt |
| `--verify` | Verify backup before restore |
| `--no-backup` | Don't backup current files before restore |

**Examples:**
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

**Workflow:**
1. Validates backup directory exists
2. Verifies backup file integrity
3. Backs up current files (unless `--no-backup`)
4. Copies backup files to `.claude/`
5. Validates restored files
6. Confirms success or rolls back on error

---

## Command Aliases

Built-in aliases for faster workflows (v0.6.0+):

| Alias | Command | Description |
|-------|---------|-------------|
| `ls` | `list` | List tasks |
| `done` | `complete` | Complete task |
| `new` | `add` | Create task |
| `edit` | `update` | Update task |
| `rm` | `archive` | Archive tasks |
| `check` | `validate` | Validate files |

**Examples:**
```bash
claude-todo ls -s pending
claude-todo done T001
claude-todo new "Task title"
claude-todo edit T002 -p high
claude-todo rm --dry-run
claude-todo check --fix
```

**Custom Aliases:**
Configure in `~/.claude-todo/config.json`:
```json
{
  "cli": {
    "aliases": {
      "s": "stats",
      "b": "backup",
      "v": "validate"
    }
  }
}
```

---

## Short Flags Reference

All commands support short flags for faster workflows:

| Short | Long | Commands | Description |
|-------|------|----------|-------------|
| `-s` | `--status` | list, add, update, export | Filter by or set status |
| `-p` | `--priority` | list, add, update | Filter by or set priority |
| `-l` | `--label/--labels` | list, add, update | Filter by or set labels |
| `-f` | `--format` | list, export, stats | Output format |
| `-v` | `--verbose` | list, validate | Show all details |
| `-c` | `--compact` | list | Compact one-line view |
| `-q` | `--quiet` | list, add, export | Suppress messages |
| `-h` | `--help` | all | Show command help |

---

## Exit Codes

Standard exit codes across all commands:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error |
| `2` | Validation error |
| `3` | File not found |
| `4` | Permission denied |
| `5` | Invalid arguments |

---

## Environment Variables

Override configuration with environment variables:

```bash
# Archive settings
export CLAUDE_TODO_ARCHIVE_DAYS=14

# Validation
export CLAUDE_TODO_STRICT_MODE=false

# Display
export NO_COLOR=1          # Disable colors
export FORCE_COLOR=1       # Force colors
```

---

## See Also

- [Usage Guide](../usage.md) - Comprehensive usage patterns
- [Configuration Reference](../configuration.md) - All config options
- [Schema Reference](../reference/schema-reference.md) - Data structures
- [Installation Guide](../getting-started/installation.md) - Setup instructions
