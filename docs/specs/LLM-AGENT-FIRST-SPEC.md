# Claude-TODO LLM-Agent-First Specification

> **Authoritative standard for LLM-agent-first CLI design**
>
> **Version**: 3.2 | **Updated**: 2025-12-19
> **Scope**: 34 commands, universal standards for agent automation

---

## RFC 2119 Conformance

This specification uses RFC 2119 keywords to indicate requirement levels:

| Keyword | Meaning |
|---------|---------|
| **MUST** | Absolute requirement. Non-compliance is a specification violation. |
| **MUST NOT** | Absolute prohibition. |
| **SHALL** | Equivalent to MUST. |
| **SHOULD** | Recommended but not mandatory. Valid reasons may exist to ignore. |
| **SHOULD NOT** | Discouraged but not prohibited. |
| **MAY** | Optional. Implementations can choose to include or omit. |

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| **[SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)** | **AUTHORITATIVE** for specification standards |
| **[LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md)** | **AUTHORITATIVE** for task ID format, validation, error codes 10-22 |
| **[TASK-HIERARCHY-SPEC.md](TASK-HIERARCHY-SPEC.md)** | Hierarchy features (type, parentId, size) affecting JSON output |
| **[RCSD-PIPELINE-SPEC.md](RCSD-PIPELINE-SPEC.md)** | Uses: RCSD commands (consensus, spec, decompose) MUST follow this spec |
| **[LLM-TASK-ID-SYSTEM-DESIGN-IMPLEMENTATION-REPORT.md](LLM-TASK-ID-SYSTEM-DESIGN-IMPLEMENTATION-REPORT.md)** | Tracks implementation status against all LLM specs |

---

## Executive Summary

### Mission Statement

Design CLI tools with **LLM-agent-first** principles: JSON output by default, human output opt-in via `--human` flag, structured errors, and consistent behavior across all commands.

### Core Principles

| Principle | Requirement |
|-----------|-------------|
| **JSON by Default** | All commands MUST default to JSON output |
| **Human Opt-In** | Human-readable output via explicit `--human` flag |
| **Structured Errors** | All errors MUST return JSON with error codes |
| **Consistent Flags** | All commands MUST support `--format` and `--quiet` |
| **Documented Exit Codes** | Every exit code MUST be a defined constant |
| **Schema Validation** | All JSON MUST include `$schema` field |

### Reference Implementation

**`analyze.sh`** exemplifies the gold standard for LLM-agent-first design:
- **JSON output is DEFAULT** (human requires explicit `--human` flag)
- Comprehensive `_meta` envelope with version, timestamp, algorithm
- Structured recommendations with `action_order`, `recommendation.command`
- Exit codes documented (0=success, 1=error, 2=no tasks)

---

## Part 1: Command Inventory

### All Commands (34 total)

| # | Command | Script | Category | Requirements |
|---|---------|--------|----------|--------------|
| 1 | `add` | `add-task.sh` | Write | JSON output, `--format`, `--quiet` |
| 2 | `analyze` | `analyze.sh` | Read | JSON default, `--human` opt-in |
| 3 | `archive` | `archive.sh` | Write | JSON output, `--format`, `--quiet`, `--dry-run` |
| 4 | `backup` | `backup.sh` | Maintenance | JSON output, `--format`, `--quiet` |
| 5 | `blockers` | `blockers-command.sh` | Read | JSON output, `--format`, `--quiet` |
| 6 | `complete` | `complete-task.sh` | Write | JSON output, `--format`, `--quiet`, `--dry-run` |
| 7 | `commands` | `commands.sh` | Read | JSON default, `--human` opt-in, filters |
| 8 | `config` | `config.sh` | Maintenance | JSON output, `--format`, `--quiet` |
| 9 | `dash` | `dash.sh` | Read | JSON output, `--format`, `--quiet` |
| 10 | `deps` | `deps-command.sh` | Read | JSON output, `--format`, `--quiet` |
| 11 | `exists` | `exists.sh` | Read | JSON output, `--format`, `--quiet` |
| 12 | `export` | `export.sh` | Read | Multi-format, `--quiet` |
| 13 | `extract` | `extract-todowrite.sh` | Sync | JSON output, `--format`, `--quiet`, `--dry-run` |
| 14 | `find` | `find.sh` | Read | JSON output, `--format`, `--quiet`, fuzzy search |
| 15 | `focus` | `focus.sh` | Write | JSON output, `--format`, `--quiet` |
| 16 | `history` | `history.sh` | Read | JSON output, `--format`, `--quiet` |
| 17 | `init` | `init.sh` | Setup | JSON output, `--format`, `--quiet` |
| 18 | `inject` | `inject-todowrite.sh` | Sync | JSON output, `--format`, `--quiet`, `--dry-run` |
| 19 | `labels` | `labels.sh` | Read | JSON output, `--format`, `--quiet` |
| 20 | `list` | `list-tasks.sh` | Read | JSON output, `--format`, `--quiet` |
| 21 | `log` | `log.sh` | Read | JSON output, `--format`, `--quiet` |
| 22 | `migrate` | `migrate.sh` | Maintenance | JSON output, `--format`, `--quiet`, `--dry-run` |
| 23 | `migrate-backups` | `migrate-backups.sh` | Maintenance | JSON output, `--format`, `--quiet`, `--dry-run` |
| 24 | `next` | `next.sh` | Read | JSON output, `--format`, `--quiet` |
| 25 | `phase` | `phase.sh` | Write | JSON output, `--format`, `--quiet` |
| 26 | `phases` | `phases.sh` | Read | JSON output, `--format`, `--quiet` |
| 27 | `research` | `research.sh` | Read | JSON output, `--format`, `--quiet`, Context7 integration |
| 28 | `restore` | `restore.sh` | Maintenance | JSON output, `--format`, `--quiet`, `--dry-run` |
| 29 | `session` | `session.sh` | Write | JSON output, `--format`, `--quiet` |
| 30 | `show` | `show.sh` | Read | JSON output, `--format`, `--quiet` |
| 31 | `stats` | `stats.sh` | Read | JSON output, `--format`, `--quiet` |
| 32 | `sync` | `sync-todowrite.sh` | Sync | JSON output, `--format`, `--quiet`, `--dry-run` |
| 33 | `update` | `update-task.sh` | Write | JSON output, `--format`, `--quiet`, `--dry-run` |
| 34 | `validate` | `validate.sh` | Maintenance | JSON output, `--format`, `--quiet` |

