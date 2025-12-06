# CLAUDE-TODO System Design Summary

## Executive Overview

The CLAUDE-TODO system is a production-grade task management solution specifically designed for Claude Code with comprehensive anti-hallucination mechanisms, automatic archiving, and complete audit trails. This document provides a high-level overview of the complete architecture.

## Core Architecture Components

### 1. Directory Structure

```
claude-todo-system/             # Git repository (system files only)
├── schemas/                    # JSON Schema validation definitions
├── templates/                  # Starter templates for new projects
├── scripts/                    # User-facing operational scripts
├── lib/                        # Shared library functions
├── docs/                       # Comprehensive documentation
└── tests/                      # Automated test suite

~/.claude-todo/                 # Global installation directory
├── schemas/                    # Copied from repo
├── templates/                  # Copied from repo
├── scripts/                    # Copied from repo (executable)
└── lib/                        # Copied from repo

your-project/.claude/           # Per-project instance (NOT in git)
├── todo.json                   # Active tasks
├── todo-archive.json           # Completed tasks
├── todo-config.json            # Project configuration
├── todo-log.json               # Change history
└── .backups/                   # Automatic versioned backups
```

### 2. Data File Relationships

```
┌─────────────────────────────────────────────────────────┐
│                    Configuration Layer                  │
│                                                         │
│  todo-config.json ──► Controls behavior of all scripts │
│    ├─ archive_after_days: 7                           │
│    ├─ strict_mode: true                               │
│    └─ max_backups: 10                                 │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ Configures
                     ▼
┌─────────────────────────────────────────────────────────┐
│                    Task Storage Layer                   │
│                                                         │
│  todo.json ◄──────────────► todo-archive.json         │
│  (active tasks)             (completed tasks)          │
│       │                            ▲                    │
│       │                            │                    │
│       │  Complete + Archive Policy │                    │
│       └────────────────────────────┘                    │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ All operations logged
                     ▼
┌─────────────────────────────────────────────────────────┐
│                    Audit Trail Layer                    │
│                                                         │
│  todo-log.json ──► Immutable append-only log           │
│    ├─ Every task creation                             │
│    ├─ Every status change                             │
│    ├─ Every archive operation                         │
│    └─ Every validation run                            │
└─────────────────────────────────────────────────────────┘
```

### 3. Schema Validation Architecture

```
                     INPUT (JSON)
                          │
                          ▼
              ┌───────────────────────┐
              │   JSON Syntax Check   │
              │   (Parse validation)  │
              └──────────┬────────────┘
                         │
            ┌────────────┼────────────┐
            │            │            │
         VALID       INVALID
            │            │
            ▼            └──► ERROR + ABORT
   ┌────────────────┐
   │ JSON Schema    │
   │ Validation     │
   │                │
   │ ✓ Structure    │
   │ ✓ Types        │
   │ ✓ Required     │
   │ ✓ Enums        │
   └───────┬────────┘
           │
      ┌────┴────┐
   VALID    INVALID
      │         │
      ▼         └──► ERROR + Details
   ┌──────────────────────┐
   │ Anti-Hallucination   │
   │ Checks               │
   │                      │
   │ ✓ ID Uniqueness      │
   │ ✓ Status Validity    │
   │ ✓ Timestamp Sanity   │
   │ ✓ Content Pairing    │
   │ ✓ No Duplicates      │
   └──────────┬───────────┘
              │
         ┌────┴────┐
      VALID    INVALID
         │         │
         ▼         └──► ERROR + Fix Suggestions
   ┌──────────────────────┐
   │ Cross-File           │
   │ Validation           │
   │                      │
   │ ✓ ID conflicts       │
   │ ✓ Referential        │
   │   integrity          │
   └──────────┬───────────┘
              │
              ▼
         VALIDATED ✅
         (Safe to use)
```

## Anti-Hallucination Mechanisms

The system implements multiple layers of protection against AI-generated errors:

### Layer 1: JSON Schema Enforcement
- **Structure Validation**: Ensures all required fields present
- **Type Checking**: Validates data types (string, number, boolean)
- **Enum Constraints**: Status must be: `pending | active | blocked | done`
- **Format Validation**: ISO 8601 timestamps, proper ID format

### Layer 2: Semantic Validation
- **ID Uniqueness**: No duplicate IDs within or across files
- **Timestamp Sanity**: createdAt not in future, completedAt after createdAt
- **Field Requirements**: Every task must have both `title` AND `description` (different values)
- **Duplicate Detection**: Warning on identical or highly similar task titles
- **Status Transitions**: Only valid state transitions allowed

