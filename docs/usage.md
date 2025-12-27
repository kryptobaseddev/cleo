# Usage Guide

Complete guide to using the cleo task management system.

---

## Table of Contents

1. [Quick Start](#quick-start)
   - [Short Flags Reference](#short-flags-reference)
   - [First-Time Setup](#first-time-setup)
   - [Daily Workflow](#daily-workflow)
   - [Command Aliases](#command-aliases-v060)
   - [Debug Mode](#debug-mode)
   - [Plugins](#plugins-v060)
2. [Basic Workflow](#basic-workflow)
   - [Creating Tasks](#creating-tasks)
   - [Listing Tasks](#listing-tasks)
   - [Completing Tasks](#completing-tasks)
   - [Archiving Tasks](#archiving-tasks)
3. [Detailed Guides](#detailed-guides)
4. [Configuration](#configuration)
   - [Configuration Options](#configuration-options)
   - [Environment Variables](#environment-variables)
   - [Color Output Control](#color-output-control)
5. [Troubleshooting](#troubleshooting)
6. [Quick Reference Card](#quick-reference-card)

---

## Quick Start

### New in v0.8.2: Phase 3 Features

**Dashboard Command**:
```bash
cleo dash              # Comprehensive project overview
cleo dash --compact    # Single-line summary
```

**Label Analytics**:
```bash
cleo labels            # List all labels
cleo labels show LABEL # Tasks with specific label
cleo labels stats      # Detailed statistics
```

**Smart Task Suggestion**:
```bash
cleo next              # Get next task suggestion
cleo next --explain    # Show reasoning
cleo next --count 3    # Top 3 suggestions
```

See detailed documentation:
- [dash command](commands/dash.md) - Dashboard and overview
- [labels command](commands/labels.md) - Label analytics
- [next command](commands/next.md) - Intelligent task suggestions

### Short Flags Reference

All commands support short flags for faster workflows:

| Short | Long | Commands | Description |
|-------|------|----------|-------------|
| `-s` | `--status` | list, add, update | Filter by or set task status |
| `-p` | `--priority` | list, add, update | Filter by or set task priority |
| `-l` | `--label/--labels` | list, add, update | Filter by or set labels |
| `-f` | `--format` | list, export | Output format |
| `-v` | `--verbose` | list | Show all task details |
| `-c` | `--compact` | list | Compact one-line view |
| `-q` | `--quiet` | list, add, export | Suppress informational messages |
| `-h` | `--help` | all | Show command help |

**Examples**:
```bash
# List high-priority backend tasks in JSON
cleo list -p high -l backend -f json

# Add critical security task quietly
cleo add "Security audit" -p critical -l security -q

# Compact view of pending tasks
cleo list -s pending -c
```

### First-Time Setup

```bash
# 1. Install globally
./install.sh

# 2. Navigate to your project
cd /path/to/your/project

# 3. Initialize todo system
cleo init

# 4. Create your first task
cleo add "Implement user authentication" \
  --status pending \
  --priority high \
  --description "Add JWT-based authentication with email/password login"
```

### Daily Workflow

```bash
# List current tasks
cleo list

# Mark task complete (with notes)
cleo complete <task-id> --notes "Description of what was done"

# Quick complete (skip notes)
cleo complete <task-id> --skip-notes

# View statistics
cleo stats
```

### Command Aliases (v0.6.0+)

Built-in aliases for faster workflows:

```bash
cleo ls              # Same as: list
cleo done T001       # Same as: complete T001
cleo new "Task"      # Same as: add "Task"
cleo edit T001       # Same as: update T001
cleo rm              # Same as: archive
cleo check           # Same as: validate
```

Aliases can be customized in `~/.cleo/config.json`:

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
cleo --validate

# Show all available commands (core + aliases + plugins)
cleo --list-commands

# Enable debug output for any command
CLEO_DEBUG=1 cleo list
```

### Plugins (v0.6.0+)

Create custom commands by adding scripts to `~/.cleo/plugins/`:

```bash
# Create a custom command
cat > ~/.cleo/plugins/my-report.sh << 'EOF'
#!/usr/bin/env bash
###PLUGIN
# description: Generate my custom report
###END
echo "My custom report!"
EOF

chmod +x ~/.cleo/plugins/my-report.sh

# Use it
cleo my-report
```

Project-local plugins can be placed in `./.cleo/plugins/`.

---

## Basic Workflow

### Creating Tasks

#### Simple Task Creation

```bash
# Minimal task (title only)
cleo add "Fix login bug"

# Task with status and priority
cleo add "Add user dashboard" \
  --status pending \
  --priority high

# Complete task with all fields
cleo add "Implement payment processing" \
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

### Listing Tasks

#### Basic Listing

```bash
# List all active tasks (default)
cleo list

# List tasks with specific status
cleo list --status pending

# List all tasks including archived
cleo list --all
```

#### Output Formats

```bash
# Human-readable terminal output (default)
cleo list --format text

# JSON with _meta envelope for scripting
cleo list --format json

# JSONL streaming format (one JSON object per line)
cleo list --format jsonl

# Markdown format for documentation
cleo list --format markdown

# ASCII table format
cleo list --format table

# CSV export (RFC 4180 compliant) - via export command
cleo export --format csv

# TSV export (tab-separated values) - via export command
cleo export --format tsv
```

**JSON Format Structure**:
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
  "tasks": [
    {
      "id": "T002",
      "title": "Implement authentication",
      "status": "active",
      "priority": "high"
    }
  ]
}
```

#### Filtering Options

```bash
# Filter by priority
cleo list --priority high

# Filter by label
cleo list --label backend

# Tasks created after specific date
cleo list --since 2025-12-01

# Limit number of results
cleo list --limit 10
```

### Completing Tasks

```bash
# Complete a task with notes (required by default)
cleo complete T001 --notes "Implemented feature. Tests passing."
cleo complete T001 -n "Fixed bug, verified with unit tests."

# Complete without notes (for quick completions)
cleo complete T001 --skip-notes

# Complete without triggering auto-archive
cleo complete T001 --notes "Done" --skip-archive
```

**Completion Notes (v0.7.2+)**:
Completion notes are required by default for better task tracking and audit trails.
Notes should describe: what was done, how it was verified, and relevant references
(commit hashes, PR numbers, documentation links).

Notes are stored in the task's `notes` array with a `[COMPLETED timestamp]` prefix
and preserved when the task is archived.

**What Happens on Completion**:
1. Task status changes from `pending`/`active` → `done`
2. `completedAt` timestamp added automatically
3. Completion note added to task's `notes` array (if provided)
4. Operation logged to `todo-log.json`
5. Auto-archive triggered if enabled in config
6. Success message displays task ID, completion time, and notes

### Archiving Tasks

```bash
# Archive completed tasks based on config retention
cleo archive

# Preview what would be archived
cleo archive --dry-run

# Force archive all completed (respects preserveRecentCount)
cleo archive --force

# Archive ALL completed tasks (ignores preserve setting)
cleo archive --all
```

**Automatic Archive** - Configure in `.cleo/config.json`:

```json
{
  "archive": {
    "enabled": true,
    "daysUntilArchive": 7,
    "archiveOnSessionEnd": true
  }
}
```

### Phase 3 Workflow Commands

#### Dashboard Overview

```bash
# Full dashboard at session start
cleo dash

# Quick status check
cleo dash --compact

# Focus on specific sections
cleo dash --sections focus,blocked,priority

# Extended activity period
cleo dash --period 14
```

#### Label-Based Organization

```bash
# List all labels
cleo labels

# See all backend tasks
cleo labels show backend

# Detailed label analytics
cleo labels stats

# Find tasks by label
cleo list --label security --priority high
```

#### Intelligent Task Selection

```bash
# Get next task suggestion
cleo next

# Understand why task is suggested
cleo next --explain

# See top 3 options
cleo next --count 3

# Auto-start suggested task
cleo next --format json | \
  jq -r '.suggestions[0].id' | \
  xargs -I {} cleo focus set {}
```

#### Combined Workflow

```bash
# Morning routine
cleo dash                    # Review status
cleo next --explain          # Get suggestion
cleo focus set T015          # Start work
cleo focus note "Starting"   # Add session note

# During work
cleo dash --compact          # Quick check
cleo labels show backend     # Review related tasks

# End of day
cleo complete T015 --notes "Implemented feature"
cleo next                    # What's next?
cleo dash --sections activity  # Review progress
```

---

## Detailed Guides

For comprehensive documentation on specific topics, see:

### Complete Command Reference
**[reference/command-reference.md](reference/command-reference.md)**

Detailed documentation for all commands including:
- `init` - Initialize todo system in a project
- `add` - Create new tasks with validation
- `update` - Update existing task fields
- `list` - Display tasks with filtering
- `complete` - Mark tasks complete
- `archive` - Archive completed tasks
- `export` - Export tasks to external formats
- `validate` - Validate JSON files
- `stats` - Display statistics and reports
- `backup` - Create backups
- `restore` - Restore from backup

### Phase 3 Commands (v0.8.2)
**New intelligent workflow commands**:

- **[dash](commands/dash.md)** - Comprehensive dashboard with focus, priority, blocked tasks, phase progress, and activity metrics
- **[labels](commands/labels.md)** - Label analytics with distribution charts, task filtering by label, and detailed statistics
- **[next](commands/next.md)** - Intelligent task suggestions based on priority, dependencies, and phase alignment

### Workflow Patterns & Best Practices
**[integration/WORKFLOWS.md](integration/WORKFLOWS.md)**

Complete workflow guides including:
- Task lifecycle and status transitions
- Session workflows (start, work, end)
- CLAUDE.md integration for Claude Code
- Batch operations and automation
- Sprint planning and release workflows
- Dependency management
- Best practices and anti-patterns

### Filtering & Query Guide
**[guides/filtering-guide.md](guides/filtering-guide.md)**

Advanced filtering and search techniques:
- Status-based filtering
- Priority and label filtering
- Date range queries
- Complex multi-field queries
- Using jq for advanced filtering
- Sorting and limiting results
- Export and reporting

### Configuration Reference
**[configuration.md](reference/configuration.md)**

Complete configuration documentation covering:
- Archive settings
- Validation rules
- Logging preferences
- Display options
- Session management
- Default values
- Environment variable overrides

---

## Configuration

### Configuration File Location

`.cleo/config.json` (per-project)

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

  "display": {
    "showArchiveCount": true,
    "showLogSummary": true,
    "warnStaleDays": 30
  }
}
```

**For complete configuration reference, see [configuration.md](reference/configuration.md)**

### Environment Variables

Override config with environment variables:

```bash
# Archive settings
export CLEO_ARCHIVE_DAYS=14
export CLEO_MAX_ARCHIVE_SIZE=5000

# Validation
export CLEO_STRICT_MODE=false

# Display
export CLEO_COLORS=false
```

### Color Output Control

Control color output using standard environment variables:

```bash
# Disable all colors (NO_COLOR standard)
export NO_COLOR=1
cleo list

# Force colors even without TTY (CI/CD)
export FORCE_COLOR=1
cleo list | tee output.log

# Per-command color control
NO_COLOR=1 cleo list
```

**Color Detection Logic**:
1. If `NO_COLOR` is set → colors disabled
2. If `FORCE_COLOR` is set → colors enabled
3. If stdout is not a TTY → colors disabled
4. Otherwise → colors enabled

This follows the [NO_COLOR](https://no-color.org/) standard for maximum compatibility.

---

## Troubleshooting

### Common Issues

**Issue**: Validation errors after manual JSON edits

**Solution**:
```bash
# Validate and attempt automatic fixes
cleo validate --fix

# If automatic fix fails, restore from backup
cleo restore .cleo/.backups/todo.json.1
```

**Issue**: Task not found by ID

**Solution**:
```bash
# Check if task was archived
cleo list --all | grep <task-id>

# Search in archive file directly
cat .cleo/todo-archive.json | jq '.tasks[] | select(.id == "<task-id>")'
```

**Issue**: Archive not working

**Solution**:
```bash
# Check archive configuration
cat .cleo/config.json | jq '.archive'

# Force archive all completed tasks
cleo archive --force
```

**Issue**: Backup restoration failed

**Solution**:
```bash
# Verify backup integrity first
cleo validate --file .cleo/.backups/todo.json.1

# List all available backups
ls -lah .cleo/.backups/

# Restore from Tier 2 snapshot backup
cleo restore .cleo/backups/snapshot/snapshot_20251205_100000/
```

**For complete troubleshooting guide, see [troubleshooting.md](reference/troubleshooting.md)**

---

## Quick Reference Card

```
# Essential Commands
init                 # Initialize project
add "title"          # Create task
update ID            # Update task fields
list                 # Show tasks
complete ID          # Mark complete
archive              # Archive old tasks
validate             # Check integrity
stats                # View statistics
backup               # Create backup
restore DIR          # Restore backup
export               # Export tasks

# Phase 3 Commands (v0.8.2)
dash                 # Dashboard overview
dash --compact       # Single-line summary
labels               # List all labels
labels show LABEL    # Tasks with label
next                 # Next task suggestion
next --explain       # Show reasoning

# Short Flags
-s, --status         # Filter/set status
-p, --priority       # Filter/set priority
-l, --label(s)       # Filter/set labels
-f, --format         # Output format
-v, --verbose        # Verbose output
-c, --compact        # Compact view
-q, --quiet          # Quiet mode
-h, --help           # Show help

# Common Filters
-s pending           # Pending tasks only
-p high              # High priority
-l backend           # Backend tasks
--since 2025-12-01   # Recent tasks
--sort createdAt     # Sort by date
--reverse            # Reverse order
--limit 10           # First 10 tasks

# Output Formats (list command)
-f text              # Human-readable (default)
-f json              # JSON with metadata
-f jsonl             # JSON Lines (streaming)
-f markdown          # Markdown checklist
-f table             # ASCII table

# Export Formats (export command)
-f csv               # CSV export
-f tsv               # Tab-separated
-f json              # JSON export
-f markdown          # Markdown export

# Status Values
pending, active, blocked, done

# Priority Values
low, medium, high, critical

# Color Control
NO_COLOR=1           # Disable colors
FORCE_COLOR=1        # Force colors

# Quick Examples
cleo list -p high -l backend -f json
cleo add "Task" -p critical -l security -q
cleo export -f csv > tasks.csv
NO_COLOR=1 cleo list -s pending -c
```

---

## Next Steps

- **Complete Command Reference**: [reference/command-reference.md](reference/command-reference.md)
- **Workflow Patterns**: [integration/WORKFLOWS.md](integration/WORKFLOWS.md)
- **Filtering Guide**: [guides/filtering-guide.md](guides/filtering-guide.md)
- **Configuration**: [configuration.md](reference/configuration.md)
- **Schema Reference**: [schema-reference.md](architecture/SCHEMAS.md)
- **Troubleshooting**: [troubleshooting.md](reference/troubleshooting.md)
- **Installation**: [installation.md](reference/installation.md)