### Command Categories

| Category | Commands | Special Requirements |
|----------|----------|---------------------|
| **Write** | add, archive, complete, focus, phase, session, update | MUST return created/updated object, MUST support `--dry-run` |
| **Read** | analyze, blockers, commands, dash, deps, exists, export, find, history, labels, list, log, next, phases, research, show, stats | MUST support filtering, MUST return structured data |
| **Sync** | extract, inject, sync | MUST support `--dry-run`, MUST report conflicts |
| **Maintenance** | backup, config, init, migrate, migrate-backups, restore, validate | MUST report status, SHOULD support `--dry-run` |
| **Setup** | init | MUST be idempotent |

---

## Part 2: Gap Analysis

### Gap 1: JSON Output Inconsistencies

**Impact**: Agents need consistent JSON envelope across all commands

| Command | Current Output | Required Fix |
|---------|----------------|--------------|
| `add` | Has JSON but missing `$schema` | Add schema, standardize envelope |
| `update` | Has JSON but inconsistent | Standardize envelope |
| `complete` | Has JSON output | Standardize envelope |
| `archive` | Has JSON output | Standardize envelope |
| `phase` subcommands | Partial JSON | Complete JSON for all subcommands |

**Required JSON Output** (v0.17.0 hierarchy fields):

```json
// ct add "Task" --parent T001 --format json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"command": "add", "timestamp": "...", "version": "..."},
  "success": true,
  "task": {
    "id": "T042",
    "type": "task",
    "parentId": "T001",
    "size": null,
    "title": "...",
    "status": "pending",
    "createdAt": "..."
  }
}

// ct update T042 --priority high --format json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"command": "update", "timestamp": "..."},
  "success": true,
  "taskId": "T042",
  "changes": {"priority": {"before": "medium", "after": "high"}},
  "task": {
    "id": "T042",
    "type": "task",
    "parentId": "T001",
    "priority": "high",
    /* ... full updated task */
  }
}

// ct complete T042 --format json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"command": "complete", "timestamp": "..."},
  "success": true,
  "taskId": "T042",
  "completedAt": "2025-12-17T10:00:00Z",
  "cycleTimeDays": 3.5,
  "parentAutoComplete": false
}
```

### Gap 2: JSON Default Implementation

**Location**: `lib/output-format.sh` `resolve_format()`

**Current Issue**: Not all scripts call `resolve_format()` or respect its result.

**Required Behavior (LLM-Agent-First)**:
```bash
# Default fallback: JSON by default (LLM-Agent-First)
if [[ -z "$resolved_format" ]]; then
  resolved_format="json"  # JSON is always the default
fi
```

**Rationale**: Per LLM-Agent-First philosophy, agents are the primary consumer. JSON output by default enables seamless agent integration without requiring explicit flags. Developers use `--human` when they need human-readable output.

**MUST** be implemented in ALL commands via `resolve_format()` call.

### Gap 3: Standardized Error JSON Format

**Current Status**: Error JSON implemented in `lib/error-json.sh`

**Error JSON Envelope** (IMPLEMENTED):
```json
// Task not found
{
  "$schema": "https://cleo.dev/schemas/v1/error.schema.json",
  "_meta": {"command": "show", "timestamp": "...", "version": "..."},
  "success": false,
  "error": {
    "code": "E_TASK_NOT_FOUND",
    "message": "Task T999 does not exist",
    "exitCode": 4,
    "recoverable": false,
    "suggestion": "Use 'ct exists' to verify task ID"
  }
}

// Hierarchy error
{
  "$schema": "https://cleo.dev/schemas/v1/error.schema.json",
  "_meta": {"command": "add", "timestamp": "...", "version": "..."},
  "success": false,
  "error": {
    "code": "E_PARENT_NOT_FOUND",
    "message": "Parent task T999 does not exist",
    "exitCode": 10,
    "recoverable": true,
    "suggestion": "Use 'ct list --type epic,task' to find valid parents",
    "context": {"requestedParent": "T999"}
  }
}
```

### Gap 4: Phase Commands Need Full JSON

**`phase.sh`** subcommands MUST output JSON when `--format json` is specified.

**Required for each subcommand**:
```json
// phase show --format json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"command": "phase show", "timestamp": "..."},
  "success": true,
  "currentPhase": {
    "slug": "core",
    "name": "Core Development",
    "status": "active",
    "startedAt": "2025-12-10T14:30:00Z",
    "durationDays": 7.2
  }
}
```

### Gap 5: Flag Inconsistency Across Commands

**Conflict Matrix**:

| Short Flag | Conflicting Uses | Resolution |
|------------|------------------|------------|
| `-f` | `--format` (7 commands) vs `--files` (update) | Keep `-f` for `--format`, `--files` long-form only |
| `-n` | `--notes` (3 commands) vs `--count` (next) | Keep `-n` for `--notes`, use `-c` for `--count` |

**Missing Universal Flags**:

| Flag | Current Coverage | Target |
|------|-----------------|--------|
| `--format` | 17/32 (53%) | 100% |
| `--quiet` | 21/32 (66%) | 100% |
| `--verbose` | 2/32 (6%) | All display commands |
| `--dry-run` | 3/32 (9%) | All write operations |

---

## Part 3: Standardized Systems

### 3.1 Exit Code Standard (AUTHORITATIVE)

**File**: `lib/exit-codes.sh`

**Exit Code Ranges**:
- `0`: Success
- `1-9`: General errors
- `10-19`: Hierarchy errors (see LLM-TASK-ID-SYSTEM-DESIGN-SPEC)
- `20-29`: Concurrency errors
- `100+`: Special conditions (not errors)

#### Complete Exit Code Table

