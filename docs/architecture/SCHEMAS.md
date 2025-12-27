# Schema Reference

Complete technical reference for CLAUDE-TODO JSON schemas with validation rules, field definitions, and anti-hallucination safeguards.

---

## Overview

The CLAUDE-TODO system uses four JSON schemas with strict validation:

- **todo.schema.json** - Active task tracking with session state
- **archive.schema.json** - Immutable completed task storage
- **config.schema.json** - System configuration and policies
- **log.schema.json** - Immutable audit trail

All schemas use JSON Schema Draft-07 with strict `additionalProperties: false` to prevent hallucinated fields.

---

## Task Schema (todo.schema.json)

**Schema ID**: `cleo-schema-v2.2`
**Current Version**: `2.2.0`

### Root Object

Required properties:
- `version` (string) - Schema version in semver format (pattern: `^\d+\.\d+\.\d+$`)
- `project` (object) - Project configuration with phase tracking (v2.2.0+)
- `lastUpdated` (string) - ISO 8601 timestamp of last modification
- `tasks` (array) - Flat array of all active tasks
- `_meta` (object) - System metadata for integrity verification

Optional properties:
- `focus` (object) - Session continuity state
- `labels` (object) - Computed label-to-task-ID index

### Project Object (v2.2.0+)

The `project` field is now an object containing project metadata and phase definitions.

Required properties:
- `name` (string) - Project identifier (minLength: 1)
- `phases` (object) - Phase definitions keyed by slug

Optional properties:
- `currentPhase` (string or null) - Active phase slug (pattern: `^[a-z][a-z0-9-]*$`)
- `phaseHistory` (array) - Chronological phase transition log for audit trail

Example:
```json
{
  "project": {
    "name": "my-project",
    "currentPhase": "core",
    "phases": {
      "setup": { "order": 1, "name": "Setup", "status": "completed" },
      "core": { "order": 2, "name": "Core Dev", "status": "active" },
      "polish": { "order": 3, "name": "Polish", "status": "pending" }
    }
  }
}
```

### Phase Definition Object

Each phase in `project.phases` has the following structure:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `order` | integer | **Yes** | Display order (minimum: 1) |
| `name` | string | **Yes** | Human-readable name (max 50 chars) |
| `description` | string | No | Phase description (max 200 chars) |
| `status` | string | **Yes** | Phase status (see below) |
| `startedAt` | string or null | No | When phase was activated (ISO 8601) |
| `completedAt` | string or null | No | When phase was completed (ISO 8601) |

**Phase Status Values**:
- `pending` - Phase not yet started
- `active` - Currently working on this phase (only ONE phase can be active)
- `completed` - Phase work finished

### Phase History Entry Object

Each entry in `project.phaseHistory` tracks a phase transition:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `phase` | string | **Yes** | Phase slug (pattern: `^[a-z][a-z0-9-]*$`) |
| `transitionType` | string | **Yes** | `started`, `completed`, or `rollback` |
| `timestamp` | string | **Yes** | When transition occurred (ISO 8601) |
| `taskCount` | integer | **Yes** | Tasks in phase at transition time (min: 0) |
| `fromPhase` | string or null | No | Previous phase (required for rollback) |
| `reason` | string | No | Context for transition (max 500 chars) |

**Transition Types**:
- `started` - Phase became active
- `completed` - Phase work finished
- `rollback` - Reverted to earlier phase (requires `fromPhase`)

Example:
```json
{
  "phaseHistory": [
    {
      "phase": "setup",
      "transitionType": "completed",
      "timestamp": "2025-12-05T18:30:00Z",
      "taskCount": 14
    },
    {
      "phase": "core",
      "transitionType": "started",
      "timestamp": "2025-12-05T18:30:00Z",
      "taskCount": 63,
      "fromPhase": "setup",
      "reason": "Phase started via 'phase advance' from setup"
    }
  ]
}
```

### Task Object Definition

**Location**: `#/definitions/task`

