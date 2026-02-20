# CLAUDE-TODO

A robust, anti-hallucination task management system optimized for LLM-assisted development workflows.

## Features

- **Integrity Verification**: SHA-256 checksums prevent data corruption and hallucinations
- **Session Tracking**: Log all operations with session IDs for audit trail
- **Auto-Archive**: Completed tasks automatically archived based on configurable rules
- **Dependency Management**: Task dependencies with circular dependency detection
- **Validation Engine**: Business rules enforcement with auto-fix capabilities
- **Change History**: Complete audit log of all operations

## Quick Start

### Option 1: Global Installation (Recommended)

```bash
# Install globally
curl -sSL https://raw.githubusercontent.com/.../install.sh | bash

# Initialize in your project
cd your-project
claude-todo init
```

### Option 2: Direct Use

```bash
# Clone and run init script directly
git clone https://github.com/.../claude-todo.git
cd your-project
bash /path/to/claude-todo/scripts/init-todo.sh
```

## Files Created

| File | Purpose |
|------|---------|
| `.claude/todo.json` | Active tasks with checksum verification |
| `.claude/todo-archive.json` | Completed tasks (immutable) |
| `.claude/todo-config.json` | System configuration |
| `.claude/todo-log.json` | Change history audit trail |

## Directory Structure

```
~/.claude-todo/                 # Global installation
├── schemas/                    # JSON schemas
│   ├── todo.schema.json
│   ├── archive.schema.json
│   ├── config.schema.json
│   └── log.schema.json
├── templates/                  # Project templates
├── scripts/                    # Operational scripts
│   ├── claude-todo            # Main CLI wrapper
│   ├── init-todo.sh
│   ├── archive-todo.sh
│   ├── validate-todo.sh
│   └── log-todo.sh
└── docs/                       # Documentation

your-project/                   # Per-project files
├── .claude/                    # Hidden todo directory
│   ├── todo.json              # Active tasks
│   ├── todo-archive.json      # Completed tasks (immutable)
│   ├── todo-config.json       # Project settings
│   └── todo-log.json          # Change history
├── CLAUDE.md                   # Updated with task integration
└── ...
```

## Commands

```bash
# Initialize in project
init-todo.sh [project-name] [--force] [--no-claude-md]

# Validate todo.json
validate-todo.sh [--strict] [--fix] [--json]

# Archive completed tasks
archive-todo.sh [--dry-run] [--force] [--count N]

# Add log entry
log-todo.sh --action ACTION [--task-id ID] [--before JSON] [--after JSON]
```

## Task Schema

```json
{
  "id": "T001",
  "title": "Implement feature",
  "status": "pending|active|blocked|done",
  "priority": "critical|high|medium|low",
  "phase": "setup|core|polish",
  "description": "Details...",
  "depends": ["T000"],
  "acceptance": ["Criterion 1"],
  "files": ["src/file.ts"],
  "notes": ["Implementation note"],
  "labels": ["feature"],
  "createdAt": "2025-12-05T10:00:00Z",
  "completedAt": "2025-12-05T12:00:00Z",
  "blockedBy": "Reason if blocked"
}
```

## Anti-Hallucination Protocol

### For LLM Agents (CRITICAL)

1. **ALWAYS** read `todo.json` before any operation
2. **VERIFY** checksum matches before writing
3. **NEVER** have more than ONE active task
4. **NEVER** modify archived tasks
5. **ALWAYS** log changes to `todo-log.json`
6. **ALWAYS** update checksum after changes

### Checksum Verification

```bash
# Calculate checksum of tasks array
jq -c '.tasks' todo.json | sha256sum | cut -c1-16

# Compare with stored
jq -r '._meta.checksum' todo.json
```

## Configuration

Key settings in `todo-config.json`:

```json
{
  "archive": {
    "enabled": true,
    "daysUntilArchive": 7,
    "maxCompletedTasks": 15,
    "preserveRecentCount": 3
  },
  "validation": {
    "checksumEnabled": true,
    "maxActiveTasks": 1,
    "detectCircularDeps": true
  },
  "session": {
    "requireSessionNote": true,
    "warnOnNoFocus": true
  }
}
```

## Status Lifecycle

```
pending → active → done → (archived)
           ↓
        blocked → pending
```

**Rules:**
- Only ONE task can be `active`
- `blocked` requires `blockedBy` reason
- `done` requires `completedAt` timestamp
- `done` tasks are immutable

## Session Workflow

### Start
1. Read config and todo.json
2. Verify checksum
3. Generate session ID
4. Log `session_start`
5. Resume or select task

### Work
- Update task status
- Log all changes
- Maintain ONE active task

### End
1. Update `focus.sessionNote`
2. Recalculate checksum
3. Run archive check
4. Log `session_end`

## License

MIT