| Code | Constant | Meaning | Recoverable | Example |
|------|----------|---------|-------------|---------|
| **General (0-9)** |
| 0 | `EXIT_SUCCESS` | Operation completed successfully | N/A | Task created |
| 1 | `EXIT_GENERAL_ERROR` | Unspecified error | Yes | Unknown failure |
| 2 | `EXIT_INVALID_INPUT` | Invalid user input/arguments | Yes | Missing required arg |
| 3 | `EXIT_FILE_ERROR` | File system operation failed | No | Permission denied |
| 4 | `EXIT_NOT_FOUND` | Requested resource not found | Yes | Task ID not found |
| 5 | `EXIT_DEPENDENCY_ERROR` | Missing dependency | No | jq not installed |
| 6 | `EXIT_VALIDATION_ERROR` | Data validation failed | Yes | Schema violation |
| 7 | `EXIT_LOCK_TIMEOUT` | Failed to acquire lock | Yes | Concurrent write |
| 8 | `EXIT_CONFIG_ERROR` | Configuration error | Yes | Invalid config |
| **Hierarchy (10-19)** |
| 10 | `EXIT_PARENT_NOT_FOUND` | parentId references non-existent task | Yes | --parent T999 invalid |
| 11 | `EXIT_DEPTH_EXCEEDED` | Max hierarchy depth (3) exceeded | Yes | Too deeply nested |
| 12 | `EXIT_SIBLING_LIMIT` | Max siblings (7) exceeded | Yes | Parent has 7 children |
| 13 | `EXIT_INVALID_PARENT_TYPE` | subtask cannot have children | Yes | subtask as parent |
| 14 | `EXIT_CIRCULAR_REFERENCE` | Task would be ancestor of itself | No | Cycle detected |
| 15 | `EXIT_ORPHAN_DETECTED` | Task has invalid parentId | Yes | Parent was deleted |
| **Concurrency (20-29)** |
| 20 | `EXIT_CHECKSUM_MISMATCH` | File modified externally | Yes | Retry operation |
| 21 | `EXIT_CONCURRENT_MODIFICATION` | Multi-agent conflict | Yes | Retry with backoff |
| 22 | `EXIT_ID_COLLISION` | ID generation conflict | Yes | Regenerate ID |
| **Special (100+)** |
| 100 | `EXIT_NO_DATA` | No data to process (not error) | N/A | Empty query result |
| 101 | `EXIT_ALREADY_EXISTS` | Resource already exists | N/A | Task ID exists |
| 102 | `EXIT_NO_CHANGE` | No changes needed | N/A | Update was no-op |

#### Exit Code Semantics (AUTHORITATIVE)

Commands **MUST** use the following exit codes:

| Scenario | Exit Code | Error Code |
|----------|-----------|------------|
| Task not found | 4 | `E_TASK_NOT_FOUND` |
| Invalid task ID format | 2 | `E_TASK_INVALID_ID` |
| File not readable | 3 | `E_FILE_READ_ERROR` |
| Missing required argument | 2 | `E_INPUT_MISSING` |
| JSON schema validation failed | 6 | `E_VALIDATION_SCHEMA` |
| Parent task not found (hierarchy) | 10 | `E_PARENT_NOT_FOUND` |
| Would create circular reference | 14 | `E_CIRCULAR_REFERENCE` |
| Lock acquisition timeout | 7 | N/A (no E_ code) |
| Empty query result | 100 | N/A (not an error) |

### 3.2 Error Code Standard (AUTHORITATIVE)

**File**: `lib/error-json.sh`

**Convention**: All error codes use `E_` prefix.

#### Complete Error Code Table (29 codes)

| Category | Code | Exit Code | Description |
|----------|------|-----------|-------------|
| **Task Errors** |
| | `E_TASK_NOT_FOUND` | 4 | Task ID does not exist |
| | `E_TASK_ALREADY_EXISTS` | 101 | Task ID already exists |
| | `E_TASK_INVALID_ID` | 2 | Task ID format is invalid |
| | `E_TASK_INVALID_STATUS` | 2 | Status value not in enum |
| **File Errors** |
| | `E_FILE_NOT_FOUND` | 4 | File does not exist |
| | `E_FILE_READ_ERROR` | 3 | Cannot read file |
| | `E_FILE_WRITE_ERROR` | 3 | Cannot write file |
| | `E_FILE_PERMISSION` | 3 | Permission denied |
| **Validation Errors** |
| | `E_VALIDATION_SCHEMA` | 6 | JSON schema validation failed |
| | `E_VALIDATION_CHECKSUM` | 6 | Checksum mismatch |
| | `E_VALIDATION_REQUIRED` | 6 | Required field missing |
| **Input Errors** |
| | `E_INPUT_MISSING` | 2 | Required argument missing |
| | `E_INPUT_INVALID` | 2 | Argument value invalid |
| | `E_INPUT_FORMAT` | 2 | Argument format incorrect |
| **Dependency Errors** |
| | `E_DEPENDENCY_MISSING` | 5 | Required tool not installed |
| | `E_DEPENDENCY_VERSION` | 5 | Tool version incompatible |
| **Phase Errors** |
| | `E_PHASE_NOT_FOUND` | 4 | Phase slug does not exist |
| | `E_PHASE_INVALID` | 2 | Phase definition invalid |
| **Session Errors** |
| | `E_SESSION_ACTIVE` | 101 | Session already active |
| | `E_SESSION_NOT_ACTIVE` | 4 | No active session |
| **General Errors** |
| | `E_UNKNOWN` | 1 | Unknown/unspecified error |
| | `E_NOT_INITIALIZED` | 4 | Project not initialized |
| **Hierarchy Errors** |
| | `E_PARENT_NOT_FOUND` | 10 | Parent task does not exist |
| | `E_DEPTH_EXCEEDED` | 11 | Hierarchy depth limit exceeded |
| | `E_SIBLING_LIMIT` | 12 | Sibling limit exceeded |
| | `E_INVALID_PARENT_TYPE` | 13 | Parent type cannot have children |
| | `E_CIRCULAR_REFERENCE` | 14 | Would create cycle |
| | `E_ORPHAN_DETECTED` | 15 | Task references invalid parent |
| **Concurrency Errors** |
| | `E_CHECKSUM_MISMATCH` | 20 | File modified during operation |
| | `E_CONCURRENT_MODIFICATION` | 21 | Multi-agent conflict detected |
| | `E_ID_COLLISION` | 22 | Generated ID already exists |