### Layer 3: Cross-File Integrity
- **Referential Integrity**: Log entries reference valid task IDs
- **Archive Consistency**: Archived tasks match completion criteria
- **No Data Loss**: Verify task count before/after archive operations
- **Synchronized Updates**: Multi-file operations are atomic

### Layer 4: Configuration Validation
- **Policy Enforcement**: Archive policies applied consistently
- **Constraint Checking**: Config values within valid ranges
- **Dependency Resolution**: Related config options validated together

## Key Operations

### Task Creation Flow

```
User Input → Validate → Generate ID → Add to todo.json → Backup → Log
             │           │            │                  │        │
             │           │            │                  │        └─► todo-log.json
             │           │            │                  └─────────► .backups/
             │           │            └────────────────────────────► todo.json (atomic)
             │           └─────────────────────────────────────────► Timestamp + Random
             └─────────────────────────────────────────────────────► Schema + Anti-H
```

### Task Completion Flow

```
User Request → Find Task → Update Status → Validate → Write → Log → Check Policy
               │           │                │          │       │     │
               │           └─► completed    │          │       │     └─► Auto-Archive?
               │                            │          │       │
               │                            │          │       └─────────► todo-log.json
               │                            │          └─────────────────► Atomic Write
               │                            └────────────────────────────► Schema + Anti-H
               └─────────────────────────────────────────────────────────► By ID
```

### Archive Operation Flow

```
Trigger → Load Config → Filter Tasks → Validate → Update Both Files → Backup → Log
│         │             │              │          │                   │        │
│         │             │              │          │                   │        └─► Operation Log
│         │             │              │          │                   └─────────► Both Files
│         │             │              │          └─────────────────────────────► Synchronized
│         │             │              └────────────────────────────────────────► Schema + Anti-H
│         │             └───────────────────────────────────────────────────────► Completed + Age
│         └─────────────────────────────────────────────────────────────────────► Archive Policy
└───────────────────────────────────────────────────────────────────────────────► Manual/Auto/Cron
```

## Atomic Write Pattern (Critical for Data Integrity)

All write operations follow this pattern to prevent corruption:

```
1. Generate temporary filename: .todo.json.tmp
2. Write new data to temp file
3. Validate temp file (schema + anti-hallucination)
4. IF INVALID: Delete temp → Abort → Error
5. IF VALID:
   a. Backup current file → .backups/todo.json.N
   b. Atomic rename: .tmp → .json (OS-level guarantee)
   c. IF RENAME FAILS: Restore backup → Error
   d. IF SUCCESS: Rotate old backups → Success
```

**Key Properties**:
- Never overwrites original directly
- Validates before committing
- Always has backup before modification
- OS-level atomic rename (no partial writes)
- Full rollback capability on any failure

## Installation and Initialization

### Global Installation

```bash
./install.sh
```

**What it does**:
1. Creates `~/.claude-todo/` directory
2. Copies `schemas/`, `templates/`, `scripts/`, `lib/`
3. Makes all scripts executable
4. Validates installation integrity
5. Optionally adds scripts to PATH

### Per-Project Initialization

```bash
claude-todo init
```

**What it does**:
1. Creates `.claude/` directory in project root
2. Copies templates → `.claude/`
3. Renames `.template.json` → `.json`
4. Initializes empty `todo-log.json`
5. Creates `.backups/` directory
6. Adds `.claude/todo*.json` to `.gitignore`
7. Validates all created files

## Configuration Hierarchy

Configuration values are resolved in this order (later overrides earlier):

```
1. Hardcoded Defaults (in scripts)
         ↓
2. Global Config (~/.claude-todo/config.json)
         ↓
3. Project Config (.claude/todo-config.json)
         ↓
4. Environment Variables (CLAUDE_TODO_*)
         ↓
5. CLI Flags (--option=value)
         ↓
   FINAL VALUE USED
```

**Example**:
- Default: `archive_after_days = 7`
- Global: `archive_after_days = 14` (overrides default)
- Project: `archive_after_days = 3` (overrides global)
- Env: `CLAUDE_TODO_ARCHIVE_DAYS=30` (overrides project)
- CLI: `--archive-days=1` (overrides all, final value = 1)

## Backup and Recovery System

### Automatic Backup Rotation

```
.backups/
├── todo.json.1  (most recent - current backup)
├── todo.json.2  (1 operation ago)
├── todo.json.3  (2 operations ago)
├── ...
├── todo.json.9
└── todo.json.10 (oldest - about to be rotated out)

After new operation:
├── todo.json.1  (NEW - just backed up)
├── todo.json.2  (was .1)
├── todo.json.3  (was .2)
├── ...
├── todo.json.10 (was .9)
└── [old .10 deleted]
```