#### Required Fields

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| `id` | string | Unique stable identifier | Pattern: `^T\d{3,}$` (T001, T002...) |
| `title` | string | Actionable task title | 1-120 chars, start with verb |
| `status` | string | Current task state | Enum: pending, active, blocked, done |
| `priority` | string | Task priority level | Enum: critical, high, medium, low |
| `createdAt` | string | Creation timestamp | ISO 8601 date-time format |

#### Optional Fields

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| `phase` | string | Phase slug | Pattern: `^[a-z][a-z0-9-]*$` |
| `description` | string | Detailed requirements | Max 2000 chars |
| `files` | array[string] | Files to create/modify | Relative paths from project root |
| `acceptance` | array[string] | Testable completion criteria | Min 1 item, max 200 chars each |
| `depends` | array[string] | Task IDs that must be done first | Pattern: `^T\d{3,}$`, unique items |
| `blockedBy` | string | Blocker reason | Max 300 chars, **REQUIRED if status=blocked** |
| `notes` | array[string] | Append-only implementation log | Max 5000 chars each |
| `labels` | array[string] | Tags for filtering | Pattern: `^[a-z][a-z0-9.-]*$` (supports version tags like v0.6.0), unique items |
| `completedAt` | string | Completion timestamp | ISO 8601, **REQUIRED if status=done** |

#### Status Values

| Status | Meaning | Rules |
|--------|---------|-------|
| `pending` | Ready to start | Can be activated when dependencies met |
| `active` | Currently working | **ONLY ONE task can be active** |
| `blocked` | Stuck on external dependency | Requires `blockedBy` field |
| `done` | Completed successfully | Requires `completedAt` timestamp |

#### Priority Values

Ordered from highest to lowest:
1. `critical` - Urgent, blocking other work
2. `high` - Important, should be done soon
3. `medium` - Normal priority (default)
4. `low` - Can be deferred

#### Conditional Requirements

**If status = "blocked":**
```json
{
  "status": "blocked",
  "blockedBy": "Waiting for API keys from DevOps"  // REQUIRED
}
```

**If status = "done":**
```json
{
  "status": "done",
  "completedAt": "2025-12-05T14:30:00Z"  // REQUIRED
}
```

### Metadata Object (_meta)

**Critical for anti-hallucination**. Required fields:

| Field | Type | Description |
|-------|------|-------------|
| `checksum` | string | SHA-256 truncated hash of tasks array (pattern: `^[a-f0-9]{16}$`) |
| `configVersion` | string | Version of config.json used |
| `lastSessionId` | string or null | Session ID that last modified this file |
| `activeSession` | string or null | Currently active session (null if none) |

**Checksum Verification**: MUST verify checksum before ANY write operation to detect concurrent modifications.

### Focus Object

**Critical for LLM session continuity**. All fields optional:

| Field | Type | Description |
|-------|------|-------------|
| `currentTask` | string or null | Task ID with status=active (pattern: `^T\d{3,}$`) |
| `blockedUntil` | string or null | Global blocker if entire project stuck |
| `sessionNote` | string or null | Context from last session (max 1000 chars) |
| `nextAction` | string or null | Specific next step when resuming (max 500 chars) |

### Focus Object - Phase Tracking

The focus object includes phase-aware tracking (v2.2.0+):

| Field | Type | Description |
|-------|------|-------------|
| `currentTask` | string or null | Task ID with status=active (pattern: `^T\d{3,}$`) |
| `currentPhase` | string or null | Synced with `project.currentPhase` |
| `blockedUntil` | string or null | Global blocker if entire project stuck |
| `sessionNote` | string or null | Context from last session (max 1000 chars) |
| `nextAction` | string or null | Specific next step when resuming (max 500 chars) |

**Phase Synchronization**: When `project.currentPhase` changes, `focus.currentPhase` is automatically updated to match.

### Labels Object

**Computed index** - derived from `task.labels`. Regenerate if stale.

**Pattern**: `^[a-z][a-z0-9.-]*$` → array of task IDs (supports version tags like v0.6.0)

Example:
```json
{
  "labels": {
    "bug": ["T001", "T005", "T012"],
    "security": ["T003", "T008"],
    "v0.6.0": ["T002", "T004", "T007"]
  }
}
```

---

## Archive Schema (archive.schema.json)

**Schema ID**: `cleo-archive-schema-v2.2`