### 3.3 JSON Schema Standard

#### Schema Files

| Schema | File | Status | Purpose |
|--------|------|--------|---------|
| Task Data | `schemas/todo.schema.json` | EXISTS | Task/project data validation |
| Archive | `schemas/archive.schema.json` | EXISTS | Archived tasks validation |
| Log | `schemas/log.schema.json` | EXISTS | Audit log validation |
| Config | `schemas/config.schema.json` | EXISTS | Configuration validation |
| Response | `schemas/output.schema.json` | EXISTS | Success response envelope |
| Error | `schemas/error.schema.json` | EXISTS | Error response envelope |
| Critical Path | `schemas/critical-path.schema.json` | EXISTS | Critical path analysis response |

#### Response Schema (`schemas/output.schema.json`)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo.dev/schemas/v1/output.schema.json",
  "title": "Claude-TODO Response Envelope",
  "type": "object",
  "required": ["_meta", "success"],
  "properties": {
    "$schema": {"type": "string"},
    "_meta": {
      "type": "object",
      "required": ["command", "timestamp", "version"],
      "properties": {
        "format": {"type": "string", "const": "json"},
        "version": {"type": "string"},
        "command": {"type": "string"},
        "timestamp": {"type": "string", "format": "date-time"},
        "checksum": {"type": "string"},
        "execution_ms": {"type": "integer", "minimum": 0}
      }
    },
    "success": {"type": "boolean"},
    "summary": {"type": "object"},
    "data": {},
    "task": {"type": "object"},
    "tasks": {"type": "array"},
    "warnings": {"type": "array"}
  }
}
```

#### Error Schema (`schemas/error.schema.json`)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo.dev/schemas/v1/error.schema.json",
  "title": "Claude-TODO Error Envelope",
  "type": "object",
  "required": ["_meta", "success", "error"],
  "properties": {
    "$schema": {"type": "string"},
    "_meta": {
      "type": "object",
      "required": ["command", "timestamp", "version"],
      "properties": {
        "format": {"type": "string", "const": "json"},
        "version": {"type": "string"},
        "command": {"type": "string"},
        "timestamp": {"type": "string", "format": "date-time"}
      }
    },
    "success": {"const": false},
    "error": {
      "type": "object",
      "required": ["code", "message", "exitCode"],
      "properties": {
        "code": {"type": "string", "pattern": "^E_[A-Z_]+$"},
        "message": {"type": "string"},
        "exitCode": {"type": "integer", "minimum": 1},
        "recoverable": {"type": "boolean"},
        "suggestion": {"type": ["string", "null"]},
        "context": {"type": "object"}
      }
    }
  }
}
```

### 3.4 JSON Envelope Standard (AUTHORITATIVE)

All JSON outputs **MUST** follow this envelope:

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "version": "<version>",
    "command": "<command-name>",
    "timestamp": "<ISO-8601>",
    "checksum": "<sha256>",      // OPTIONAL: For data integrity
    "execution_ms": <ms>         // OPTIONAL: For performance monitoring
  },
  "success": true,
  "summary": {},                  // OPTIONAL: Aggregated stats
  "data": []                      // OR task/tasks/etc depending on command
}
```

#### Required `_meta` Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `format` | string | **MUST** | Always `"json"` for JSON output |
| `version` | string | **MUST** | cleo version (e.g., `"0.17.0"`) |
| `command` | string | **MUST** | Command name (e.g., `"add"`, `"list"`) |
| `timestamp` | string | **MUST** | ISO-8601 UTC timestamp |
| `checksum` | string | MAY | SHA256 of file for integrity |
| `execution_ms` | integer | MAY | Execution time in milliseconds |

### 3.5 Universal Flag Standard (AUTHORITATIVE)

| Flag | Long Form | Purpose | Default | Commands |
|------|-----------|---------|---------|----------|
| `-f` | `--format` | Output format | `json` | ALL |
| `-q` | `--quiet` | Suppress non-essential output | false | ALL |
| `-v` | `--verbose` | Detailed output | false | ALL read commands |
| | `--human` | Force human-readable text | false | ALL |
| | `--json` | Force JSON (shortcut for `--format json`) | N/A (already default) | ALL |
| | `--dry-run` | Preview changes | false | ALL write commands |
| | `--force` | Skip confirmations | false | Destructive commands |

**LLM-Agent-First Principle**: JSON is the default output format. Use `--human` to get human-readable text output. The `--json` flag exists for explicit clarity but is redundant since JSON is already the default.

#### Format Values

| Format | Description | Use Case |
|--------|-------------|----------|
| `text` | Human-readable colored output | Interactive terminal |
| `json` | Machine-readable JSON envelope | Agent automation |
| `jsonl` | JSON Lines (one object per line) | Streaming/logging |
| `markdown` | Markdown formatted | Documentation |
| `table` | ASCII table | Terminal display |

---

## Part 4: Required Libraries

### Foundation Libraries

All commands **MUST** source these libraries:

| Library | Purpose | Required By |
|---------|---------|-------------|
| `lib/exit-codes.sh` | Standardized exit code constants | ALL commands |
| `lib/error-json.sh` | Format-aware error output | ALL commands |
| `lib/output-format.sh` | TTY-aware format resolution | ALL commands |

### Library Integration Pattern

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

# MUST source these libraries
source "${LIB_DIR}/exit-codes.sh"
source "${LIB_DIR}/error-json.sh"
source "${LIB_DIR}/output-format.sh"

# MUST set command name for error reporting
COMMAND_NAME="<command>"
```

---

## Part 5: Write Command Requirements

### All Write Commands MUST:

1. **Return the created/updated object** in JSON output
2. **Include `$schema` field** pointing to `output.schema.json`
3. **Include complete `_meta` envelope**
4. **Support `--dry-run`** to preview changes without executing
5. **Use `output_error()`** for all error conditions

### JSON Output Examples

#### `add` Command Output
```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"format": "json", "version": "0.17.0", "command": "add", "timestamp": "..."},
  "success": true,
  "task": {"id": "T042", "type": "task", "parentId": null, "title": "...", "status": "pending"}
}
```

#### `update` Command Output
```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"format": "json", "version": "0.17.0", "command": "update", "timestamp": "..."},
  "success": true,
  "taskId": "T042",
  "changes": {"priority": {"before": "medium", "after": "high"}},
  "task": {"id": "T042", "priority": "high", "...": "..."}
}
```

#### `complete` Command Output
```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"format": "json", "version": "0.17.0", "command": "complete", "timestamp": "..."},
  "success": true,
  "taskId": "T042",
  "completedAt": "2025-12-17T10:00:00Z",
  "cycleTimeDays": 3.5
}
```

### Subcommand Requirements (e.g., `phase.sh`)

Commands with subcommands **MUST**:
- Accept `--format` flag **before** the subcommand
- Each subcommand **MUST** respect the FORMAT variable
- Each subcommand **MUST** output proper JSON envelope

### Part 5.3: Input Validation Requirements

Write commands **MUST** validate all inputs before modifying state:

#### Field Length Limits

| Field | Max Length | Error Code |
|-------|------------|------------|
| title | 120 chars | `E_INPUT_INVALID` |
| description | 2000 chars | `E_INPUT_INVALID` |
| notes (each) | 500 chars | `E_INPUT_INVALID` |
| blockedBy reason | 300 chars | `E_INPUT_INVALID` |
| sessionNote | 1000 chars | `E_INPUT_INVALID` |
| label name | 50 chars | `E_INPUT_INVALID` |
| phase slug | 30 chars | `E_INPUT_INVALID` |

#### Validation Order

Commands **MUST** validate in this order:
1. Required arguments present (`E_INPUT_MISSING`)
2. Format/type validation (`E_INPUT_FORMAT`)
3. Length validation (`E_INPUT_INVALID`)
4. Semantic validation (`E_VALIDATION_*`)

#### Validation Response

Failed validation **MUST** return immediately (fail-fast) with:
- Specific error code
- Field name in error message
- Actual vs. allowed value info

### Part 5.4: Dry-Run Semantics

Commands with `--dry-run` **MUST** follow these semantics:

| Behavior | With --dry-run | Without --dry-run |
|----------|----------------|-------------------|
| Validation | Full | Full |
| File locking | None | Full |
| State modification | None | Full |
| JSON output | Full (with `dryRun: true`) | Full |
| Exit code | Same as real | Same |

#### Dry-Run Output

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"format": "json", "version": "0.17.0", "command": "add"},
  "success": true,
  "dryRun": true,
  "wouldCreate": {
    "id": "T999",
    "title": "Example task"
  }
}
```

Dry-run mode allows agents to validate inputs without side effects.

### Part 5.6: Idempotency Requirements

Write commands **MUST** be idempotent where feasible to support agent retries without side effects:

| Command | Idempotency | Mechanism |
|---------|-------------|-----------|
| `add` | SHOULD | Detect duplicate title+phase within 60s window, return existing task |
| `update` | MUST | Updating with identical values returns `EXIT_NO_CHANGE` (102) |
| `complete` | MUST | Completing already-done task returns `EXIT_NO_CHANGE` (102) |
| `archive` | MUST | Re-archiving already-archived tasks is a no-op |
| `restore` | MUST | Restoring already-active task returns `EXIT_NO_CHANGE` (102) |

#### Duplicate Detection for `add`

When creating a new task, the CLI **SHOULD** check if an identical task (same title, same phase) was created within the last 60 seconds. If found:

1. Return the existing task with `success: true`
2. Include `"duplicate": true` in response
3. Use exit code 0 (success, not error)

This prevents agents from creating duplicates during retry loops.

#### EXIT_NO_CHANGE Semantics

Exit code 102 (`EXIT_NO_CHANGE`) indicates:

- The command was valid
- No changes were made (state unchanged)
- Agents **SHOULD** treat this as success and not retry

Example response:

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"format": "json", "version": "0.17.0", "command": "complete"},
  "success": true,
  "noChange": true,
  "message": "Task T042 is already complete"
}
```

#### Non-Idempotent Operations

The following operations are inherently non-idempotent and **MUST** be documented in help text:

- `backup create` - Creates new backup each time
- `session start` - Only valid if no session active
- `log` entries - Each invocation appends

### Part 5.7: Retry Protocol for Recoverable Errors

Agents **SHOULD** implement retry logic for recoverable errors with exponential backoff:

| Exit Code | Name | Max Retries | Initial Delay | Backoff Factor |
|:---------:|------|:-----------:|:-------------:|:--------------:|
| 7 | `EXIT_LOCK_TIMEOUT` | 3 | 100ms | 2x |
| 20 | `EXIT_CHECKSUM_MISMATCH` | 5 | 50ms | 1.5x |
| 21 | `EXIT_CONCURRENT_MODIFICATION` | 5 | 100ms | 2x |
| 22 | `EXIT_ID_COLLISION` | 3 | 0ms | immediate regenerate |

#### Retry Algorithm

```python
def execute_with_retry(command, max_retries, initial_delay_ms, backoff_factor):
    delay = initial_delay_ms
    for attempt in range(max_retries + 1):
        exit_code, output = execute(command)

        if exit_code == 0 or not is_recoverable(exit_code):
            return exit_code, output

        if attempt < max_retries:
            sleep(delay / 1000)  # Convert to seconds
            delay *= backoff_factor

    return exit_code, output  # Final failure

def is_recoverable(code):
    return code in [7, 20, 21, 22]
```

#### ID Collision Handling (Exit Code 22)

For `EXIT_ID_COLLISION`, agents **SHOULD**:
1. Extract the colliding ID from error JSON
2. Regenerate a new ID (or let CLI auto-generate)
3. Retry immediately without delay