**Policy**:
- Backup before every write operation
- Keep last N backups (configurable, default 10)
- Automatic rotation (oldest deleted)
- Each backup validated before deletion

### Recovery Procedures

**Automatic Recovery**:
```
1. Operation fails
2. Detect corruption/error
3. Load most recent backup
4. Validate backup integrity
5. Restore backup if valid
6. Log recovery operation
```

**Manual Recovery**:
```bash
# List available backups
ls -lh .claude/.backups/

# Validate specific backup
claude-todo validate .claude/.backups/todo.json.3

# Restore from backup
claude-todo restore .claude/.backups/todo.json.3
```

## Change Log System

Every operation is logged to `todo-log.json` with:

```json
{
  "id": "log-timestamp-random",
  "timestamp": "2025-12-05T10:00:00Z",
  "operation": "create|update|complete|archive|delete",
  "task_id": "task-id-reference",
  "user": "system|username",
  "before": {
    "status": "old_value"
  },
  "after": {
    "status": "new_value"
  },
  "details": {
    "additional_context": "..."
  }
}
```

**Features**:
- Append-only (immutable)
- Complete audit trail
- Before/after state capture
- Detailed operation context
- Supports compliance requirements

## Statistics and Reporting

The `stats.sh` script analyzes all data sources to provide:

### Current State
- Tasks by status (pending, in_progress, completed)
- Active task count
- Recent activity

### Completion Metrics
- Total completed tasks
- Completion rate (%)
- Average time to completion
- Completion trends

### Activity Patterns
- Tasks created per day/week/month
- Busiest periods
- Activity timeline

### Historical Data
- All-time statistics
- Archive statistics
- Growth trends

## Script Reference

### Core Operations
| Script | Purpose | Usage |
|--------|---------|-------|
| `init.sh` | Initialize project | `claude-todo init` |
| `add-task.sh` | Create new task | `add-task.sh "Task description"` |
| `complete-task.sh` | Mark task done | `complete-task.sh <task-id>` |
| `archive.sh` | Archive completed | `archive.sh [--dry-run] [--force] [--all] [--count N]` |

### Query Operations
| Script | Purpose | Usage |
|--------|---------|-------|
| `list-tasks.sh` | Display tasks | `list-tasks.sh [--status STATUS]` |
| `stats.sh` | Generate stats | `stats.sh [--period DAYS]` |

### Maintenance Operations
| Script | Purpose | Usage |
|--------|---------|-------|
| `validate.sh` | Validate files | `validate.sh [--fix]` |
| `backup.sh` | Manual backup | `backup.sh [--destination DIR]` |
| `restore.sh` | Restore backup | `restore.sh <backup-file>` |
| `health-check.sh` | System health | `health-check.sh` |

## Library Functions

### validation.sh
- `validate_schema()` - JSON Schema validation
- `validate_anti_hallucination()` - Semantic checks
- `check_duplicate_ids()` - Cross-file uniqueness
- `validate_task_object()` - Single task validation

### logging.sh
- `log_operation()` - Append to change log
- `create_log_entry()` - Generate log entry
- `rotate_log()` - Manage log file size

### file-ops.sh
- `atomic_write()` - Safe file writing
- `backup_file()` - Create versioned backup
- `rotate_backups()` - Manage retention
- `restore_backup()` - Restore from backup

## Testing Strategy

### Test Categories

**Unit Tests**:
- Individual validation functions
- Atomic file operations
- Log entry creation
- Configuration parsing

**Integration Tests**:
- Complete workflows (create → complete → archive)
- Error recovery procedures
- Concurrent operations
- Backup/restore cycles

**Validation Tests**:
- Schema compliance
- Anti-hallucination detection
- Edge cases (empty files, malformed JSON)
- Large datasets (1000+ tasks)

### Test Execution

```bash
# Run all tests
./tests/run-all-tests.sh

# Run specific test suite
./tests/test-validation.sh
./tests/test-archive.sh

# Test with verbose output
CLAUDE_TODO_LOG_LEVEL=debug ./tests/run-all-tests.sh
```

## Performance Considerations

### Optimization Strategies

**Lazy Loading**:
- Load files only when needed
- Cache parsed JSON in memory
- Invalidate cache on write

**Efficient Processing**:
- Use `jq` for JSON (not bash loops)
- Index-based task ID lookups
- Binary search for sorted data

**Batch Operations**:
- Archive multiple tasks in one operation
- Single validation after all changes
- One log entry for batch operations

