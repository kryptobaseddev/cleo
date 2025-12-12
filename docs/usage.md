# Usage Guide

Complete guide to using the claude-todo task management system.

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
claude-todo list -p high -l backend -f json

# Add critical security task quietly
claude-todo add "Security audit" -p critical -l security -q

# Compact view of pending tasks
claude-todo list -s pending -c
```

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

### Creating Tasks

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

### Listing Tasks

#### Basic Listing

```bash
# List all active tasks (default)
claude-todo list

# List tasks with specific status
claude-todo list --status pending

# List all tasks including archived
claude-todo list --all
```

#### Output Formats

```bash
# Human-readable terminal output (default)
claude-todo list --format text

# JSON with _meta envelope for scripting
claude-todo list --format json

# JSONL streaming format (one JSON object per line)
claude-todo list --format jsonl

# Markdown format for documentation
claude-todo list --format markdown

# ASCII table format
claude-todo list --format table

# CSV export (RFC 4180 compliant)
claude-todo list --format csv

# TSV export (tab-separated values)
claude-todo list --format tsv
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
claude-todo list --priority high

# Filter by label
claude-todo list --label backend

# Tasks created after specific date
claude-todo list --since 2025-12-01

# Limit number of results
claude-todo list --limit 10
```

### Completing Tasks

```bash
# Complete a task by ID
claude-todo complete T001

# Complete without triggering auto-archive
claude-todo complete T001 --skip-archive
```

**What Happens on Completion**:
1. Task status changes from `pending`/`active` → `done`
2. `completedAt` timestamp added automatically
3. Operation logged to `todo-log.json`
4. Auto-archive triggered if enabled in config
5. Success message displays task ID and completion time

### Archiving Tasks

```bash
# Archive completed tasks based on config retention
claude-todo archive

# Preview what would be archived
claude-todo archive --dry-run

# Force archive all completed (respects preserveRecentCount)
claude-todo archive --force

# Archive ALL completed tasks (ignores preserve setting)
claude-todo archive --all
```

**Automatic Archive** - Configure in `.claude/todo-config.json`:

```json
{
  "archive": {
    "enabled": true,
    "daysUntilArchive": 7,
    "archiveOnSessionEnd": true
  }
}
```

---

## Detailed Guides

For comprehensive documentation on specific topics, see:

### Complete Command Reference
**[guides/command-reference.md](guides/command-reference.md)**

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

### Workflow Patterns & Best Practices
**[guides/workflow-patterns.md](guides/workflow-patterns.md)**

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
**[configuration.md](guides/configuration.md)**

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

  "display": {
    "showArchiveCount": true,
    "showLogSummary": true,
    "warnStaleDays": 30
  }
}
```

**For complete configuration reference, see [configuration.md](guides/configuration.md)**

### Environment Variables

Override config with environment variables:

```bash
# Archive settings
export CLAUDE_TODO_ARCHIVE_DAYS=14
export CLAUDE_TODO_MAX_ARCHIVE_SIZE=5000

# Validation
export CLAUDE_TODO_STRICT_MODE=false

# Display
export CLAUDE_TODO_COLORS=false
```

### Color Output Control

Control color output using standard environment variables:

```bash
# Disable all colors (NO_COLOR standard)
export NO_COLOR=1
claude-todo list

# Force colors even without TTY (CI/CD)
export FORCE_COLOR=1
claude-todo list | tee output.log

# Per-command color control
NO_COLOR=1 claude-todo list
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

# Output Formats
-f text              # Human-readable (default)
-f json              # JSON with metadata
-f jsonl             # JSON Lines (streaming)
-f csv               # CSV export
-f tsv               # Tab-separated
-f markdown          # Markdown checklist
-f table             # ASCII table

# Status Values
pending, active, blocked, done

# Priority Values
low, medium, high, critical

# Color Control
NO_COLOR=1           # Disable colors
FORCE_COLOR=1        # Force colors

# Quick Examples
claude-todo list -p high -l backend -f json
claude-todo add "Task" -p critical -l security -q
claude-todo export -f csv > tasks.csv
NO_COLOR=1 claude-todo list -s pending -c
```

---

## Next Steps

- **Complete Command Reference**: [guides/command-reference.md](guides/command-reference.md)
- **Workflow Patterns**: [guides/workflow-patterns.md](guides/workflow-patterns.md)
- **Filtering Guide**: [guides/filtering-guide.md](guides/filtering-guide.md)
- **Configuration**: [configuration.md](guides/configuration.md)
- **Schema Reference**: [schema-reference.md](reference/schema-reference.md)
- **Troubleshooting**: [troubleshooting.md](reference/troubleshooting.md)
- **Installation**: [installation.md](getting-started/installation.md)
