# CLEO System Architecture

## Executive Summary

The CLEO system is a production-grade task management solution specifically designed for Claude Code with comprehensive anti-hallucination mechanisms, automatic archiving, and complete audit trails. This document provides the complete system architecture and design specifications.

**Key Features**:
- **Robust**: Schema validation + multi-layer anti-hallucination checks
- **Safe**: Atomic operations, automatic backups, validation gates
- **Auditable**: Comprehensive logging, complete change history
- **Maintainable**: Clear separation of concerns, modular design
- **Extensible**: Hooks, validators, formatters, integrations
- **Performant**: Optimized for 1000+ tasks
- **User-Friendly**: Zero-config defaults, clear error messages
- **Portable**: Single installation, per-project initialization
- **Phase-Aware**: Project-level phase tracking with task inheritance (v2.2.0+)

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [Directory Structure](#directory-structure)
3. [Data File Relationships](#data-file-relationships)
4. [Phase Tracking System](#phase-tracking-system)
5. [Schema Validation Architecture](#schema-validation-architecture)
6. [Anti-Hallucination Mechanisms](#anti-hallucination-mechanisms)
7. [Operation Workflows](#operation-workflows)
8. [Atomic Write Pattern](#atomic-write-pattern)
9. [Configuration System](#configuration-system)
10. [Backup and Recovery System](#backup-and-recovery-system)
11. [Change Log System](#change-log-system)
12. [Installation and Initialization](#installation-and-initialization)
13. [Script Reference](#script-reference)
14. [Library Functions](#library-functions)
15. [Testing Strategy](#testing-strategy)
16. [Performance Considerations](#performance-considerations)
17. [Security Considerations](#security-considerations)
18. [Extension Points](#extension-points)
19. [Architectural Decisions](#architectural-decisions)
20. [Version Management](#version-management)

---

## Design Principles

### Core Philosophy

CLEO is built on three foundational pillars designed specifically for AI-assisted development:

**1. Anti-Hallucination First**
Multi-layer validation prevents AI-generated errors from corrupting task data. Every operation undergoes schema enforcement, semantic validation, and cross-file integrity checks.

*Why*: AI agents can generate syntactically valid but semantically incorrect data. Protection against hallucination is the foundation, not an afterthought.

**2. Atomic Operations**
Every file modification uses atomic write patterns. No partial writes, no data corruption, full rollback on any failure.

*Why*: Task data is the source of truth for work sessions. Corruption destroys continuity. Atomic operations ensure all-or-nothing modifications.

**3. Session Continuity**
Complete audit trails, immutable change logs, and automatic backups enable seamless work across interrupted sessions.

*Why*: Development work is rarely linear. Session continuity means you can pick up exactly where you left off with full context preserved.

### Principle Details

| Principle | Description | Implementation |
|-----------|-------------|----------------|
| **Single Source of Truth** | todo.json is authoritative for active tasks | Active tasks in todo.json, completed in archive, audit in log |
| **Immutable History** | Append-only logging for auditability | Log entries never modified or deleted |
| **Fail-Safe Operations** | Atomic file operations with validation | temp file → validate → backup → rename |
| **Schema-First** | JSON Schema validation prevents corruption | Schema defines structure before code validates behavior |
| **Idempotent Scripts** | Safe to run multiple times | Re-running produces same result |
| **Zero-Config Defaults** | Sensible defaults, optional customization | Archive after 7 days, 10 backups, strict validation |

### System Invariants

These properties must **ALWAYS** be true:

1. **ID Uniqueness**: Every task ID is globally unique (across todo.json + todo-archive.json)
2. **Status Enum**: Task status is always one of: `pending | active | blocked | done`
3. **Atomic Writes**: No partial writes to any JSON file
4. **Backup Exists**: Before any modification, previous version is backed up
5. **Log Append-Only**: Change log is never modified, only appended
6. **Archive Immutability**: Archive file is only appended, never modified
7. **Schema Validation**: Every file passes schema validation before being used
8. **Timestamp Monotonicity**: Task timestamps are chronological (created ≤ completed)
9. **Phase Consistency**: `project.currentPhase` must reference an existing phase with `status=active`
10. **Phase Status Enum**: Phase status is always one of: `pending | active | completed`

**Enforcement**: Validation runs on every read and write. Scripts exit with error if invariants are violated.

---

## Directory Structure

### Repository Structure

```
cleo/                        # Git repository (system files only)
├── README.md                       # User documentation
├── LICENSE                         # MIT License
├── install.sh                      # Global installation script
├── .gitignore                      # Ignore user data files
│
├── schemas/                        # JSON Schema definitions
│   ├── todo.schema.json           # Main task list schema
│   ├── archive.schema.json        # Archive schema
│   ├── config.schema.json         # Configuration schema
│   └── log.schema.json            # Change log schema
│
├── templates/                      # Starter templates
│   ├── todo.template.json         # Task list with project phases (v2.2.0+)
│   ├── todo-config.template.json  # Default configuration
│   ├── log.template.json          # Empty audit log
│   └── archive.template.json      # Empty archive
│
├── scripts/                        # Operational scripts
│   ├── init.sh                    # Initialize project with todo system
│   ├── validate.sh                # Validate all JSON files
│   ├── archive.sh                 # Archive completed tasks
│   ├── add.sh                # Add new task with validation
│   ├── complete.sh           # Mark task complete and log
│   ├── list.sh              # Display current tasks
│   ├── stats.sh                   # Statistics and reporting
│   ├── backup.sh                  # Backup all todo files
│   ├── restore.sh                 # Restore from backup
│   ├── phase.sh                   # Current phase management (v2.2.0+)
│   └── phases.sh                  # Phase listing and queries (v2.2.0+)
│
├── lib/                            # Shared library functions
│   ├── validation.sh              # Schema validation functions
│   ├── logging.sh                 # Change log functions
│   ├── file-ops.sh                # Atomic file operations
│   └── phase-tracking.sh          # Phase lifecycle management (v2.2.0+)
│
├── docs/                           # Documentation
│   ├── architecture/              # System design docs
│   │   ├── ARCHITECTURE.md        # This file
│   │   ├── DATA-FLOWS.md          # Visual diagrams
│   │   └── SCHEMAS.md             # Schema documentation
│   ├── integration/               # Claude Code integration
│   │   ├── CLAUDE-CODE.md         # LLM-optimized guide
│   │   └── WORKFLOWS.md           # Session workflows
│   ├── getting-started/           # Onboarding
│   │   └── quick-start.md         # First steps
│   ├── guides/                    # How-to guides
│   │   └── filtering-guide.md     # Query guide
│   ├── reference/                 # Technical reference
│   │   ├── command-reference.md   # CLI commands
│   │   ├── configuration.md       # Config options
│   │   ├── installation.md        # Setup guide
│   │   └── troubleshooting.md     # Problem solving
│   └── [8 root-level .md files]   # INDEX, README, usage, etc.
│
└── tests/                          # Test suite
    ├── test-validation.sh         # Schema validation tests
    ├── test-archive.sh            # Archive operation tests
    ├── test-add.sh           # Task creation tests
    └── fixtures/                  # Test data
        ├── valid-todo.json
        └── invalid-todo.json
```

### Global Installation

```
~/.cleo/                     # Global installation directory
├── schemas/                        # Copied from repo
├── templates/                      # Copied from repo
├── scripts/                        # Copied from repo (executable)
└── lib/                            # Copied from repo
```

### Per-Project Files

```
your-project/.cleo/               # Per-project instance (NOT in git)
├── todo.json                       # Active tasks
├── todo-archive.json               # Completed tasks
├── config.json                # Project configuration
├── todo-log.json                   # Change history
└── .backups/                       # Tier 1: Operational backups (atomic writes)
    ├── todo.json.1                 # Most recent
    ├── todo.json.2
    └── ...
```

---

## Data File Relationships

```
┌─────────────────────────────────────────────────────────┐
│                  Configuration Layer                    │
│                                                         │
│  config.json ──► Controls behavior of all scripts │
│    ├─ daysUntilArchive: 7                             │
│    ├─ strictMode: true                                │
│    └─ maxBackups: 10                                  │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ Configures
                     ▼
┌─────────────────────────────────────────────────────────┐
│                   Task Storage Layer                    │
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
│                   Audit Trail Layer                     │
│                                                         │
│  todo-log.json ──► Immutable append-only log           │
│    ├─ Every task creation                             │
│    ├─ Every status change                             │
│    ├─ Every archive operation                         │
│    └─ Every validation run                            │
└─────────────────────────────────────────────────────────┘
```

### File Interaction Matrix

| File | Read By | Written By | Validates Against |
|------|---------|------------|-------------------|
| `todo.json` | list, stats, complete, archive | add-task, complete-task, archive | todo.schema.json |
| `todo-archive.json` | stats, list (--all) | archive | archive.schema.json |
| `config.json` | ALL scripts | init, user edit | config.schema.json |
| `todo-log.json` | stats, troubleshooting | add-task, complete-task, archive | log.schema.json |

---

## Phase Tracking System

> **Version**: Introduced in v2.2.0 (schema version 2.2.0)

The phase tracking system provides project-level workflow organization with automatic task inheritance.

### Phase Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     PROJECT OBJECT                              │
│                                                                 │
│  project: {                                                    │
│    name: "my-project",                                         │
│    currentPhase: "core",  ◄─── Active phase slug               │
│    phases: {                                                   │
│      "setup":  { order: 1, status: "completed", ... }         │
│      "core":   { order: 2, status: "active", ... }    ◄─ Current│
│      "polish": { order: 3, status: "pending", ... }           │
│    }                                                           │
│  }                                                             │
├─────────────────────────────────────────────────────────────────┤
│                      TASK INHERITANCE                           │
│                                                                 │
│  New tasks inherit currentPhase automatically:                 │
│  cleo add "Task" ──► phase: "core" (from currentPhase)  │
│  cleo add "Task" --phase setup ──► explicit override    │
└─────────────────────────────────────────────────────────────────┘
```

### Phase Lifecycle

```
                    Phase States
                    ─────────────

    ┌─────────┐     ┌─────────┐     ┌───────────┐
    │ pending │ ──► │ active  │ ──► │ completed │
    └─────────┘     └─────────┘     └───────────┘
         │               │                │
         │               │                │
    Not started    Being worked on    All tasks done
```

**State Transitions**:
- `pending → active`: `cleo phase set <slug>` or `phase start <slug>`
- `active → completed`: `cleo phase complete <slug>`
- Only ONE phase can be active at a time

### Phase Schema Structure

```json
{
  "project": {
    "name": "project-name",
    "currentPhase": "core",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup & Foundation",
        "description": "Initial project setup",
        "status": "completed",
        "startedAt": "2025-01-01T00:00:00Z",
        "completedAt": "2025-01-15T00:00:00Z"
      },
      "core": {
        "order": 2,
        "name": "Core Development",
        "description": "Build core functionality",
        "status": "active",
        "startedAt": "2025-01-15T00:00:00Z",
        "completedAt": null
      }
    }
  }
}
```

### Phase Commands

| Command | Purpose |
|---------|---------|
| `cleo phases` | List all phases with progress |
| `cleo phases show <slug>` | Show tasks in phase |
| `cleo phases stats` | Detailed phase statistics |
| `cleo phase set <slug>` | Set current project phase |
| `cleo phase show` | Show current phase details |

### Phase Integration Points

| Feature | Integration |
|---------|-------------|
| **Task creation** | New tasks inherit `project.currentPhase` |
| **Focus tracking** | `focus.currentPhase` syncs with project phase |
| **TodoWrite sync** | `--inject --focused-only` filters by current phase |
| **Dashboard** | `cleo dash` shows current phase status |
| **Next task** | `cleo next` considers phase priority |

### Library: lib/phase-tracking.sh

Key functions:
- `get_current_phase()` - Read current phase slug
- `set_current_phase()` - Update project phase
- `get_phase_status()` - Check phase status
- `start_phase()` / `complete_phase()` - Lifecycle management
- `count_phases_by_status()` - Phase statistics

---

## Schema Validation Architecture

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

---

## Anti-Hallucination Mechanisms

The system implements multiple layers of protection against AI-generated errors:

### Layer 1: JSON Schema Enforcement
- **Structure Validation**: Ensures all required fields present
- **Type Checking**: Validates data types (string, number, boolean)
- **Enum Constraints**: Status must be: `pending | active | blocked | done`
- **Format Validation**: ISO 8601 timestamps, proper ID format

### Layer 2: Semantic Validation

```bash
# ID Uniqueness Check
- Extract all task IDs
- Check for duplicates within file
- Check for duplicates across todo + archive

# Status Enum Validation
- Must be: pending | active | blocked | done
- No typos, no custom statuses

# Timestamp Sanity Check
- createdAt must be valid ISO 8601
- createdAt must not be in future
- completedAt must be after createdAt

# Title/Description Check
- Every task must have "title" AND "description"
- Neither can be empty string
- Must be different strings (anti-hallucination)

# Duplicate Content Detection
- Check for identical task descriptions
- Warn on similar content (Levenshtein distance)
```

### Layer 3: Cross-File Integrity
- **Referential Integrity**: Log entries reference valid task IDs
- **Archive Consistency**: Archived tasks match completion criteria
- **No Data Loss**: Verify task count before/after archive operations
- **Synchronized Updates**: Multi-file operations are atomic

### Layer 4: Configuration Validation
- **Policy Enforcement**: Archive policies applied consistently
- **Constraint Checking**: Config values within valid ranges
- **Dependency Resolution**: Related config options validated together

### Validation Modes

**Strict Mode** (default):
- All checks enabled
- Errors block operations
- No automatic fixes

**Lenient Mode**:
- Warnings instead of errors for non-critical issues
- Allow automatic fixes
- Useful for migrations

---

## Operation Workflows

### Task Creation Flow

```
User Input → Validate → Generate ID → Add to todo.json → Backup → Log
             │           │            │                  │        │
             │           │            │                  │        └─► todo-log.json
             │           │            │                  └─────────► .cleo/.backups/
             │           │            └────────────────────────────► todo.json (atomic)
             │           └─────────────────────────────────────────► Timestamp + Random
             └─────────────────────────────────────────────────────► Schema + Anti-H
```

**Workflow Steps**:
1. Load config.json for settings
2. Parse command arguments
3. Validate inputs (anti-hallucination)
4. Load current todo.json
5. Generate unique task ID
6. Create task object
7. Validate full todo.json with new task
8. Atomic write to todo.json (with backup)
9. Log operation to todo-log.json
10. Display success with task ID

### Task Completion Flow

```
User Request → Find Task → Update Status → Validate → Write → Log → Check Policy
               │           │                │          │       │     │
               │           └─► done         │          │       │     └─► Auto-Archive?
               │                            │          │       │
               │                            │          │       └─────────► todo-log.json
               │                            │          └─────────────────► Atomic Write
               │                            └────────────────────────────► Schema + Anti-H
               └─────────────────────────────────────────────────────────► By ID
```

**Workflow Steps**:
1. Load config.json
2. Load todo.json
3. Find task by ID
4. Validate task exists
5. Update status to "done"
6. Add completion timestamp
7. Validate updated todo.json
8. Atomic write (with backup)
9. Log operation
10. Check auto-archive policy
11. Trigger archive if policy met
12. Display success

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

**Workflow Steps**:
1. Load config.json
2. Read archive policy (daysUntilArchive)
3. Load todo.json
4. Filter completed tasks older than threshold
5. Validate filtered tasks
6. Load todo-archive.json
7. Append filtered tasks to archive
8. Remove archived tasks from todo.json
9. Validate both files
10. Atomic write both files (synchronized)
11. Log operation with archived IDs
12. Display statistics

---

## Atomic Write Pattern

**Critical for Data Integrity**: All write operations follow this pattern to prevent corruption.

```
1. Generate temporary filename: .todo.json.tmp
2. Write new data to temp file
3. Validate temp file (schema + anti-hallucination)
4. IF INVALID: Delete temp → Abort → Error
5. IF VALID:
   a. Backup current file → .cleo/.backups/todo.json.N
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

---

## Configuration System

### Default Configuration (config.json)

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

### Configuration Hierarchy

Configuration values are resolved in this order (later overrides earlier):

```
1. Hardcoded Defaults (in scripts)
         ↓
2. Global Config (~/.cleo/config.json)
         ↓
3. Project Config (.cleo/config.json)
         ↓
4. Environment Variables (CLEO_*)
         ↓
5. CLI Flags (--option=value)
         ↓
   FINAL VALUE USED
```

**Example**:
- Default: `daysUntilArchive = 7`
- Global: `daysUntilArchive = 14` (overrides default)
- Project: `daysUntilArchive = 3` (overrides global)
- Env: `CLEO_ARCHIVE_DAYS=30` (overrides project)
- CLI: `--archive-days=1` (overrides all, final value = 1)

---

## Backup and Recovery System

### Automatic Backup Rotation

```
.cleo/.backups/                    # Tier 1: Operational backups
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
ls -lh .cleo/.backups/

# Validate specific backup
cleo validate .cleo/.backups/todo.json.3

# Restore from backup
cleo restore .cleo/.backups/todo.json.3
```

---

## Change Log System

Every operation is logged to `todo-log.json` with complete before/after state capture:

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

**Operation Types**:
- `create`: New task added
- `update`: Task field modified
- `complete`: Task marked completed
- `archive`: Task moved to archive
- `restore`: Task restored from archive
- `delete`: Task permanently deleted (rare)
- `validate`: Validation run
- `backup`: Backup created

---

## Installation and Initialization

### Global Installation

```bash
./install.sh
```

**What it does**:
1. Creates `~/.cleo/` directory
2. Copies `schemas/`, `templates/`, `scripts/`, `lib/`
3. Makes all scripts executable
4. Validates installation integrity
5. Optionally adds scripts to PATH

### Per-Project Initialization

```bash
cleo init
```

**What it does**:
1. Creates `.cleo/` directory in project root
2. Copies templates → `.cleo/`
3. Renames `.template.json` → `.json`
4. Initializes empty `todo-log.json`
5. Creates `.cleo/.backups/` directory
6. Adds `.cleo/todo*.json` to `.gitignore`
7. Validates all created files

---

## Script Reference

### Core Operations
| Script | Purpose | Usage |
|--------|---------|-------|
| `init.sh` | Initialize project | `cleo init` |
| `add.sh` | Create new task | `add.sh "Task description"` |
| `update.sh` | Update existing task | `update.sh <task-id> [OPTIONS]` |
| `complete.sh` | Mark task done | `complete.sh <task-id>` |
| `archive.sh` | Archive completed | `archive.sh [--dry-run] [--force] [--all]` |

### Query Operations
| Script | Purpose | Usage |
|--------|---------|-------|
| `list.sh` | Display tasks | `list.sh [--status STATUS]` |
| `show.sh` | Single task detail view | `show.sh <task-id> [--history] [--related]` |
| `stats.sh` | Generate stats | `stats.sh [--period DAYS]` |
| `history.sh` | Completion history analytics | `history.sh [--days N] [--since DATE]` |

### Analysis Commands
| Script | Purpose | Usage |
|--------|---------|-------|
| `dash.sh` | Project dashboard overview | `dash.sh [--compact] [--period DAYS]` |
| `next.sh` | Intelligent next task suggestion | `next.sh [--explain] [--count N]` |
| `labels.sh` | Label management and statistics | `labels.sh [show LABEL] [stats]` |
| `analyze.sh` | Task leverage and bottleneck analysis | `analyze.sh [--full] [--auto-focus]` |
| `blockers.sh` | Blocked task analysis | `blockers.sh [analyze]` |
| `deps.sh` | Dependency visualization | `deps.sh [TASK_ID] [tree]` |

### Focus and Session Management
| Script | Purpose | Usage |
|--------|---------|-------|
| `focus.sh` | Manage task focus | `focus.sh set <task-id>`, `focus.sh show`, `focus.sh clear` |
| `session.sh` | Work session lifecycle | `session.sh start`, `session.sh end`, `session.sh status` |

### Phase Operations (v2.2.0+)
| Script | Purpose | Usage |
|--------|---------|-------|
| `phase.sh` | Manage current phase | `phase.sh set <slug>`, `phase.sh show` |
| `phases.sh` | List/query phases | `phases.sh`, `phases.sh show <slug>`, `phases.sh stats` |

### TodoWrite Integration
| Script | Purpose | Usage |
|--------|---------|-------|
| `sync.sh` | Bidirectional sync orchestration | `sync.sh --inject`, `sync.sh --extract [FILE]` |
| `inject.sh` | Export tasks to TodoWrite format | `inject.sh [--max-tasks N] [--focused-only]` |
| `extract.sh` | Import TodoWrite state back | `extract.sh <file> [--dry-run]` |
| `export.sh` | Export to various formats | `export.sh --format todowrite` |

### Maintenance Operations
| Script | Purpose | Usage |
|--------|---------|-------|
| `validate.sh` | Validate files | `validate.sh [--fix]` |
| `backup.sh` | Manual backup | `backup.sh [--destination DIR]` |
| `restore.sh` | Restore backup | `restore.sh <backup-file>` |
| `exists.sh` | Task existence validation | `exists.sh <task-id> [--quiet] [--include-archive]` |
| `log.sh` | Audit log operations | `log.sh [add] [query]` |

### Migration Operations
| Script | Purpose | Usage |
|--------|---------|-------|
| `migrate.sh` | Schema migration management | `migrate.sh status`, `migrate.sh run` |
| `migrate-backups.sh` | Legacy backup migration | `migrate-backups.sh --detect`, `migrate-backups.sh --run` |

### Development Utilities
| Script | Purpose | Usage |
|--------|---------|-------|
| `bump-version.sh` | Bump version numbers | `bump-version.sh [patch\|minor\|major]` |
| `validate-version.sh` | Validate version consistency | `validate-version.sh` |
| `benchmark-performance.sh` | Performance benchmarking | `benchmark-performance.sh` |

---

## Library Functions

### validation.sh
- `validate_schema()` - JSON Schema validation
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

### phase-tracking.sh (v2.2.0+)
- `get_current_phase()` - Read current project phase
- `set_current_phase()` - Update project phase (with validation)
- `get_phase_status()` - Check phase status (pending/active/completed)
- `start_phase()` - Transition phase pending → active
- `complete_phase()` - Transition phase active → completed
- `count_phases_by_status()` - Phase statistics

---

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
CLEO_LOG_LEVEL=debug ./tests/run-all-tests.sh
```

---

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

---

## Security Considerations

### File Permissions
```bash
# Data files: owner read/write, group/other read
chmod 644 .cleo/todo*.json

# Scripts: owner all, group/other read+execute
chmod 755 ~/.cleo/scripts/*.sh

# Backups: owner only
chmod 700 .cleo/.backups/
chmod 600 .cleo/.backups/*.json
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

---

## Extension Points

### Custom Validators
Place in `.cleo/validators/`:
- Called after schema validation
- Add project-specific rules
- Integrate with team standards

### Event Hooks
Place in `.cleo/hooks/`:
- `on-task-create.sh`
- `on-task-complete.sh`
- `on-archive.sh`
- Trigger external actions

### Custom Formatters
Place in `~/.cleo/formatters/`:
- `html-report.sh`
- `csv-export.sh`
- `slack-message.sh`
- Used by list-tasks and stats

### Integration APIs
Place in `~/.cleo/integrations/`:
- `jira-sync.sh`
- `github-issues.sh`
- `trello-board.sh`
- Export to external systems

---

## Architectural Decisions

### Why Bash Scripts?

**Decision**: Implement core system in Bash with jq for JSON manipulation.

| Rationale | Trade-offs |
|-----------|------------|
| Universal availability on Unix systems | Performance ceiling lower than compiled languages |
| Simple, transparent operations | Acceptable for 1000+ tasks (< 500ms operations) |
| Easy integration with shell workflows | Complexity threshold requires refactor beyond 10K tasks |
| No runtime dependencies beyond jq | |

### Why JSON Schema?

**Decision**: Use JSON Schema for validation instead of custom validation code.

| Rationale | Trade-offs |
|-----------|------------|
| Declarative validation (separate from implementation) | Requires external validator (ajv or jsonschema) |
| Versioned contracts (schema version tracks data format) | Fallback to jq-based validation if unavailable |
| Self-documenting (schema explains structure) | |

### Why Atomic Rename?

**Decision**: Use temp file + atomic rename pattern for all writes.

| Rationale | Trade-offs |
|-----------|------------|
| OS-level atomicity guarantee (POSIX rename) | Slower than direct writes (< 50ms overhead) |
| No partial writes possible | Acceptable for data safety |
| Crash-safe (interrupted write leaves temp file) | |
| Enables rollback on validation failure | |

### Why Checksum is Detection-Only?

**Decision**: Checksum mismatches log information but don't block operations.

**Context**: Both `cleo` CLI and `TodoWrite` modify todo.json. TodoWrite doesn't know about checksums.

| Rationale | Trade-offs |
|-----------|------------|
| Multi-writer scenario support | Cannot use checksum as optimistic locking |
| Blocking would break normal Claude Code workflows | External modifications proceed without approval |
| Real protection: schema + semantic checks + atomic writes | |

**Checksum is used for**: Detecting external modifications (logged), backup integrity verification, corruption detection in disaster recovery.

### Why Separate Archive File?

**Decision**: Completed tasks move to `todo-archive.json`.

| Rationale | Trade-offs |
|-----------|------------|
| Active task list stays small (fast operations) | Cross-file queries more complex |
| Archive is immutable (optimize for read-only) | Careful handling during archival |
| Separate retention policies | |
| Clear separation: active vs historical | |

### Why Auto-Derived activeForm?

**Decision**: Generate `activeForm` from task `title` during TodoWrite export.

**Context**: Claude Code's TodoWrite uses `content` (imperative) and `activeForm` (present continuous).

| Rationale | Implementation |
|-----------|----------------|
| Single source of truth (title written once) | Grammar transformation in lib/grammar.sh |
| No schema changes required | Export: `cleo export --format todowrite` |
| Clean bidirectional mapping | Fallback: "Working on X" for edge cases |

---

## Version Management

### Versioning Strategy

```
Major.Minor.Patch
  │     │     │
  │     │     └─ Bug fixes (backward compatible)
  │     └─────── New features (backward compatible)
  └───────────── Breaking changes (migration required)
```

### Migration Path

Migrations run automatically on upgrade:

```
~/.cleo/migrations/
├── migrate-1.0-to-1.1.sh
├── migrate-1.1-to-2.0.sh
└── rollback-2.0-to-1.1.sh
```

### Backward Compatibility

- New fields optional by default
- Deprecated fields supported for 2 major versions
- Clear migration documentation
- Automatic schema version detection

---

## Summary

This architecture provides a robust, maintainable, and extensible task management system that:

✅ **Robust**: Schema validation + anti-hallucination checks prevent corruption
✅ **Safe**: Atomic operations, automatic backups, validation gates
✅ **Auditable**: Comprehensive logging, complete change history
✅ **Maintainable**: Clear separation of concerns, modular design
✅ **Extensible**: Hooks, validators, formatters, integrations
✅ **Performant**: Optimized for 1000+ tasks
✅ **User-Friendly**: Zero-config defaults, clear error messages
✅ **Portable**: Single installation, per-project initialization

The system scales from simple personal task tracking to complex team workflows while maintaining data integrity and preventing hallucination-based errors.