#### Maximum Total Wait

Agents **SHOULD** cap total retry wait time at 5 seconds to avoid blocking workflows.

---

## Part 6: Testing Requirements (AUTHORITATIVE)

### 6.1 Exit Code Testing

All commands **MUST** have tests verifying:

```bash
#!/usr/bin/env bash
# Test success
ct add "Test task" -q
[[ $? -eq 0 ]] || echo "FAIL: add should exit 0"

# Test not found
ct show T999 2>/dev/null
[[ $? -eq 4 ]] || echo "FAIL: show non-existent should exit 4"

# Test invalid input
ct add 2>/dev/null
[[ $? -eq 2 ]] || echo "FAIL: add without title should exit 2"

# Test hierarchy errors
ct add "Task" --parent T999 2>/dev/null
[[ $? -eq 10 ]] || echo "FAIL: invalid parent should exit 10"
```

### 6.2 JSON Output Testing

All commands with JSON output **MUST** have tests verifying:

```bash
#!/usr/bin/env bash
# Test add returns valid JSON with task
result=$(ct add "JSON Test" --format json)
echo "$result" | jq -e '.success == true' || echo "FAIL: success should be true"
echo "$result" | jq -e '.task.id' || echo "FAIL: should have task.id"
echo "$result" | jq -e '._meta.command == "add"' || echo "FAIL: should have _meta.command"
echo "$result" | jq -e '."$schema"' || echo "FAIL: should have $schema"

# Test error JSON
result=$(ct show T999 --format json 2>&1)
echo "$result" | jq -e '.success == false' || echo "FAIL: should be unsuccessful"
echo "$result" | jq -e '.error.code' || echo "FAIL: should have error.code"
```

### 6.3 TTY Detection Testing

```bash
#!/usr/bin/env bash
# Piped output should be JSON
format=$(ct list | jq -r '._meta.format' 2>/dev/null)
[[ "$format" == "json" ]] || echo "FAIL: piped output should default to JSON"

# Explicit --human should override
output=$(ct list --human | head -1)
[[ "$output" != "{" ]] || echo "FAIL: --human should output text"

# Environment variable should work
CLEO_FORMAT=json ct list | jq -e '._meta' || echo "FAIL: env var should work"
```

### 6.4 Test Coverage Requirements

| Category | Minimum Coverage | Commands |
|----------|-----------------|----------|
| Exit codes | 100% of defined codes | All |
| JSON envelope | All required fields | All JSON-enabled |
| Error JSON | All error codes used | All |
| Flag parsing | All flags | All |
| TTY detection | Auto-detect + overrides | All format-enabled |

---

## Part 7: Agent Integration Guide

### Environment Setup

```bash
# Agent-optimized environment
export CLEO_FORMAT=json
export NO_COLOR=1
export CLEO_AGENT_MODE=1
```

### Query Patterns (Work Today)

```bash
# Task listing (auto-JSON when piped)
ct list | jq '.tasks[]'

# Analysis (already JSON default!)
ct analyze | jq '.recommendations'

# Single task
ct show T001 --format json

# Validation
ct validate --json --quiet && echo "Valid"
```

### Write Patterns (v0.17.0)

```bash
# Single command returns complete result
task_json=$(ct add "Task")
task_id=$(echo "$task_json" | jq -r '.task.id')

# Update returns changes + updated task
ct update T001 --priority high | jq '.changes'

# Complete returns confirmation
ct complete T001 | jq '.cycleTimeDays'
```

---

## Part 8: Compliance Metrics

### Required Metrics for Full Compliance

| Metric | Required Value |
|--------|----------------|
| Agent workflow steps per mutation | 1x (command returns result) |
| Commands requiring explicit `--format json` | 0/32 (auto-detect via TTY) |
| Error handling method | JSON with `E_` error codes |
| Write confirmation in response | YES (full object returned) |
| Exit code coverage | 100% (all codes are constants) |
| `$schema` field presence | 100% of JSON outputs |
| `_meta` envelope presence | 100% of JSON outputs |

### Compliance Definition

A command is **fully compliant** when it:

1. Sources all required libraries (`exit-codes.sh`, `error-json.sh`, `output-format.sh`)
2. Calls `resolve_format()` after argument parsing
3. Supports `--format`, `--quiet`, `--json`, `--human` flags
4. Returns JSON with `$schema` and `_meta` envelope
5. Uses `output_error()` for all errors
6. Uses exit code constants (no magic numbers)
7. (Write commands) Supports `--dry-run`
8. (Write commands) Returns created/updated object

---

## Part 9: Command Compliance Requirements

All commands **MUST** meet these requirements:

| Command | JSON | Quiet | Format | Dry-Run | exit-codes | error-json | resolve_format |
|---------|------|-------|--------|---------|------------|------------|----------------|
| add | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| analyze | ✅ | N/A | ✅ | N/A | ✅ | ✅ | ✅ |
| archive | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| backup | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| blockers | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| complete | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| commands | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| config | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| dash | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| deps | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| exists | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| export | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| extract | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| find | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| focus | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| history | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| init | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| inject | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| labels | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| list | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| log | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| migrate | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| migrate-backups | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| next | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| phase | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| phases | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| research | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| restore | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| session | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| show | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| stats | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |
| sync | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| update | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| validate | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ |

**Legend**: ✅ = REQUIRED | N/A = Not Applicable for this command type

**All 34 commands MUST achieve 100% compliance with applicable requirements.**

---

## Part 10: Development Workflow (AUTHORITATIVE)

### Adding a New Command

When adding a new command to cleo, **MUST** follow this checklist:

#### 1. Foundation

- [ ] Source `lib/exit-codes.sh` at script start
- [ ] Source `lib/error-json.sh` at script start
- [ ] Source `lib/output-format.sh` at script start
- [ ] Set `COMMAND_NAME` variable for error reporting

#### 2. Flag Parsing

