# CLAUDE-TODO

> **A production-grade task management system for Claude Code with automatic archiving, comprehensive validation, and anti-hallucination protection.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.6.1-blue.svg)](CHANGELOG.md)
[![Bash](https://img.shields.io/badge/bash-4.0%2B-green.svg)](https://www.gnu.org/software/bash/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)](tests/)

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Anti-Hallucination Protection](#anti-hallucination-protection)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

CLAUDE-TODO is a robust, schema-validated task management system specifically designed for Claude Code. It provides comprehensive anti-hallucination mechanisms, automatic archiving, complete audit trails, and atomic file operations to ensure data integrity.

### Key Features

- **Anti-Hallucination Protection**: Multi-layer validation prevents AI-generated errors
- **Automatic Archiving**: Configurable policies for completed task archiving
- **Complete Audit Trail**: Immutable change log tracks every operation
- **Atomic Operations**: Safe file handling with automatic backups and rollback
- **Schema Validation**: JSON Schema enforcement ensures data integrity
- **Zero-Config Defaults**: Works out of the box with sensible defaults
- **Extensible Design**: Custom validators, hooks, formatters, and integrations

## Quick Start

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/kryptobaseddev/claude-todo.git
cd claude-todo

# 2. Install globally (works immediately - no shell restart needed!)
./install.sh

# 3. Verify installation
claude-todo version

# 4. Initialize in your project
cd /path/to/your/project
claude-todo init
```

> **Claude Code Compatible**: The installer creates symlinks in `~/.local/bin/`, which is already in PATH for Claude Code and most modern shells. No manual PATH configuration required.

### Basic Usage

```bash
# Add a task
claude-todo add "Implement authentication"

# List all tasks
claude-todo list

# Update a task
claude-todo update T001 --priority high --labels "urgent,bug"

# Complete a task
claude-todo complete T001

# Export to TodoWrite format (for Claude Code integration)
claude-todo export --format todowrite

# Show statistics
claude-todo stats

# Archive completed tasks
claude-todo archive

# Get help
claude-todo help
```

### Shortcut Command

The installer also creates a `ct` shortcut:

```bash
ct list        # Same as: claude-todo list
ct add "Task"  # Same as: claude-todo add "Task"
ct version     # Same as: claude-todo version
```

### Command Aliases

Built-in aliases for faster workflows:

```bash
claude-todo ls              # list
claude-todo done T001       # complete T001
claude-todo new "Task"      # add "Task"
claude-todo edit T001       # update T001
claude-todo rm              # archive
claude-todo check           # validate
```

### Debug Mode

Validate your CLI installation:

```bash
claude-todo --validate      # Check scripts, aliases, checksums
claude-todo --list-commands # Show all available commands
CLAUDE_TODO_DEBUG=1 claude-todo list  # Verbose output
```

## Architecture

### System Structure

```
Repository Structure
├── schemas/           JSON Schema validation definitions
├── scripts/           User-facing operational scripts
├── lib/               Shared library functions
├── templates/         Starter templates
├── docs/              Documentation (see docs/INDEX.md)
├── tests/             Test suite and fixtures
└── archive/           Development artifacts and history

Global Installation (~/.claude-todo/)
├── schemas/           JSON Schema validation definitions
├── scripts/           User-facing operational scripts
├── lib/               Shared library functions
├── templates/         Starter templates
├── plugins/           Custom command plugins
└── checksums.sha256   Script integrity verification

Per-Project Instance (.claude/)
├── todo.json          Active tasks
├── todo-archive.json  Completed tasks
├── todo-config.json   Project configuration
├── todo-log.json      Complete audit trail
└── .backups/          Automatic versioned backups
```

### Core Components

1. **Task Storage**: Active tasks in `todo.json`, completed in `todo-archive.json`
2. **Configuration**: Flexible per-project and global settings
3. **Audit Trail**: Complete change history in `todo-log.json`
4. **Validation**: Schema + semantic anti-hallucination checks
5. **Backups**: Automatic versioned backups before every modification

## Anti-Hallucination Protection

CLAUDE-TODO implements multiple layers of protection against AI-generated errors:

### Layer 1: JSON Schema Enforcement
- Structure validation (required fields, types)
- Enum constraints (status must be: pending, active, blocked, done)
- Format validation (ISO 8601 timestamps, proper IDs)

### Layer 2: Semantic Validation
- **ID Uniqueness**: No duplicate IDs within or across files
- **Timestamp Sanity**: `createdAt` not in future, `completedAt` after `createdAt`
- **Field Requirements**: Every task must have both `title` AND `description`
- **Duplicate Detection**: Warning on identical task descriptions
- **Status Transitions**: Only valid state transitions allowed

### Layer 3: Cross-File Integrity
- Referential integrity (log entries reference valid task IDs)
- Archive consistency (archived tasks match completion criteria)
- No data loss verification (task count before/after operations)
- Synchronized multi-file updates

### Layer 4: Configuration Validation
- Policy enforcement (archive policies applied consistently)
- Constraint checking (config values within valid ranges)
- Dependency resolution (related options validated together)

## Data Integrity

### Atomic Write Pattern

All file modifications follow this pattern:

```
1. Generate temp file (.todo.json.tmp)
2. Write data to temp file
3. Validate temp file (schema + anti-hallucination)
4. Backup original file
5. Atomic rename (OS-level guarantee, no partial writes)
6. Rollback on any failure
```

### Backup System

- Automatic backup before every write operation
- Versioned backups (.backups/todo.json.1 through .10)
- Automatic rotation (oldest deleted when limit reached)
- Manual backup and restore capabilities

### Change Log

Every operation logged with:
- Timestamp
- Operation type (create, update, complete, archive)
- Task ID reference
- Before/after state
- User and context

## Configuration

### Configuration Hierarchy

Values resolved in this order (later overrides earlier):

```
Defaults → Global → Project → Environment → CLI Flags
           (~/.c-t)  (.claude)  (CLAUDE_TODO_*)  (--options)
```

### Key Configuration Options

```json
{
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
    "maxActiveTasks": 1
  }
}
```

## Available Scripts

### Core Operations
- `init.sh` - Initialize project with todo system
- `add-task.sh` - Create new task with validation
- `update-task.sh` - Update existing task fields
- `complete-task.sh` - Mark task as completed
- `archive.sh` - Archive completed tasks

### Query Operations
- `list-tasks.sh` - Display tasks with filtering
- `stats.sh` - Generate statistics and reports
- `export.sh` - Export to TodoWrite/JSON/Markdown format

### Maintenance Operations
- `validate.sh` - Validate all JSON files
- `backup.sh` - Create manual backup
- `restore.sh` - Restore from backup

## Extension Points

### Custom Validators
Place custom validation scripts in `.claude/validators/`:

```bash
# .claude/validators/team-standards.sh
validate_team_standards() {
    # Custom validation logic
    return 0
}
```

### Event Hooks
Place event hooks in `.claude/hooks/`:

```bash
# .claude/hooks/on-task-complete.sh
#!/usr/bin/env bash
task_id="$1"
# Send notification, update external tracker, etc.
```

### Custom Formatters
Add output formatters in `~/.claude-todo/formatters/`:

```bash
# ~/.claude-todo/formatters/csv-export.sh
format_csv() {
    local todo_file="$1"
    jq -r '.todos[] | [.id, .status, .title] | @csv' "$todo_file"
}
```

### Integrations
Create integration scripts in `~/.claude-todo/integrations/`:

```bash
# ~/.claude-todo/integrations/jira-sync.sh
# Sync tasks with JIRA
```

## Documentation

Complete documentation is available in the [`docs/`](docs/) directory. Start with **[docs/INDEX.md](docs/INDEX.md)** for navigation.

### Quick Links

| Category | Documents |
|----------|-----------|
| **Getting Started** | [Installation](docs/reference/installation.md) · [Usage](docs/usage.md) · [Quick Reference](docs/QUICK-REFERENCE.md) |
| **Architecture** | [System Architecture](docs/architecture/ARCHITECTURE.md) · [Data Flow Diagrams](docs/architecture/DATA-FLOWS.md) |
| **Reference** | [Configuration](docs/reference/configuration.md) · [Schema Reference](docs/architecture/SCHEMAS.md) · [Workflow Guide](docs/integration/WORKFLOWS.md) |
| **Guides** | [Migration Guide](docs/reference/migration-guide.md) · [Troubleshooting](docs/reference/troubleshooting.md) |
| **For Claude** | [CLAUDE.md](CLAUDE.md) - Protocol instructions for Claude Code integration |

## Testing

```bash
# Run all tests
./tests/run-all-tests.sh

# Run specific test suite
./tests/test-validation.sh
./tests/test-archive.sh

# Test with verbose output
CLAUDE_TODO_LOG_LEVEL=debug ./tests/run-all-tests.sh
```

## Performance

Target performance metrics:

| Operation | Target Time |
|-----------|-------------|
| Task creation | < 100ms |
| Task completion | < 100ms |
| Archive (100 tasks) | < 500ms |
| Validation (100 tasks) | < 200ms |
| List tasks | < 50ms |

## Security

- **Local Storage**: All data stored locally, no external calls
- **File Permissions**: Proper permissions enforced (644 for data, 755 for scripts)
- **Input Validation**: All user inputs sanitized
- **No Telemetry**: Complete user control over data

## Requirements

### Required
- Bash 4.0+
- jq (JSON processor)
- One JSON Schema validator (ajv, jsonschema, or jq-based fallback)

### Optional
- git (for version control integration)
- cron (for automatic archival scheduling)

## Troubleshooting

### Common Issues

**"Permission denied" error**
```bash
chmod 755 ~/.claude-todo/scripts/*.sh
```

**"Invalid JSON" error**
```bash
# Try automatic fix
claude-todo validate --fix

# Or restore from backup
claude-todo restore .claude/.backups/todo.json.1
```

**"Duplicate ID" error**
```bash
# Restore from backup
claude-todo restore .claude/.backups/todo.json.1
```

### Health Check

```bash
claude-todo validate
```

Checks:
- File integrity
- Schema compliance
- Backup freshness
- Log file size
- Configuration validity

## Upgrading

```bash
cd claude-todo
git pull
./install.sh --upgrade
```

Migrations run automatically when needed.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

### Quick Start for Contributors

1. **Fork and clone** the repository
2. **Create a feature branch**: `git checkout -b feature/your-feature`
3. **Make your changes** following the existing code style
4. **Add tests** for new features in `tests/`
5. **Update documentation** if needed
6. **Run validation**: `./tests/run-all-tests.sh`
7. **Submit a pull request**

### Code Standards

- Bash 4.0+ compatible
- Follow existing patterns in `lib/` and `scripts/`
- Use jq for JSON manipulation
- Add unit tests for new functionality
- Update relevant documentation

## Design Philosophy

CLAUDE-TODO is built on three core pillars:

### 1. Anti-Hallucination First
Multi-layer validation prevents AI-generated errors from corrupting task data. Schema enforcement, semantic validation, and cross-file integrity checks ensure data remains accurate and consistent across all operations.

### 2. Atomic Operations
Every file modification uses atomic write patterns: write to temp file, validate, backup original, atomic rename. If any step fails, the system rolls back automatically. No partial writes, no data corruption.

### 3. Session Continuity
Complete audit trails, immutable change logs, and automatic backups enable seamless work across sessions. Pick up exactly where you left off, with full context and history preserved.

### Design Principles

1. **Single Source of Truth**: todo.json is authoritative
2. **Immutable History**: Append-only change log
3. **Fail-Safe Operations**: Atomic writes with rollback
4. **Schema-First**: Validation prevents corruption
5. **Idempotent Scripts**: Safe to run multiple times
6. **Zero-Config Defaults**: Sensible defaults, optional customization

## Success Criteria

CLAUDE-TODO provides:

✅ **Robust**: Schema validation + anti-hallucination checks
✅ **Maintainable**: Clear separation of concerns, modular design
✅ **Safe**: Atomic operations, automatic backups, validation gates
✅ **Extensible**: Hooks, validators, formatters, integrations
✅ **Performant**: Optimized for 1000+ tasks
✅ **User-Friendly**: Zero-config defaults, clear error messages
✅ **Auditable**: Comprehensive logging, complete change history
✅ **Portable**: Single installation, per-project initialization

## License

MIT License - See [LICENSE](LICENSE) file for details.

---

## Getting Help

- **Documentation**: [docs/INDEX.md](docs/INDEX.md) - Complete documentation navigation
- **Quick Reference**: [docs/QUICK-REFERENCE.md](docs/QUICK-REFERENCE.md) - Cheat sheet for daily use
- **Troubleshooting**: [docs/reference/troubleshooting.md](docs/reference/troubleshooting.md) - Common issues and solutions
- **Issues**: Open an issue on GitHub for bugs or feature requests

---

<p align="center">
  <strong>Ready to get started?</strong> Run <code>./install.sh</code> to begin!
</p>

<p align="center">
  <a href="docs/INDEX.md">Documentation</a> ·
  <a href="docs/reference/installation.md">Installation</a> ·
  <a href="docs/usage.md">Usage Guide</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>