### Root Object

Required properties:
- `version` (string) - Must match todo.json version
- `project` (string) - Must match todo.json project
- `archivedTasks` (array) - Completed tasks (IMMUTABLE after archival)
- `_meta` (object) - Archive metadata

Optional properties:
- `statistics` (object) - Computed statistics

### Archived Task Object

**Location**: `#/definitions/archivedTask`

All original task fields PLUS:

#### Archive Metadata (_archive)

Fields added during archival:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `archivedAt` | string | **Yes** | When task was archived (ISO 8601) |
| `reason` | string | **Yes** | Enum: auto, manual, stale |
| `sessionId` | string | No | Session that performed archival |
| `cycleTimeDays` | number | No | Days from creation to completion |

**Archive Reason Values**:
- `auto` - Triggered by config rules (daysUntilArchive)
- `manual` - User-initiated archival
- `stale` - Exceeded retention policy

#### Constraints

- `status` MUST be "done" (const validation)
- `completedAt` MUST be present
- All archived tasks are **IMMUTABLE** - never modify after archival

### Archive Metadata (_meta)

Required fields:

| Field | Type | Description |
|-------|------|-------------|
| `totalArchived` | integer | Total count of archived tasks (minimum: 0) |
| `lastArchived` | string or null | Most recent archival timestamp |
| `oldestTask` | string or null | Completion date of oldest archived task |
| `newestTask` | string or null | Completion date of newest archived task |

### Statistics Object

Computed during archive operations:

| Field | Type | Description |
|-------|------|-------------|
| `byPhase` | object | Task counts by phase slug |
| `byPriority` | object | Counts for critical/high/medium/low |
| `byLabel` | object | Task counts by label |
| `averageCycleTime` | number or null | Average days from creation to completion |

---

## Config Schema (config.schema.json)

**Schema ID**: `cleo-config-schema-v2.2`

### Root Object

Required: `version` (string, semver pattern)

All other properties optional with documented defaults.

### Archive Settings (archive)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | true | Enable automatic archiving |
| `daysUntilArchive` | integer | 7 | Days after completion before eligible (1-365) |
| `maxCompletedTasks` | integer | 15 | Max completed tasks before trigger (1-100) |
| `preserveRecentCount` | integer | 3 | Always keep N recent completed tasks (0-20) |
| `archiveOnSessionEnd` | boolean | true | Run archive check at session end |
| `autoArchiveOnComplete` | boolean | false | Archive immediately when task completed |

### Logging Settings (logging)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | true | Enable logging to todo-log.json |
| `retentionDays` | integer | 30 | Days to retain log entries (1-365) |
| `level` | string | standard | Enum: minimal, standard, verbose |
| `logSessionEvents` | boolean | true | Log session start/end |

**Log Levels**:
- `minimal` - Status changes only
- `standard` - Status changes + notes
- `verbose` - All field changes

### Validation Settings (validation)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strictMode` | boolean | false | Treat warnings as errors |
| `checksumEnabled` | boolean | true | **CRITICAL for anti-hallucination** |
| `enforceAcceptance` | boolean | true | Require acceptance criteria for high/critical |
| `requireDescription` | boolean | false | Require description for all tasks |
| `maxActiveTasks` | integer | 1 | Maximum active tasks (1-1, **DO NOT CHANGE**) |
| `validateDependencies` | boolean | true | Check all depends[] references exist |
| `detectCircularDeps` | boolean | true | Detect and block circular dependencies |

### Phase Validation Configuration (validation.phaseValidation)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enforcePhaseOrder` | boolean | false | Warn when activating tasks outside current project phase |
| `phaseAdvanceThreshold` | integer | 90 | Percentage of tasks that must be completed to advance phase (0-100) |
| `blockOnCriticalTasks` | boolean | true | Prevent phase advancement if critical tasks remain incomplete |
| `warnPhaseContext` | boolean | true | Show warning when task phase differs from project phase |

### Default Settings (defaults)

Default values for new tasks:

| Field | Type | Default |
|-------|------|---------|
| `priority` | string | medium |
| `phase` | string | core |
| `labels` | array | [] |

