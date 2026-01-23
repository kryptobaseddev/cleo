# CLEO Task Schema v2.8.0 Reference

**Schema Version**: 2.8.0
**Spec Version**: 3.1.0
**Schema Location**: `schemas/todo.schema.json`

## Overview

The CLEO Task Schema defines the structure for `todo.json`, the primary data file for task management. This document provides a complete reference for all fields in schema version 2.8.0.

## Top-Level Structure

```json
{
  "version": "2.8.0",
  "project": { ... },
  "lastUpdated": "2026-01-23T10:00:00Z",
  "_meta": { ... },
  "focus": { ... },
  "tasks": [ ... ],
  "labels": { ... }
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Legacy schema version (use `_meta.schemaVersion`) |
| `project` | object | Project configuration and phases |
| `lastUpdated` | date-time | Last modification timestamp |
| `tasks` | array | All active tasks |
| `_meta` | object | System metadata for integrity |

---

## Project Object

The `project` object contains project-level configuration, phase definitions, and release tracking.

```json
{
  "project": {
    "name": "my-project",
    "currentPhase": "core",
    "phases": { ... },
    "phaseHistory": [ ... ],
    "releases": [ ... ]
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Project identifier (min 1 char) |
| `currentPhase` | string/null | No | Slug of active phase |
| `phases` | object | Yes | Phase definitions |
| `phaseHistory` | array | No | Chronological phase transitions |
| `releases` | array | No | Release tracking (v2.8.0+) |

### releases Array (v2.8.0+)

Roadmap management with version, status, and task associations.

```json
{
  "releases": [
    {
      "version": "v0.65.0",
      "status": "active",
      "targetDate": "2026-02-01",
      "releasedAt": null,
      "tasks": ["T050", "T051"],
      "notes": "Feature release with new API"
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | Yes | Semantic version (e.g., `v0.65.0`) |
| `status` | enum | Yes | `planned`, `active`, `released` |
| `targetDate` | date/null | No | Planned release date (YYYY-MM-DD) |
| `releasedAt` | date-time/null | No | Actual release timestamp |
| `tasks` | array | No | Task IDs in this release |
| `notes` | string/null | No | Release notes (max 5000 chars) |

---

## _meta Object

System metadata for integrity verification and session tracking.

```json
{
  "_meta": {
    "schemaVersion": "2.8.0",
    "specVersion": "3.1.0",
    "checksum": "a1b2c3d4e5f67890",
    "configVersion": "2.4.0",
    "lastSessionId": "session_20260123_100000_abc123",
    "multiSessionEnabled": true,
    "activeSessionCount": 2
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | string | Yes | Canonical schema version |
| `specVersion` | string | No | LLM-Agent-First spec version |
| `checksum` | string | Yes | SHA-256 truncated hash of tasks |
| `configVersion` | string | Yes | Config schema version |
| `lastSessionId` | string/null | No | Last modifying session |
| `activeSession` | string/null | No | Current session (single-session mode) |
| `multiSessionEnabled` | boolean | No | Multi-session mode active |
| `activeSessionCount` | integer | No | Active session count |
| `sessionsFile` | string/null | No | Path to sessions registry |

---

## Focus Object

Session continuity state for LLM agents to resume work correctly.

```json
{
  "focus": {
    "currentTask": "T050",
    "currentPhase": "core",
    "blockedUntil": null,
    "sessionNote": "Working on API endpoints",
    "sessionNotes": [ ... ],
    "nextAction": "Add validation to auth.ts:45",
    "primarySession": "session_20260123_100000_abc123"
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `currentTask` | string/null | Active task ID (single-session) |
| `currentPhase` | string/null | Phase of current task |
| `blockedUntil` | string/null | Global blocker description |
| `sessionNote` | string/null | Current session context (deprecated) |
| `sessionNotes` | array | Append-only session notes (v2.8.0+) |
| `nextAction` | string/null | Specific next step |
| `primarySession` | string/null | Default session for CLI |

### sessionNotes Array (v2.8.0+)

Append-only session notes preserving conversation context.

```json
{
  "sessionNotes": [
    {
      "note": "Completed authentication module",
      "timestamp": "2026-01-23T10:00:00Z",
      "conversationId": "conv_abc123",
      "agent": "opus-1"
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `note` | string | Yes | Session progress note |
| `timestamp` | date-time | Yes | When note was added |
| `conversationId` | string/null | No | Claude conversation ID |
| `agent` | string/null | No | Agent identifier |

**Constraints**: Maximum 50 items.

---

## Task Object

Individual task definition with all supported fields.

### Required Fields

| Field | Type | Pattern | Description |
|-------|------|---------|-------------|
| `id` | string | `^T\d{3,}$` | Unique stable ID (never reuse) |
| `title` | string | - | Actionable title (1-120 chars) |
| `status` | enum | - | `pending`, `active`, `blocked`, `done`, `cancelled` |
| `priority` | enum | - | `critical`, `high`, `medium`, `low` |
| `createdAt` | date-time | - | Creation timestamp |

### Hierarchy Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | enum | `task` | `epic`, `task`, `subtask` |
| `parentId` | string/null | `null` | Parent task ID |
| `position` | integer/null | `null` | Display order (1-indexed) |
| `positionVersion` | integer | `0` | Optimistic locking version |
| `size` | enum/null | `null` | `small`, `medium`, `large` |

### Content Fields

| Field | Type | Max Length | Description |
|-------|------|------------|-------------|
| `description` | string | 2000 | Detailed requirements |
| `phase` | string | - | Phase slug |
| `files` | array | - | Files to create/modify |
| `acceptance` | array | 200/item | Testable completion criteria |
| `depends` | array | - | Blocking dependency task IDs |
| `labels` | array | - | Tags for filtering |
| `notes` | array | 5000/item | Append-only implementation log |
| `blockedBy` | string | 300 | Blocker reason (required when blocked) |

### Metadata Fields (v2.8.0+)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `updatedAt` | date-time/null | `null` | Last modification timestamp |
| `origin` | enum/null | `null` | Task provenance classification |
| `relates` | array | `[]` | Non-blocking relationships |

#### origin Values

| Value | Description |
|-------|-------------|
| `internal` | Internally identified improvement |
| `bug-report` | From user bug report |
| `feature-request` | User feature request |
| `security` | Security vulnerability |
| `technical-debt` | Technical debt paydown |
| `dependency` | Dependency update required |
| `regression` | Fix for broken behavior |

#### relates Array

```json
{
  "relates": [
    {
      "taskId": "T001",
      "type": "spawned-from",
      "reason": "Extracted from parent epic"
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | string | Yes | Related task ID |
| `type` | enum | Yes | Relationship type |
| `reason` | string | No | Explanation (max 200 chars) |

**Relationship Types**:
- `relates-to`: General relationship
- `spawned-from`: Derived from another task
- `deferred-to`: Postponed to future task
- `supersedes`: Replaces another task
- `duplicates`: Same as another task

### Status Timestamps

| Field | Type | Required When |
|-------|------|---------------|
| `completedAt` | date-time | `status = done` |
| `cancelledAt` | date-time | `status = cancelled` |
| `cancellationReason` | string | `status = cancelled` |

### Epic-Specific Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `epicLifecycle` | enum/null | `null` | `backlog`, `planning`, `active`, `review`, `released`, `archived` |
| `noAutoComplete` | boolean/null | `null` | Prevent auto-complete when children done |

### Verification Fields

```json
{
  "verification": {
    "passed": false,
    "round": 1,
    "gates": {
      "implemented": true,
      "testsPassed": null,
      "qaPassed": null,
      "securityPassed": null,
      "documented": null
    },
    "lastAgent": "coder",
    "lastUpdated": "2026-01-23T10:00:00Z",
    "failureLog": []
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `passed` | boolean | Overall verification status |
| `round` | integer | Current implementation round |
| `gates` | object | Individual gate statuses |
| `lastAgent` | enum/null | Last agent to work on task |
| `lastUpdated` | date-time/null | Last verification update |
| `failureLog` | array | Log of verification failures |

**Gate Types**: `implemented`, `testsPassed`, `qaPassed`, `cleanupDone`, `securityPassed`, `documented`

**Agent Types**: `planner`, `coder`, `testing`, `qa`, `cleanup`, `security`, `docs`

---

## Labels Index

Computed label-to-task-ID index (derived from task labels).

```json
{
  "labels": {
    "bug": ["T001", "T005"],
    "feature": ["T002", "T003"],
    "v0.65.0": ["T050", "T051"]
  }
}
```

---

## Validation Rules

### Conditional Requirements

| Condition | Required Fields |
|-----------|-----------------|
| `status = blocked` | `blockedBy` |
| `status = done` | `completedAt` |
| `status = cancelled` | `cancelledAt`, `cancellationReason` |

### Constraints

| Constraint | Value |
|------------|-------|
| Task ID format | `^T\d{3,}$` (e.g., T001, T1234) |
| Title length | 1-120 characters |
| Description length | 0-2000 characters |
| Notes item length | 0-5000 characters |
| Hierarchy max depth | 3 (epic -> task -> subtask) |
| Session notes max | 50 items |
| Cancellation reason | 5-300 characters |

---

## Version Changelog

### v2.8.0 (Current)

**Task Fields Added**:
- `updatedAt`: Automatic timestamp on mutations
- `origin`: Task provenance classification
- `relates`: Non-blocking task relationships

**Project Fields Added**:
- `releases`: Roadmap management array

**Focus Fields Added**:
- `sessionNotes`: Append-only session notes array

### v2.7.0

- Added `verification` object with gates
- Added `noAutoComplete` field

### v2.6.0

- Added `position` and `positionVersion` fields

### v2.5.0

- Added `position` field (deprecated)

### v2.4.0

- Increased notes maxLength to 5000

### v2.3.0

- Added `type`, `parentId`, `size` fields for hierarchy

### v2.2.0

- Converted project from string to object
- Added phase tracking

---

## See Also

- [Migration Guide: v2.8.0](../migration/v2.8.0-migration-guide.md)
- [Migration System](../MIGRATION-SYSTEM.md)
- [Schema File](../../schemas/todo.schema.json)