- [ ] Implement `--format` flag (text|json|jsonl|markdown|table)
- [ ] Implement `--quiet` flag (suppress non-essential output)
- [ ] Implement `--human` shortcut (sets format=text)
- [ ] Implement `--json` shortcut (sets format=json)
- [ ] For write commands: implement `--dry-run`
- [ ] For destructive commands: implement `--force`
- [ ] Call `resolve_format()` after parsing all arguments

#### 3. JSON Output

- [ ] Include `$schema` field in all JSON outputs
- [ ] Include complete `_meta` envelope (format, version, command, timestamp)
- [ ] Include `success` boolean field
- [ ] For task operations: include full task object with hierarchy fields
- [ ] For errors: use `output_error()` from error-json.sh

#### 4. Exit Codes

- [ ] Use constants from `lib/exit-codes.sh` (never magic numbers)
- [ ] Document all possible exit codes in command help
- [ ] Return `EXIT_SUCCESS` (0) on success
- [ ] Return appropriate error code on failure
- [ ] Return special codes (100+) for non-error conditions

#### 5. Testing

- [ ] Add unit tests for flag parsing
- [ ] Add unit tests for JSON output structure
- [ ] Add unit tests for all exit codes
- [ ] Add integration tests for TTY detection
- [ ] Verify JSON validates against schema

#### 6. Documentation

- [ ] Update this spec's command matrix
- [ ] Add command to `docs/commands/` if user-facing
- [ ] Document exit codes in help text
- [ ] Document JSON output format in help text

### Code Template

```bash
#!/usr/bin/env bash
# <command>.sh - <description>
set -euo pipefail

# ============================================================================
# SETUP
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

# Source required libraries
source "${LIB_DIR}/exit-codes.sh"
source "${LIB_DIR}/error-json.sh"
source "${LIB_DIR}/output-format.sh"

# Load VERSION from central location
if [[ -n "${CLEO_HOME:-}" ]] && [[ -f "$CLEO_HOME/VERSION" ]]; then
    VERSION=$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')
elif [[ -f "${SCRIPT_DIR}/../VERSION" ]]; then
    VERSION=$(cat "${SCRIPT_DIR}/../VERSION" | tr -d '[:space:]')
else
    VERSION="0.0.0"
fi

# Command identification (for error reporting)
COMMAND_NAME="<command>"

# ============================================================================
# FLAG DEFAULTS
# ============================================================================

FORMAT=""        # Resolved after parsing
QUIET=false
VERBOSE=false
DRY_RUN=false

# ============================================================================
# HELP
# ============================================================================

# Show help message
show_help() {
    cat << 'EOF'
Usage: <command>.sh [OPTIONS] [ARGS]

Options:
  -f, --format FORMAT   Output format (text|json|jsonl|markdown|table)
  --json                Shortcut for --format json
  --human               Shortcut for --format text
  -q, --quiet           Suppress non-essential output
  -v, --verbose         Enable verbose output
  --dry-run             Preview changes without applying
  -h, --help            Show this help message
EOF
}

# ============================================================================
# ARGUMENT PARSING
# ============================================================================

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--format)  FORMAT="$2"; shift 2 ;;
    --json)       FORMAT="json"; shift ;;
    --human)      FORMAT="text"; shift ;;
    -q|--quiet)   QUIET=true; shift ;;
    -v|--verbose) VERBOSE=true; shift ;;
    --dry-run)    DRY_RUN=true; shift ;;
    -h|--help)    show_help; exit 0 ;;
    *)            # Handle positional args
                  shift ;;
  esac
done

# Resolve format (TTY-aware auto-detection)
FORMAT=$(resolve_format "$FORMAT")

# ============================================================================
# MAIN LOGIC
# ============================================================================

main() {
  # Your implementation here

  # Success output
  if [[ "$FORMAT" == "json" ]]; then
    jq -n \
      --arg version "$VERSION" \
      --arg cmd "$COMMAND_NAME" \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{
        "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $version,
          "command": $cmd,
          "timestamp": $ts
        },
        "success": true,
        "data": {}
      }'
  else
    [[ "$QUIET" != true ]] && echo "Success message"
  fi

  exit $EXIT_SUCCESS
}

# Error handling example
handle_error() {
  output_error "E_TASK_NOT_FOUND" "Task $1 not found" $EXIT_NOT_FOUND true \
    "Use 'ct list' to see available tasks"
  exit $EXIT_NOT_FOUND
}

main "$@"
```

---

## Part 11: Backward Compatibility Policy

### Breaking Change Policy

| Change Type | Policy | Deprecation Period |
|-------------|--------|-------------------|
| Exit code value changes | MUST NOT change within major version | 2 major versions |
| Error code string changes | MUST NOT change within major version | 2 major versions |
| JSON field removal | MUST NOT remove within major version | 2 major versions |
| Flag removal | MUST NOT remove within major version | 1 major version |
| JSON field rename | Add new, deprecate old | 2 major versions |
| Default behavior change | Document clearly, consider `--legacy` flag | 1 major version |

### Deprecation Process

1. **Announce**: Mark deprecated in next minor release
2. **Warn**: Emit deprecation warning to stderr (unless `--quiet`)
3. **Document**: Add to `CHANGELOG.md` deprecation section
4. **Sunset**: Remove after deprecation period

### Deprecation Registry

Maintain a deprecation registry in `docs/DEPRECATIONS.md` tracking:
- Deprecated item (exit code, error code, flag, field)
- Version deprecated
- Replacement (if any)
- Sunset version

This ensures API stability for LLM agents while allowing long-term evolution.

### JSON Stability Guarantees

| Field | Stability |
|-------|-----------|
| `$schema` | Stable (version in URL) |
| `_meta.version` | Stable |
| `_meta.command` | Stable |
| `_meta.timestamp` | Stable |
| `success` | Stable |
| `error.code` | Stable within major version |
| `error.exitCode` | Stable within major version |
| Command-specific fields | See individual command docs |

---

## Part 12: Compliance Validation Checklist

### Per-Command Checklist

Use this checklist to validate each command's compliance:

```markdown
## Command: <name>

### Foundation
- [ ] Sources `lib/exit-codes.sh`
- [ ] Sources `lib/error-json.sh`
- [ ] Sources `lib/output-format.sh`
- [ ] Sets `COMMAND_NAME` variable

### Flags
- [ ] Has `--format` flag
- [ ] Has `--quiet` flag
- [ ] Has `--json` shortcut
- [ ] Has `--human` shortcut
- [ ] Calls `resolve_format()` after arg parsing
- [ ] (Write commands) Has `--dry-run`

### JSON Output
- [ ] Includes `$schema` field
- [ ] Includes `_meta.format` field
- [ ] Includes `_meta.version` field
- [ ] Includes `_meta.command` field
- [ ] Includes `_meta.timestamp` field
- [ ] Includes `success` boolean
- [ ] (Task operations) Includes hierarchy fields

### Exit Codes
- [ ] Uses constants (no magic numbers)
- [ ] Returns 0 on success
- [ ] Returns correct code on each error type
- [ ] Documents exit codes in help

### Errors
- [ ] Uses `output_error()` for errors
- [ ] Uses correct `E_` error codes
- [ ] Includes suggestions where helpful

### Testing
- [ ] Has exit code tests
- [ ] Has JSON structure tests
- [ ] Has TTY detection tests
```

### Automated Compliance Check

A compliance check script **SHOULD** be created at `dev/check-compliance.sh`:

```bash
#!/usr/bin/env bash
# Check all commands for LLM-Agent-First compliance

PASS=0
FAIL=0

for script in scripts/*.sh; do
  cmd=$(basename "$script" .sh)

  # Check required sources
  grep -q "exit-codes.sh" "$script" || { echo "FAIL: $cmd missing exit-codes.sh"; ((FAIL++)); continue; }
  grep -q "error-json.sh" "$script" || { echo "FAIL: $cmd missing error-json.sh"; ((FAIL++)); continue; }
  grep -q "resolve_format" "$script" || { echo "FAIL: $cmd missing resolve_format"; ((FAIL++)); continue; }

  # Check flags
  grep -q "\-\-format" "$script" || { echo "WARN: $cmd missing --format flag"; }
  grep -q "\-\-quiet\|\-q" "$script" || { echo "WARN: $cmd missing --quiet flag"; }

  echo "PASS: $cmd"
  ((PASS++))
done

echo "Results: $PASS passed, $FAIL failed"
```

---

## Part 13: Files Reference

### Required Library Files

| File | Purpose |
|------|---------|
| `lib/exit-codes.sh` | Exit code constants (17 codes) |
| `lib/error-json.sh` | Error JSON output (29 error codes) |
| `lib/output-format.sh` | Format resolution with TTY detection |
| `lib/hierarchy.sh` | Hierarchy validation functions |

### Required Schema Files

| File | Purpose |
|------|---------|
| `schemas/todo.schema.json` | Task data schema |
| `schemas/archive.schema.json` | Archive data schema |
| `schemas/log.schema.json` | Audit log schema |
| `schemas/config.schema.json` | Configuration schema |
| `schemas/output.schema.json` | Success response envelope |
| `schemas/error.schema.json` | Error response envelope |
| `schemas/critical-path.schema.json` | Critical path analysis response |

### Reference Implementations

These commands exemplify best practices:

| File | Why Study It |
|------|--------------|
| `scripts/analyze.sh` | **Gold standard** - JSON default, `--human` flag |
| `scripts/exists.sh` | Perfect exit codes pattern |
| `scripts/list-tasks.sh` | Comprehensive JSON envelope |
| `scripts/validate.sh` | `--fix` and JSON patterns |

---

## Appendix A: Quick Reference Card

### Exit Code Quick Reference

```
0   SUCCESS              100 NO_DATA (not error)
1   GENERAL_ERROR        101 ALREADY_EXISTS (not error)
2   INVALID_INPUT        102 NO_CHANGE (not error)
3   FILE_ERROR
4   NOT_FOUND            10  PARENT_NOT_FOUND
5   DEPENDENCY_ERROR     11  DEPTH_EXCEEDED
6   VALIDATION_ERROR     12  SIBLING_LIMIT
7   LOCK_TIMEOUT         13  INVALID_PARENT_TYPE
8   CONFIG_ERROR         14  CIRCULAR_REFERENCE
                         15  ORPHAN_DETECTED
                         20  CHECKSUM_MISMATCH
                         21  CONCURRENT_MODIFICATION
                         22  ID_COLLISION
```

### Error Code Quick Reference

```
Task:       E_TASK_NOT_FOUND, E_TASK_ALREADY_EXISTS, E_TASK_INVALID_ID, E_TASK_INVALID_STATUS
File:       E_FILE_NOT_FOUND, E_FILE_READ_ERROR, E_FILE_WRITE_ERROR, E_FILE_PERMISSION
Validation: E_VALIDATION_SCHEMA, E_VALIDATION_CHECKSUM, E_VALIDATION_REQUIRED
Input:      E_INPUT_MISSING, E_INPUT_INVALID, E_INPUT_FORMAT
Hierarchy:  E_PARENT_NOT_FOUND, E_DEPTH_EXCEEDED, E_SIBLING_LIMIT, E_INVALID_PARENT_TYPE,
            E_CIRCULAR_REFERENCE, E_ORPHAN_DETECTED
Concurrency: E_CHECKSUM_MISMATCH, E_CONCURRENT_MODIFICATION, E_ID_COLLISION
Phase:      E_PHASE_NOT_FOUND, E_PHASE_INVALID
Session:    E_SESSION_ACTIVE, E_SESSION_NOT_ACTIVE
General:    E_UNKNOWN, E_NOT_INITIALIZED, E_DEPENDENCY_MISSING, E_DEPENDENCY_VERSION
```

### JSON Envelope Quick Reference

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {"format": "json", "version": "0.17.0", "command": "add", "timestamp": "2025-12-17T12:00:00Z"},
  "success": true,
  "task": {"id": "T001", "type": "task", "parentId": null, "size": null, ...}
}
```

---

*Specification v3.0 - Authoritative Standard for LLM-Agent-First CLI Design*
*Applicable to: cleo and any LLM-agent-first CLI project*
*Last updated: 2025-12-18*