### Session Settings (session)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `requireSessionNote` | boolean | true | Warn if session ends without sessionNote |
| `warnOnNoFocus` | boolean | true | Warn if no task active at start |
| `autoStartSession` | boolean | true | Auto-log session_start on first read |
| `sessionTimeoutHours` | integer | 24 | Hours before orphaned session warning (1-72) |

### Display Settings (display)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `showArchiveCount` | boolean | true | Show archived task count |
| `showLogSummary` | boolean | true | Show recent log summary |
| `warnStaleDays` | integer | 30 | Warn about tasks pending longer than N days |

### CLI Configuration (cli)

**Version**: Added in v0.6.0

Command-line interface behavior, aliases, plugin system, and debug settings.

#### Aliases (cli.aliases)

Command aliases for faster workflows. Maps short names to full command names.

**Default Aliases**:

| Alias | Maps To | Description |
|-------|---------|-------------|
| `ls` | `list` | List tasks |
| `done` | `complete` | Complete task |
| `new` | `add` | Add task |
| `edit` | `update` | Update task |
| `rm` | `archive` | Archive tasks |
| `check` | `validate` | Validate files |

**Custom Aliases**: Additional aliases can be added via `additionalProperties`. Each alias must map to a valid command name (string value).

**Example**:
```json
{
  "cli": {
    "aliases": {
      "ls": "list",
      "s": "stats",
      "f": "focus"
    }
  }
}
```

#### Plugins (cli.plugins)

Plugin system configuration for extending CLI with custom commands.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | true | Enable plugin discovery and loading |
| `directories` | array[string] | `["~/.cleo/plugins", "./.cleo/plugins"]` | Directories to scan for plugins (in priority order) |
| `autoDiscover` | boolean | true | Auto-discover plugins from configured directories |

**Plugin Discovery**:
- Plugins are executable scripts (`.sh`, `.py`, etc.) with `###PLUGIN` marker
- Search order: project-local (`./.cleo/plugins`) then global (`~/.cleo/plugins`)
- Plugin name derived from filename (e.g., `my-report.sh` → `cleo my-report`)

#### Debug (cli.debug)

Debug and validation settings for CLI operations.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | false | Enable debug mode (verbose output, validation checks) |
| `validateMappings` | boolean | true | Validate command-to-script mappings exist |
| `checksumVerify` | boolean | true | Verify script checksums for integrity |
| `showTimings` | boolean | false | Show command execution timings |

**Debug Mode Triggers**:
- `cli.debug.enabled: true` in config
- `CLEO_DEBUG=1` environment variable
- `--debug` CLI flag (if implemented)

---

## Log Schema (log.schema.json)

**Schema ID**: `cleo-log-schema-v2.2`

### Root Object

Required properties:
- `version` (string) - Schema version
- `project` (string) - Must match todo.json
- `entries` (array) - Log entries in chronological order (append-only)
- `_meta` (object) - Log metadata

### Log Entry Object

**Location**: `#/definitions/logEntry`

#### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique log entry ID (pattern: `^log_[a-f0-9]{12}$`) |
| `timestamp` | string | When action occurred (ISO 8601) |
| `action` | string | Type of action (see Action Types below) |
| `actor` | string | Enum: human, claude, system |

#### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string or null | Session that performed action |
| `taskId` | string or null | Related task ID (pattern: `^T\d{3,}$`) |
| `before` | object or null | State before action |
| `after` | object or null | State after action |
| `details` | object/string/null | Additional context |
| `error` | object or null | Error details if action failed |

#### Action Types

```
session_start      - Session initiated
session_end        - Session completed
task_created       - New task added
task_updated       - Task fields modified
status_changed     - Task status transition
task_archived      - Task moved to archive
focus_changed      - currentTask or sessionNote updated
config_changed     - Configuration modified
validation_run     - Validation check performed
checksum_updated   - Checksum recalculated
error_occurred     - Error logged for debugging
phase_changed      - Project phase changed (v2.2.0+)
phase_started      - Phase transitioned to active (v2.2.0+)
phase_completed    - Phase marked as completed (v2.2.0+)
```

#### Actor Types