**File Size Management**:
- Archive old completed tasks
- Rotate log files at threshold
- Optional compression of old archives

### Performance Targets

| Operation | Target Time |
|-----------|-------------|
| Task creation | < 100ms |
| Task completion | < 100ms |
| Archive (100 tasks) | < 500ms |
| Validation (100 tasks) | < 200ms |
| List tasks | < 50ms |

## Security Considerations

### File Permissions
```bash
# Data files: owner read/write, group/other read
chmod 644 .claude/todo*.json

# Scripts: owner all, group/other read+execute
chmod 755 ~/.claude-todo/scripts/*.sh

# Backups: owner only
chmod 700 .claude/.backups/
chmod 600 .claude/.backups/*.json
```

### Input Validation
- Sanitize all user inputs
- Prevent command injection
- Escape special characters
- Enforce input length limits

### Data Privacy
- All data stored locally
- No external network calls
- No telemetry or tracking
- User controls all data

## Extension Points

### Custom Validators
Place in `.claude/validators/`:
- Called after schema validation
- Add project-specific rules
- Integrate with team standards

### Event Hooks
Place in `.claude/hooks/`:
- `on-task-create.sh`
- `on-task-complete.sh`
- `on-archive.sh`
- Trigger external actions

### Custom Formatters
Place in `~/.claude-todo/formatters/`:
- `html-report.sh`
- `csv-export.sh`
- `slack-message.sh`
- Used by list-tasks and stats

### Integration APIs
Place in `~/.claude-todo/integrations/`:
- `jira-sync.sh`
- `github-issues.sh`
- `trello-board.sh`
- Export to external systems

## Version Management

### Versioning Scheme
```
schemas/todo.schema.json → version: "1.0.0"

Major.Minor.Patch
  │     │     │
  │     │     └─ Bug fixes (backward compatible)
  │     └─────── New features (backward compatible)
  └───────────── Breaking changes
```

### Migration Path
```
~/.claude-todo/migrations/
├── migrate-1.0-to-1.1.sh
├── migrate-1.1-to-2.0.sh
└── rollback-2.0-to-1.1.sh

Automatically run during:
./install.sh --upgrade
```

## Quick Start Guide

### Installation
```bash
# 1. Clone repository
git clone https://github.com/kryptobaseddev/claude-todo.git
cd claude-todo

# 2. Install globally
./install.sh

# 3. Initialize project
cd /path/to/your/project
claude-todo init
```

### Basic Usage
```bash
# Add task
claude-todo add "Implement authentication"

# List tasks
claude-todo list

# Complete task
claude-todo complete task-1733395200-abc123

# Show statistics
claude-todo stats
```

### Recommended Aliases
```bash
# Add to ~/.bashrc or ~/.zshrc
alias ct-add='claude-todo add'
alias ct-list='claude-todo list'
alias ct-complete='claude-todo complete'
alias ct-stats='claude-todo stats'
```

## Documentation References

| Document | Purpose |
|----------|---------|
| `README.md` | User-facing overview and quick start |
| `docs/ARCHITECTURE.md` | Complete system architecture (CORE) |
| `docs/SYSTEM-DESIGN-SUMMARY.md` | Executive summary (this file) |
| `docs/DATA-FLOW-DIAGRAMS.md` | Visual data flows and relationships |
| `docs/installation.md` | Detailed installation guide |
| `docs/usage.md` | Comprehensive usage examples |
| `docs/configuration.md` | Configuration reference |
| `docs/schema-reference.md` | Schema documentation |
| `docs/troubleshooting.md` | Common issues and solutions |

## Success Criteria

This system successfully provides:

✅ **Robust**: Schema validation + anti-hallucination checks prevent corruption
✅ **Maintainable**: Clear separation of concerns, modular design
✅ **Safe**: Atomic operations, automatic backups, validation gates
✅ **Extensible**: Hooks, validators, formatters, integrations
✅ **Performant**: Optimized for 1000+ tasks
✅ **User-Friendly**: Zero-config defaults, clear error messages
✅ **Auditable**: Comprehensive logging, complete change history
✅ **Portable**: Single installation, per-project initialization

## Next Steps

1. **Implementation**: Build core scripts and libraries
2. **Schema Creation**: Define JSON schemas with anti-hallucination rules
3. **Testing**: Develop comprehensive test suite
4. **Documentation**: Write detailed user guides
5. **Deployment**: Package for distribution and installation

---

For detailed information, see:
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - Complete system design
- **[DATA-FLOW-DIAGRAMS.md](DATA-FLOW-DIAGRAMS.md)** - Visual workflows and interactions
