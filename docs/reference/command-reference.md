# Command Reference

Complete reference for all cleo commands with usage syntax, options, examples, and behavior details.

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
  - [claude-migrate](#claude-migrate)
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
| `init` | Initialize project | `cleo init` |
| `add` | Create task | `cleo add "Task title" -p high` |
| `update` | Update task | `cleo update T001 -s active` |
| `complete` | Mark task done | `cleo complete T001` |
| `list` | Display tasks | `cleo list -s pending -f json` |
| `archive` | Archive completed | `cleo archive --dry-run` |
| `export` | Export tasks | `cleo export -f csv` |
| `validate` | Validate files | `cleo validate --fix` |
| `claude-migrate` | Migrate legacy | `cleo claude-migrate --check` |
| `stats` | Show statistics | `cleo stats --period 7` |
| `backup` | Create backup | `cleo backup --compress` |
| `restore` | Restore backup | `cleo restore <dir>` |

---

## Core Commands

### init

Initialize the todo system in a project.

**Usage:**
```bash
cleo init [OPTIONS]
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
cleo init

# Force re-initialization
cleo init --force

# Initialize with custom template
cleo init --template ~/my-todo-template.json
```

**Creates:**
- `.cleo/` directory
- `todo.json` (active tasks)
- `todo-archive.json` (completed tasks)
- `config.json` (configuration)
- `todo-log.json` (change history)

**Side Effects:**
- Adds `.cleo/*.json` to `.gitignore`
- Integrates with `CLAUDE.md` if present (unless `--no-claude-md`)
- Validates all created files

---

### add

Create a new task with validation.

**Usage:**
```bash
cleo add "TASK_TITLE" [OPTIONS]
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
cleo add "Fix navigation bug"

# Task with priority
cleo add "Security audit" -p critical

# Complex task with all fields
cleo add "Implement user authentication" \
  -s pending \
  -p high \
  --description "Add JWT-based auth with email/password" \
  --files "src/auth/jwt.ts,src/middleware/auth.ts" \
  --acceptance "Login endpoint works,Token refresh implemented" \
  -l "backend,security" \
  --notes "Reference: https://jwt.io/introduction"

# Dependent task
cleo add "Add logout endpoint" \
  --depends T001 \
  --description "Implement logout with token invalidation"

# Quiet mode with JSON output
cleo add "Deploy to staging" -p high -f json -q
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
cleo update TASK_ID [OPTIONS]
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
cleo update T001 --priority high

# Add labels (appends to existing)
cleo update T002 --labels "bug,urgent"

# Replace all labels
cleo update T003 --set-labels "frontend,ui"

# Set task as blocked
cleo update T004 --blocked-by "Waiting for API spec"

# Add a note (always timestamped)
cleo update T005 --notes "Started implementation"

# Multiple updates at once
cleo update T006 -p critical -l "security" --notes "Urgent review"

# Clear and set new values
cleo update T007 --clear-files --set-labels "backend,api"
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
cleo complete TASK_ID [OPTIONS]
```

**Required Arguments:**
- `TASK_ID`: Task identifier

**Options:**
| Option | Description |
|--------|-------------|
| `--skip-archive` | Don't trigger auto-archive even if configured |

**Examples:**
```bash
# Simple completion
cleo complete T003

# Complete without triggering auto-archive
cleo complete T003 --skip-archive

# Complete with detailed notes
cleo complete T003 --notes "Implemented auth middleware. Tests passing."
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
- Clears focus if completed task was currently focused

---

### list

Display tasks with filtering and formatting options.

**Usage:**
```bash
cleo list [OPTIONS]
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
cleo list

# Only pending tasks
cleo list -s pending

# High priority tasks
cleo list -p high

# Backend tasks only
cleo list -l backend

# Recent tasks (last 7 days)
cleo list --since 2025-12-05

# JSON output for scripting
cleo list -f json

# CSV export (via export command)
cleo export -f csv > tasks.csv

# Compact view of pending tasks
cleo list -s pending -c

# Verbose mode with all details
cleo list -v

# Sort by creation date, newest first
cleo list --sort createdAt --reverse
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
cleo archive [OPTIONS]
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
cleo archive

# Preview what would be archived
cleo archive --dry-run

# Force archive all completed (respects preserveRecentCount)
cleo archive --force

# Archive ALL completed tasks (ignores preserve setting)
cleo archive --all

# Override max completed tasks threshold
cleo archive --count 20
```

**Configuration:**
Controlled by `.cleo/config.json`:
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
cleo export [OPTIONS]
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
cleo export -f todowrite

# Export only active tasks
cleo export -f todowrite -s active

# Export as markdown checklist
cleo export -f markdown

# Export to CSV file
cleo export -f csv --output tasks.csv

# Export to TSV without header
cleo export -f tsv --no-header

# Export to JSONL for streaming
cleo export -f jsonl --output tasks.jsonl

# Custom delimiter (pipe-separated)
cleo export -f csv --delimiter '|' --output tasks.psv
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
| cleo | TodoWrite |
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
cleo validate [OPTIONS]
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
cleo validate

# Validate with automatic fixes
cleo validate --fix

# Strict mode (no warnings ignored)
cleo validate --strict

# Validate specific file
cleo validate --file .cleo/todo.json

# Verbose validation
cleo validate --verbose
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

### claude-migrate

Detect and migrate legacy claude-todo installations to CLEO format.

**Usage:**
```bash
cleo claude-migrate --check              # Detect legacy installations
cleo claude-migrate --global             # Migrate ~/.claude-todo → ~/.cleo
cleo claude-migrate --project            # Migrate .claude → .cleo
cleo claude-migrate --all                # Migrate both
```

**Options:**
| Option | Description |
|--------|-------------|
| `--check` | Detect legacy installations (read-only) |
| `--global` | Migrate global installation |
| `--project` | Migrate project directory |
| `--all` | Migrate both global and project |
| `--format` | Output format: text, json |
| `--verbose`, `-v` | Show detailed output |

**Examples:**
```bash
# Check for legacy installations
cleo claude-migrate --check

# Check with JSON output
cleo claude-migrate --check --format json

# Migrate global installation
cleo claude-migrate --global

# Migrate project
cleo claude-migrate --project

# Migrate everything
cleo claude-migrate --all
```

**File Transformations:**
- Config: `todo-config.json` → `config.json`
- Log: `todo-log.json` (unchanged)
- Directories: `.claude/` → `.cleo/`, `~/.claude-todo/` → `~/.cleo/`

**Exit Codes (--check mode):**
- `0`: Legacy found (migration needed)
- `1`: No legacy found (clean)
- `2`: Error

**Exit Codes (migration modes):**
- `0`: Migration successful
- `1`: No legacy found
- `2`: Backup failed
- `3`: Move failed
- `4`: Validation failed

---

## Reporting & Analysis

### stats

Display task statistics and productivity reports.

**Usage:**
```bash
cleo stats [OPTIONS]
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
cleo stats

# Last 7 days
cleo stats --period 7

# Last 90 days with charts
cleo stats --period 90 --chart

# Detailed statistics
cleo stats --detailed

# JSON output for dashboards
cleo stats -f json

# CSV export for spreadsheets
cleo stats -f csv > stats.csv
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
cleo backup [OPTIONS]
```

**Options:**
| Option | Type | Description |
|--------|------|-------------|
| `--destination` | path | Backup destination (default: `.cleo/backups/snapshot/`) |
| `--compress` | flag | Compress backup with gzip |
| `--name` | string | Custom backup name |

**Examples:**
```bash
# Default backup
cleo backup

# Backup to custom location
cleo backup --destination ~/backups/todo-backup

# Compressed backup
cleo backup --compress

# Named backup
cleo backup --name "before-major-refactor"
```

**Backs Up:**
- `todo.json`
- `todo-archive.json`
- `config.json`
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
cleo restore BACKUP_DIR [OPTIONS]
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
# List available Tier 2 backups
ls -la .cleo/backups/snapshot/

# Restore from Tier 2 snapshot backup
cleo restore .cleo/backups/snapshot/snapshot_20251205_100000/

# Verify backup before restore
cleo restore .cleo/backups/snapshot/snapshot_20251205_100000/ --verify

# Force restore without confirmation
cleo restore .cleo/backups/snapshot/snapshot_20251205_100000/ --force
```

**Workflow:**
1. Validates backup directory exists
2. Verifies backup file integrity
3. Backs up current files (unless `--no-backup`)
4. Copies backup files to `.cleo/`
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
cleo ls -s pending
cleo done T001
cleo new "Task title"
cleo edit T002 -p high
cleo rm --dry-run
cleo check --fix
```

**Custom Aliases:**
Configure in `~/.cleo/config.json`:
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
export CLEO_ARCHIVE_DAYS=14

# Validation
export CLEO_STRICT_MODE=false

# Display
export NO_COLOR=1          # Disable colors
export FORCE_COLOR=1       # Force colors
```

---

## See Also

- [Usage Guide](../usage.md) - Comprehensive usage patterns
- [Configuration Reference](configuration.md) - All config options
- [Schema Reference](../architecture/SCHEMAS.md) - Data structures
- [Installation Guide](installation.md) - Setup instructions