- `human` - Direct user action (manual CLI usage)
- `claude` - LLM agent action
- `system` - Automated system action (archival, validation)

#### Error Object Structure

When `error` is present:
```json
{
  "error": {
    "code": "CHECKSUM_MISMATCH",
    "message": "Expected abc123... but got def456...",
    "recoverable": false
  }
}
```

### Log Metadata (_meta)

Required fields:

| Field | Type | Description |
|-------|------|-------------|
| `formatVersion` | string | Log entry format version for future compatibility (pattern: `^\d+$`, default: "1") |
| `totalEntries` | integer | Total log entry count (minimum: 0) |
| `firstEntry` | string or null | Timestamp of oldest entry |
| `lastEntry` | string or null | Timestamp of newest entry |
| `entriesPruned` | integer | Count of entries removed by retention policy (default: 0) |

**Format Version**: Increment when log entry structure changes to enable backward-compatible parsing.

---

## Anti-Hallucination Safeguards

### ID Uniqueness Requirements

**Task IDs**:
- Pattern: `^T\d{3,}$` (T001, T002, T003...)
- NEVER reuse IDs - even for archived tasks
- NEVER change ID after creation
- New IDs MUST be highest existing ID + 1
- Validate uniqueness across todo.json AND archive.json

**Log Entry IDs**:
- Pattern: `^log_[a-f0-9]{12}$`
- Must be globally unique
- Generate with cryptographic randomness

**Session IDs**:
- Format: `session_YYYYMMDD_HHMMSS_<random>`
- Must be globally unique per session

### Timestamp Sanity Checks

**Creation Timestamps**:
- `createdAt` MUST be ≤ current time
- `createdAt` MUST be ≥ `2024-01-01T00:00:00Z` (system inception)

**Completion Timestamps**:
- `completedAt` MUST be ≥ `createdAt`
- `completedAt` MUST be ≤ current time
- Cannot complete task before it was created

**Archive Timestamps**:
- `archivedAt` MUST be ≥ `completedAt`
- Cannot archive before completion

**Modification Timestamps**:
- `lastUpdated` MUST be ≥ most recent task `createdAt` or `completedAt`
- `lastUpdated` MUST be ≤ current time

### Cross-File Integrity

**Project Consistency**:
- `project` field MUST match across todo.json, archive.json, log.json
- Detect mismatched project identifiers as corruption

**Version Consistency**:
- All files should use same schema version
- Warn on version skew (e.g., todo.json v2.1, archive.json v2.0)

**Checksum Verification**:
1. Read current `_meta.checksum` from todo.json
2. Compute SHA-256 hash of `tasks` array
3. Truncate to first 16 hex chars
4. Compare with stored checksum
5. If mismatch: **ABORT operation**, log error, alert user

**Dependency Validation**:
- All task IDs in `depends[]` MUST exist in todo.json
- Cannot depend on archived tasks
- Cannot depend on self (task.id ≠ depends[i])
- Detect circular dependencies (A→B→C→A)

**Focus Validation**:
- If `focus.currentTask` is set, that task MUST have status='active'
- If any task has status='active', `focus.currentTask` MUST be set
- Only ONE task can have status='active'

### Schema Validation

**Required Patterns**:
- Task IDs: `^T\d{3,}$`
- Phase slugs: `^[a-z][a-z0-9-]*$`
- Labels: `^[a-z][a-z0-9.-]*$` (supports version tags like v0.6.0)
- Version: `^\d+\.\d+\.\d+$`
- Checksum: `^[a-f0-9]{16}$`

**Field Length Limits**:
- `title`: 1-120 chars
- `description`: 0-2000 chars
- `blockedBy`: 0-300 chars
- `notes[i]`: 0-500 chars
- `acceptance[i]`: 0-200 chars
- `sessionNote`: 0-1000 chars
- `nextAction`: 0-500 chars

**Enum Validation**:
- `status`: Must be exactly one of: pending, active, blocked, done
- `priority`: Must be exactly one of: critical, high, medium, low
- `actor`: Must be exactly one of: human, claude, system

---

## Complete Examples

### Valid Task Examples

#### Minimal Task (New)
```json
{
  "id": "T001",
  "title": "Implement user authentication",
  "status": "pending",
  "priority": "high",
  "createdAt": "2025-12-05T10:00:00Z"
}
```

#### Task with Dependencies
```json
{
  "id": "T003",
  "title": "Add password reset flow",
  "status": "pending",
  "priority": "medium",
  "phase": "auth",
  "description": "Email-based password reset with secure token generation",
  "depends": ["T001", "T002"],
  "acceptance": [
    "User receives password reset email within 2 minutes",
    "Reset token expires after 1 hour",
    "Password successfully updated and user can login"
  ],
  "labels": ["feature", "security"],
  "createdAt": "2025-12-05T10:30:00Z"
}
```

#### Active Task with Notes
```json
{
  "id": "T002",
  "title": "Configure email service integration",
  "status": "active",
  "priority": "high",
  "phase": "infrastructure",
  "description": "Integrate SendGrid for transactional emails",
  "files": [
    "src/services/email.ts",
    "config/email.config.ts"
  ],
  "notes": [
    "2025-12-05T11:00:00Z - Started SendGrid API integration",
    "2025-12-05T11:30:00Z - Added email template system",
    "2025-12-05T12:00:00Z - Testing with sandbox account"
  ],
  "labels": ["infrastructure", "integration"],
  "createdAt": "2025-12-05T10:15:00Z"
}
```

#### Blocked Task
```json
{
  "id": "T005",
  "title": "Deploy to production environment",
  "status": "blocked",
  "priority": "critical",
  "blockedBy": "Waiting for DevOps to provision production database and provide connection string",
  "depends": ["T001", "T002", "T003"],
  "createdAt": "2025-12-05T09:00:00Z"
}
```

#### Completed Task
```json
{
  "id": "T001",
  "title": "Implement JWT token generation",
  "status": "done",
  "priority": "high",
  "phase": "auth",
  "description": "Generate secure JWT tokens for authenticated users",
  "files": [
    "src/auth/jwt.ts",
    "tests/auth/jwt.test.ts"
  ],
  "acceptance": [
    "JWT tokens include user ID and expiration",
    "Tokens expire after 24 hours",
    "Unit tests pass with 100% coverage"
  ],
  "notes": [
    "2025-12-04T14:00:00Z - Implemented token generation with jsonwebtoken library",
    "2025-12-04T15:30:00Z - Added comprehensive test suite",
    "2025-12-04T16:00:00Z - All acceptance criteria verified"
  ],
  "labels": ["feature", "security"],
  "createdAt": "2025-12-04T13:00:00Z",
  "completedAt": "2025-12-04T16:00:00Z"
}
```

### Invalid Task Examples

#### ❌ Missing Required Field
```json
{
  "id": "T001",
  "title": "Fix bug in login",
  "status": "pending",
  "priority": "high"
  // Missing: createdAt
}
```
**Error**: Required field `createdAt` is missing

#### ❌ Invalid Status Value
```json
{
  "id": "T001",
  "title": "Implement feature",
  "status": "in_progress",  // ❌ Wrong! Should be "active"
  "priority": "medium",
  "createdAt": "2025-12-05T10:00:00Z"
}
```
**Error**: Status must be one of: pending, active, blocked, done

#### ❌ Blocked Without Reason
```json
{
  "id": "T001",
  "title": "Deploy to staging",
  "status": "blocked",
  "priority": "high",
  "createdAt": "2025-12-05T10:00:00Z"
  // Missing: blockedBy (required when status=blocked)
}
```
**Error**: Conditional validation failed - `blockedBy` required when status is "blocked"

#### ❌ Done Without Timestamp
```json
{
  "id": "T001",
  "title": "Write documentation",
  "status": "done",
  "priority": "medium",
  "createdAt": "2025-12-05T10:00:00Z"
  // Missing: completedAt (required when status=done)
}
```
**Error**: Conditional validation failed - `completedAt` required when status is "done"

#### ❌ Invalid ID Format
```json
{
  "id": "task-001",  // ❌ Wrong! Should be "T001"
  "title": "Fix bug",
  "status": "pending",
  "priority": "low",
  "createdAt": "2025-12-05T10:00:00Z"
}
```
**Error**: ID must match pattern `^T\d{3,}$`

#### ❌ Invalid Timestamp Order
```json
{
  "id": "T001",
  "title": "Complete task",
  "status": "done",
  "priority": "medium",
  "createdAt": "2025-12-05T15:00:00Z",
  "completedAt": "2025-12-05T10:00:00Z"  // ❌ Before createdAt!
}
```
**Error**: completedAt (10:00) cannot be before createdAt (15:00)

#### ❌ Hallucinated Field
```json
{
  "id": "T001",
  "title": "Implement feature",
  "status": "pending",
  "priority": "medium",
  "content": "This is the task content",  // ❌ No such field!
  "createdAt": "2025-12-05T10:00:00Z"
}
```
**Error**: Additional property `content` not allowed (should be `description`)

#### ❌ Invalid Dependency Reference
```json
{
  "id": "T003",
  "title": "Build feature",
  "status": "pending",
  "priority": "high",
  "depends": ["T001", "T999"],  // ❌ T999 doesn't exist!
  "createdAt": "2025-12-05T10:00:00Z"
}
```
**Error**: Dependency validation failed - task T999 does not exist

---

## Validation Tools

### Manual Validation

Use `ajv-cli` to validate JSON files:

```bash
# Validate todo.json
ajv validate -s schemas/todo.schema.json -d todo.json --strict

# Validate archive.json
ajv validate -s schemas/archive.schema.json -d archive.json --strict

# Validate config
ajv validate -s schemas/config.schema.json -d config.json --strict

# Validate log
ajv validate -s schemas/log.schema.json -d todo-log.json --strict
```

### Pre-Commit Validation

Add to `.git/hooks/pre-commit`:

```bash
#!/bin/bash
ajv validate -s schemas/todo.schema.json -d todo.json --strict || exit 1
ajv validate -s schemas/archive.schema.json -d archive.json --strict || exit 1
echo "✅ Schema validation passed"
```

### Integration Testing

Test scripts should validate:
1. Schema compliance (ajv)
2. ID uniqueness (cross-file)
3. Timestamp sanity checks
4. Checksum verification
5. Dependency graph validation
6. Focus state consistency

---

## Schema Evolution

### Version Compatibility

**Major version change (3.0.0)**:
- Breaking schema changes
- Requires migration script
- Incompatible with older versions

**Minor version change (2.2.0)**:
- New optional fields
- Backward compatible
- Old files remain valid

**Patch version change (2.1.1)**:
- Documentation fixes
- No schema changes
- Fully compatible

### Migration Strategy

When schema changes:
1. Update version in schema file
2. Document changes in CHANGELOG.md
3. Create migration script if needed
4. Update validation rules
5. Test with existing files
6. Update this reference document

---

## Common Pitfalls

### Field Name Confusion

| ❌ Wrong | ✅ Correct |
|----------|------------|
| `content` | `description` |
| `state` | `status` |
| `in_progress` | `active` |
| `name` | `title` |
| `taskId` | `id` |

### Status Confusion

| ❌ Wrong | ✅ Correct |
|----------|------------|
| `todo` | `pending` |
| `in_progress` | `active` |
| `waiting` | `blocked` |
| `completed` | `done` |
| `finished` | `done` |

### Timestamp Mistakes

- Using `Date.now()` instead of ISO 8601 string
- Forgetting timezone (use UTC: `2025-12-05T10:00:00Z`)
- Setting timestamps in the future
- Completing tasks before they were created

### ID Generation Errors

- Reusing archived task IDs
- Starting from T001 when existing tasks exist
- Using wrong format (task-001 vs T001)
- Generating non-sequential IDs (T001, T003, T002)

---

## References

- **JSON Schema Draft-07**: https://json-schema.org/draft-07/schema
- **ISO 8601 Timestamps**: https://en.wikipedia.org/wiki/ISO_8601
- **Semantic Versioning**: https://semver.org/
- **SHA-256 Hashing**: https://en.wikipedia.org/wiki/SHA-2

---

**Last Updated**: 2025-12-16
**Schema Version**: 2.2.0
