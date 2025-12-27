# Release Version Management Specification

**Version**: 2.0.0
**Status**: DRAFT
**Effective**: v0.20.0+
**Last Updated**: 2025-12-18

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14) [[RFC2119](https://www.rfc-editor.org/rfc/rfc2119)] [[RFC8174](https://www.rfc-editor.org/rfc/rfc8174)] when, and only when, they appear in all capitals.

---

## Preamble

This specification establishes the design for **Release Version Management** in cleo. It addresses the problem of version drift where tasks become associated with versions that never actually ship those tasks, and where there is no reliable tracking of what actually shipped in which release.

**Problem Statement:**
1. Version numbers shift as scope changes during development
2. Tasks get assigned to versions via labels but those versions never ship the tasks
3. No mechanism to track what **actually shipped** versus what was **planned**
4. LLM agents hallucinate version associations without validation
5. Labels provide no lifecycle tracking (planned → shipped → cancelled)
6. No integration with project VERSION file for semver workflow

**Design Goal:**
Enable cleo to track release versions with lifecycle management, distinguishing planned release targets from actual shipped releases, with referential integrity validation for LLM anti-hallucination, and optional VERSION file integration.

---

## Executive Summary

### Mission Statement

Provide **release entity management** that tracks version lifecycle and task associations with immutable shipping records, enabling accurate historical queries of what shipped when.

### Core Principles

| Principle | Requirement |
|-----------|-------------|
| **Opt-in Feature** | Release management is optional; enabled via config or init |
| **Registry-First** | Once enabled, releases MUST be registered before tasks can reference them |
| **Planned vs Shipped** | Tasks have separate fields for target (mutable) and shipped (immutable) |
| **Lifecycle Tracking** | Releases have explicit status transitions with timestamps |
| **Immutable History** | Shipped releases and their task associations cannot be modified |
| **Referential Integrity** | Task release fields MUST reference existing releases |
| **LLM Anti-Hallucination** | Version validation commands prevent invalid references |
| **VERSION Integration** | Optional integration with project VERSION file for semver workflow |

### Key Design Decisions

1. **Hybrid Approach**: Release registry (constraint) + Task fields (association)
2. **4-State Lifecycle**: `planning` → `development` → `released` (or `cancelled`)
3. **Automatic Transitions**: `planning` → `development` triggered by focus
4. **Hierarchy Awareness**: Epics have `targetRelease` but NOT `shippedRelease`
5. **VERSION Integration**: Config-driven bump on release ship

---

## Part 1: Configuration

### 1.1 Feature Toggle

Release management is **opt-in**. When disabled, the feature has zero impact on existing workflows.

```json
{
  "releases": {
    "enabled": false
  }
}
```

**Enabling behavior**:
- During `ct init`: Prompt "Enable release management? [y/N]"
- Manual: Set `releases.enabled: true` in config
- Once ANY release is created: Feature becomes **strict** (validation required)

### 1.2 Full Configuration Schema

Config location: `.cleo/config.json` under `releases` key.

```json
{
  "releases": {
    "enabled": true,
    "versionFile": "VERSION",
    "versionBump": {
      "mode": "prompt",
      "updateOnShip": true
    },
    "gitIntegration": {
      "createTag": true,
      "tagPrefix": "v",
      "pushTag": false
    },
    "validation": {
      "requireTasksToShip": false,
      "warnEmptyRelease": true,
      "warnStalePlanningDays": 30
    },
    "suggestions": {
      "autoSuggestVersion": true,
      "defaultBumpType": "minor"
    }
  }
}
```

### 1.3 Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable release management feature |
| `versionFile` | string\|null | `"VERSION"` | Path to VERSION file, or null to disable |
| `versionBump.mode` | enum | `"prompt"` | `"automatic"`, `"prompt"`, or `"manual"` |
| `versionBump.updateOnShip` | boolean | `true` | Update VERSION file when shipping |
| `gitIntegration.createTag` | boolean | `true` | Prompt to create git tag on ship |
| `gitIntegration.tagPrefix` | string | `"v"` | Tag prefix (e.g., `v0.19.0`) |
| `gitIntegration.pushTag` | boolean | `false` | Never auto-push (user responsibility) |
| `validation.requireTasksToShip` | boolean | `false` | Require ≥1 task to ship release |
| `validation.warnEmptyRelease` | boolean | `true` | Warn when shipping empty release |
| `validation.warnStalePlanningDays` | integer | `30` | Warn if planning release has no tasks after N days |
| `suggestions.autoSuggestVersion` | boolean | `true` | Suggest next version based on task scope |
| `suggestions.defaultBumpType` | enum | `"minor"` | Default bump type for suggestions |

---

## Part 2: Release Entity Design

### 2.1 Release Registry

Releases **MUST** be defined in `project.releases` before tasks can reference them.

```json
{
  "project": {
    "releases": {
      "0.19.0": {
        "status": "development",
        "description": "LLM-agent-first compliance",
        "createdAt": "2025-12-01T00:00:00Z",
        "targetDate": null,
        "releasedAt": null,
        "changelog": null
      }
    }
  }
}
```

### 2.2 Version Identifier Format

**Pattern**: `^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9]+(\.[a-z0-9]+)*)?$`

| Format | Valid | Notes |
|--------|-------|-------|
| `0.19.0` | Yes | Standard semver |
| `1.0.0-alpha` | Yes | Pre-release |
| `1.0.0-beta.1` | Yes | Pre-release with number |
| `1.0.0-rc.1` | Yes | Release candidate |
| `v0.19.0` | No | Normalize to remove `v` prefix |
| `0.19` | No | Patch version required |
| `19.0.0` | Yes | Valid semver |

**Normalization**: Input versions with `v` prefix SHOULD be accepted and normalized to remove the prefix for storage.

### 2.3 Release Lifecycle States (4-State Model)

| Status | Meaning | Task Association | Transition To |
|--------|---------|------------------|---------------|
| `planning` | Scope definition phase | Allowed (tentative) | `development`, `cancelled` |
| `development` | Active work | Allowed | `released`, `cancelled` |
| `released` | Shipped | **LOCKED** | - |
| `cancelled` | Abandoned | **CLEARED** | - |

**Lifecycle Diagram**:
```
    planning ───► development ───► released
        │              │
        └──────────────┴────────► cancelled
```

> **Design Note**: The `stabilization` state was removed. Feature freeze is a workflow discipline, not a system state. Agents need to know "can I assign work?" and "has this shipped?" - two states (`planning`/`development` vs `released`/`cancelled`) answer both questions.

### 2.4 Automatic State Transitions

**Trigger: planning → development**

When `ct focus set <task_id>` is executed AND:
- Task has `targetRelease` set to version X
- Release X has status = `planning`

Then:
- Automatically transition release X to `development`
- Log event in `releaseHistory`

```bash
ct focus set T329
# Task T329 has targetRelease: 0.19.0
# Release 0.19.0 status: planning → development (automatic)
# ✓ Release 0.19.0 transitioned to development (triggered by focus on T329)
```

**Rationale**: Planning means "defining scope". When someone starts working (focus), the release is in active development.

### 2.5 Release Definition Schema

```json
{
  "releaseDefinition": {
    "type": "object",
    "required": ["status", "createdAt"],
    "additionalProperties": false,
    "properties": {
      "status": {
        "type": "string",
        "enum": ["planning", "development", "released", "cancelled"],
        "description": "Current lifecycle state"
      },
      "description": {
        "type": "string",
        "maxLength": 500,
        "description": "Release goals and scope summary"
      },
      "createdAt": {
        "type": "string",
        "format": "date-time",
        "description": "When release was registered"
      },
      "targetDate": {
        "type": ["string", "null"],
        "format": "date",
        "description": "Target release date (milestone, not estimate)"
      },
      "releasedAt": {
        "type": ["string", "null"],
        "format": "date-time",
        "description": "Actual release timestamp. REQUIRED when status=released"
      },
      "changelog": {
        "type": ["string", "null"],
        "maxLength": 5000,
        "description": "Release notes, populated at release time"
      }
    }
  }
}
```

---

## Part 3: Task-Release Association

### 3.1 Task Fields

Tasks **MUST** have two release-related fields:

| Field | Purpose | Mutability | Validation |
|-------|---------|------------|------------|
| `targetRelease` | Planned release version | Mutable until task shipped | Must exist in registry, release not `released` or `cancelled` |
| `shippedRelease` | Actual release version | Immutable after set | Must exist in registry, release status = `released` |

### 3.2 Hierarchy and Releases

**Epics and releases are orthogonal concerns:**

| Task Type | `targetRelease` | `shippedRelease` | Rationale |
|-----------|-----------------|------------------|-----------|
| `epic` | Allowed | **NOT ALLOWED** | Epics are organizational, not shippable units |
| `task` | Allowed | Allowed | Tasks are the shippable units |
| `subtask` | Allowed | Allowed | Subtasks are the shippable units |

**Why epics don't have shippedRelease:**
- An epic's children may ship in different releases (v0.19.0 for core, v0.20.0 for polish)
- Epic "completion" is when all children are done, regardless of which releases they shipped in
- Release views show **tasks**, not epics
- This matches industry patterns (GitHub milestones apply to issues, not projects)

**Example:**
```
Epic T328 "Hierarchy Phase 1" (targetRelease: 0.19.0)
├── T329 Schema changes (shippedRelease: 0.19.0) ✓
├── T330 Validation (shippedRelease: 0.19.0) ✓
├── T331 CLI flags (shippedRelease: 0.20.0) - deferred
└── T332 Migration (shippedRelease: 0.20.0) - deferred

Epic is "done" when all children done, but shipped across TWO releases.
```

### 3.3 Task Schema Extension

```json
{
  "task": {
    "properties": {
      "targetRelease": {
        "type": ["string", "null"],
        "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(-[a-z0-9]+(\\.[a-z0-9]+)*)?$",
        "default": null,
        "description": "Planned release version. MUST exist in project.releases. Mutable until task ships."
      },
      "shippedRelease": {
        "type": ["string", "null"],
        "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(-[a-z0-9]+(\\.[a-z0-9]+)*)?$",
        "default": null,
        "description": "Actual release version when shipped. Immutable after set. REQUIRES task.status=done AND release.status=released. NOT ALLOWED for type=epic."
      }
    }
  }
}
```

### 3.4 Version Drift Tracking

When `targetRelease` changes, the system **SHOULD** log the transition:

```json
{
  "event": "release_reassignment",
  "taskId": "T429",
  "timestamp": "2025-12-18T10:00:00Z",
  "fromRelease": "0.18.0",
  "toRelease": "0.19.0",
  "reason": "Scope change"
}
```

This enables analysis of version drift patterns.

---

## Part 4: VERSION File Integration

### 4.1 VERSION File Detection

When `releases.versionFile` is configured (default: `"VERSION"`):

```bash
ct release suggest
# Reads VERSION file
# Analyzes unreleased tasks by scope (epic/bug-fix/breaking)
# Suggests next version(s)
```

**Output:**
```
Current VERSION: 0.18.1

Suggested releases based on unreleased work:
  0.18.2 (patch) - Bug fixes: T408, T409
  0.19.0 (minor) - New features: T328 (hierarchy epic), T376-T381
  1.0.0  (major) - Breaking changes: none detected

Create release? [patch/minor/major/skip]:
```

### 4.2 Version Suggestion Logic

| Task Characteristic | Suggested Bump |
|---------------------|----------------|
| Label contains `bug`, `fix`, `patch` | patch |
| Task type = `epic` or label contains `feature` | minor |
| Label contains `breaking`, `major` | major |
| Default (no signals) | config `defaultBumpType` |

### 4.3 VERSION Bump on Ship

When `ct release ship 0.19.0` is executed:

```bash
ct release ship 0.19.0

# Step 1: Validate
# ✓ Release 0.19.0 exists (status: development)
# ✓ 15 tasks targeting this release (12 done, 3 pending)
# ⚠ 3 tasks still pending - continue anyway? [y/N]: y

# Step 2: VERSION file (if configured)
# Current VERSION: 0.18.1
# Update to 0.19.0? [Y/n]: y
# ✓ VERSION file updated: 0.18.1 → 0.19.0

# Step 3: Git tag (if configured and .git exists)
# Create git tag v0.19.0? [Y/n]: y
# ✓ Created tag v0.19.0 at HEAD
# Note: Run 'git push origin v0.19.0' to push tag

# Step 4: Ship release
# ✓ Release 0.19.0 status: development → released
# ✓ releasedAt: 2025-12-18T15:30:00Z
# ✓ 12 done tasks marked with shippedRelease: 0.19.0

# Release 0.19.0 shipped successfully!
```

**Mode behaviors:**

| Mode | VERSION Update | Git Tag |
|------|----------------|---------|
| `automatic` | Update without prompt | Prompt (if enabled) |
| `prompt` | Prompt before update | Prompt (if enabled) |
| `manual` | Skip (user handles separately) | Prompt (if enabled) |

---

## Part 5: Validation Rules

### 5.1 Referential Integrity

| Operation | Validation Required |
|-----------|---------------------|
| Set `targetRelease` | Version MUST exist in `project.releases`; release status MUST NOT be `released` or `cancelled` |
| Set `shippedRelease` | Version MUST exist; release status MUST be `released`; task status MUST be `done`; `shippedRelease` MUST NOT already be set; task type MUST NOT be `epic` |
| Create release | Version MUST NOT already exist |
| Delete release | Release MUST have status `planning` or `cancelled`; no tasks may reference it |
| Transition to `released` | At least one task SHOULD have this `targetRelease` (warning if `warnEmptyRelease`, not error unless `requireTasksToShip`) |
| Transition to `cancelled` | Tasks with `targetRelease` matching this version MUST have field cleared or reassigned |

### 5.2 Immutability Rules

**Shipped releases are immutable:**

| Property | Modifiable After Release? |
|----------|---------------------------|
| `status` | NO |
| `releasedAt` | NO |
| `changelog` | YES (annotations allowed) |
| `description` | YES (clarifications allowed) |
| Associated tasks | NO (task `shippedRelease` locked) |

### 5.3 Anti-Hallucination Validation

LLM agents **MUST** validate release references before use:

```bash
# Check release exists (exit code pattern)
ct release exists 0.19.0 --quiet  # Exit 0 if exists, 1 if not

# Validate before association
ct release validate 0.19.0 --for-target    # Can be used as targetRelease?
ct release validate 0.19.0 --for-shipped   # Can be used as shippedRelease?
```

---

## Part 6: Release History

### 6.1 Release History Log

Similar to `project.phaseHistory`, releases **SHOULD** have a history log:

```json
{
  "project": {
    "releaseHistory": [
      {
        "version": "0.19.0",
        "event": "status_change",
        "timestamp": "2025-12-18T10:00:00Z",
        "fromStatus": "planning",
        "toStatus": "development",
        "trigger": "focus_set",
        "triggerTask": "T329",
        "taskCount": 15
      }
    ]
  }
}
```

### 6.2 History Entry Schema

```json
{
  "releaseHistoryEntry": {
    "type": "object",
    "required": ["version", "event", "timestamp"],
    "properties": {
      "version": {
        "type": "string",
        "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(-[a-z0-9]+(\\.[a-z0-9]+)*)?$"
      },
      "event": {
        "type": "string",
        "enum": ["created", "status_change", "shipped", "task_assigned", "task_removed"]
      },
      "timestamp": {
        "type": "string",
        "format": "date-time"
      },
      "fromStatus": {
        "type": ["string", "null"]
      },
      "toStatus": {
        "type": ["string", "null"]
      },
      "trigger": {
        "type": ["string", "null"],
        "enum": ["manual", "focus_set", "ship_command", null],
        "description": "What triggered this event"
      },
      "triggerTask": {
        "type": ["string", "null"],
        "description": "Task ID that triggered automatic transition"
      },
      "taskCount": {
        "type": "integer",
        "minimum": 0,
        "description": "Tasks associated at time of event"
      }
    }
  }
}
```

---

## Part 7: Query Patterns

### 7.1 Release Queries

| Query | Command | Implementation |
|-------|---------|----------------|
| List all releases | `ct release list` | Iterate `project.releases` |
| List by status | `ct release list --status development` | Filter by status |
| Show release details | `ct release show 0.19.0` | Return release + associated tasks |
| Release progress | `ct release progress 0.19.0` | Task counts by status |
| Suggest next version | `ct release suggest` | Analyze tasks, read VERSION |

### 7.2 Task Queries

| Query | Command | Implementation |
|-------|---------|----------------|
| Tasks for release (planned) | `ct list --target-release 0.19.0` | Filter by `targetRelease` |
| Tasks for release (shipped) | `ct list --shipped-release 0.18.0` | Filter by `shippedRelease` |
| Unassigned tasks | `ct list --no-release` | `targetRelease` is null |
| Version drift | `ct list --release-changed` | Tasks where history shows reassignment |

### 7.3 Analysis Queries

| Query | Command | Description |
|-------|---------|-------------|
| Scope change report | `ct release scope-changes 0.19.0` | Tasks added/removed from release |
| Shipping accuracy | `ct release accuracy 0.19.0` | targetRelease vs shippedRelease match rate |
| Release burndown | `ct release burndown 0.19.0` | Completion trend over time |

---

## Part 8: CLI Commands

### 8.1 Release Management Commands

| Command | Description | Exit Codes |
|---------|-------------|------------|
| `ct release create <version>` | Register new release | 0=success, 31=exists |
| `ct release list [--status STATUS]` | List releases | 0=success, 100=empty |
| `ct release show <version>` | Release details + tasks | 0=success, 30=not found |
| `ct release exists <version>` | Check existence | 0=exists, 30=not found |
| `ct release status <version> <status>` | Update lifecycle status | 0=success, 30=not found |
| `ct release ship <version>` | Mark released, bump VERSION, create tag | 0=success, validation errors |
| `ct release delete <version>` | Remove release | 0=success, validation errors |
| `ct release suggest` | Suggest next version based on tasks | 0=success |
| `ct release migrate-labels` | Migrate version labels to releases | 0=success |

### 8.2 Task-Release Commands

| Command | Description |
|---------|-------------|
| `ct add "Task" --target-release 0.19.0` | Create with release association |
| `ct update T001 --target-release 0.19.0` | Associate existing task |
| `ct update T001 --target-release ""` | Remove release association |
| `ct list --target-release 0.19.0` | Filter by planned release |

### 8.3 Release Shipping Workflow

```bash
# 1. Check release ready
ct release show 0.19.0
# Displays: status, task breakdown, blockers

# 2. Ship release (interactive)
ct release ship 0.19.0
# - Validates release
# - Updates VERSION file (if configured)
# - Creates git tag (if configured)
# - Sets status=released, releasedAt=now
# - Marks done tasks with shippedRelease

# 3. Verify
ct list --shipped-release 0.19.0
```

---

## Part 9: JSON Output Format

### 9.1 Release List Output

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "command": "release list",
    "timestamp": "2025-12-18T10:00:00Z",
    "version": "0.20.0"
  },
  "success": true,
  "summary": {
    "total": 3,
    "byStatus": {
      "planning": 1,
      "development": 1,
      "released": 1
    }
  },
  "releases": [
    {
      "version": "0.20.0",
      "status": "planning",
      "taskCount": 5,
      "completedCount": 0
    },
    {
      "version": "0.19.0",
      "status": "development",
      "taskCount": 12,
      "completedCount": 7
    },
    {
      "version": "0.18.0",
      "status": "released",
      "releasedAt": "2025-12-15T00:00:00Z",
      "taskCount": 20,
      "completedCount": 20
    }
  ]
}
```

### 9.2 Release Suggest Output

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "command": "release suggest",
    "timestamp": "2025-12-18T10:00:00Z",
    "version": "0.20.0"
  },
  "success": true,
  "currentVersion": "0.18.1",
  "versionFile": "VERSION",
  "suggestions": [
    {
      "version": "0.18.2",
      "bumpType": "patch",
      "reason": "Bug fixes",
      "taskCount": 2,
      "tasks": ["T408", "T409"]
    },
    {
      "version": "0.19.0",
      "bumpType": "minor",
      "reason": "New features (epics)",
      "taskCount": 15,
      "tasks": ["T328", "T376", "T377", "..."]
    }
  ]
}
```

---

## Part 10: Error Codes

### 10.1 Release-Specific Exit Codes

> **Cross-reference**: General exit codes defined in [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) Part 3.1

| Code | Constant | Meaning |
|------|----------|---------|
| 30 | `EXIT_RELEASE_NOT_FOUND` | Release version does not exist |
| 31 | `EXIT_RELEASE_EXISTS` | Release version already registered |
| 32 | `EXIT_RELEASE_IMMUTABLE` | Operation not allowed on shipped release |
| 33 | `EXIT_RELEASE_INVALID_TRANSITION` | Invalid status transition |
| 34 | `EXIT_RELEASE_HAS_TASKS` | Cannot delete release with associated tasks |
| 35 | `EXIT_RELEASE_EPIC_SHIPPED` | Cannot set shippedRelease on epic |

### 10.2 Release-Specific Error Codes

| Exit Code | Error Code | Description |
|-----------|------------|-------------|
| 30 | `E_RELEASE_NOT_FOUND` | Release version not in registry |
| 31 | `E_RELEASE_EXISTS` | Version already registered |
| 32 | `E_RELEASE_IMMUTABLE` | Cannot modify shipped release |
| 33 | `E_RELEASE_INVALID_TRANSITION` | Invalid lifecycle transition |
| 34 | `E_RELEASE_HAS_TASKS` | Cannot delete with associated tasks |
| 35 | `E_RELEASE_EPIC_SHIPPED` | Epics cannot have shippedRelease |

---

## Part 11: Migration

### 11.1 Schema Version

- **Current**: `cleo-schema-v2.3`
- **Target**: `cleo-schema-v2.4`

### 11.2 Migration from Labels

The `ct release migrate-labels` command migrates existing version labels to the release system.

```bash
ct release migrate-labels --dry-run

# Output:
╭─────────────────────────────────────────────────────────────────╮
│ Release Label Migration Preview                                  │
├─────────────────────────────────────────────────────────────────┤
│ Releases to create:                                              │
│   0.17.0 (released) - 15 done tasks, completion date: 2025-12-10│
│   0.18.0 (released) - 8 done tasks, completion date: 2025-12-15 │
│   0.19.0 (development) - 22 pending/active tasks                │
│                                                                  │
│ Task field assignments:                                          │
│   15 tasks → shippedRelease: 0.17.0                             │
│    8 tasks → shippedRelease: 0.18.0                             │
│   22 tasks → targetRelease: 0.19.0                              │
│                                                                  │
│ Labels to remove:                                                │
│   v0.15.0 (12 tasks) - stale, reconciled to 0.17.0             │
│   v0.16.0 (11 tasks) - stale, reconciled to 0.18.0             │
│   v0.17.0 (42 tasks) - migrated to release fields              │
│   v0.18.0 (11 tasks) - migrated to release fields              │
│   v0.19.0 (6 tasks)  - migrated to release fields              │
│                                                                  │
│ Run with --execute to apply changes                              │
╰─────────────────────────────────────────────────────────────────╯
```

**Migration Logic:**
1. Scan for version-pattern labels (`^v?[0-9]+\.[0-9]+\.[0-9]+`)
2. For done tasks with version labels:
   - Infer `shippedRelease` from completion date proximity to version label
   - Create release with status `released` if not exists
3. For pending/active tasks:
   - Use highest version label as `targetRelease`
   - Create release with status `development` if not exists
4. Handle dual labels (e.g., `v0.15.0` + `v0.17.0`):
   - Keep only the most recent/highest version
   - Log reconciliation in history
5. Remove migrated version labels from tasks

### 11.3 Backward Compatibility

| Concern | Resolution |
|---------|------------|
| Existing version labels | Continue to work with warning; suggest using releases |
| Projects without releases | `project.releases` defaults to empty object |
| Old schema files | Migration adds `releases: {}` and `releaseHistory: []` |
| `releases.enabled: false` | Feature completely disabled, no validation |

---

## Part 12: Release Scope Guidelines

### 12.1 Best Practices

Based on industry patterns (GitHub Milestones, Jira Fix Version, Linear Cycles):

| Practice | Recommendation |
|----------|----------------|
| Empty releases | **ALLOWED** - useful for planning and version reservation |
| Task assignment timing | Assign during planning phase; OK to defer |
| Release without tasks | Warning (not error) unless `requireTasksToShip: true` |
| Multiple active releases | **ALLOWED** - up to 10 non-released releases |

### 12.2 When to Create Releases

| Scenario | Action |
|----------|--------|
| Planning next version | Create release in `planning` status |
| Starting active development | Create in `development` status |
| Reserving version number | Create in `planning` with description |
| Migrating from labels | Use `ct release migrate-labels` |

### 12.3 Warnings (Not Errors)

| Condition | Warning Message |
|-----------|-----------------|
| Ship release with 0 tasks | "Release 0.19.0 has no tasks. Continue? [y/N]" |
| Release in planning >30 days with 0 tasks | "Stale planning release: 0.20.0 (created 45 days ago, 0 tasks)" |
| >5 releases in planning status | "Many planned releases (6). Consider consolidating." |
| >50 tasks targeting one release | "Large release scope (52 tasks). Consider splitting." |

---

## Part 13: Constraints and Limits

### 13.1 Hard Limits

| Constraint | Value | Rationale |
|------------|-------|-----------|
| Max releases | 100 | Bounded for LLM context; archive old releases |
| Max active releases (non-released) | 10 | Focus on current work |
| Version string length | 50 characters | Reasonable for semver + pre-release |
| Changelog length | 5000 characters | Adequate for release notes |

### 13.2 Soft Limits (Warnings)

| Constraint | Threshold | Warning |
|------------|-----------|---------|
| Tasks per release | >50 | "Consider splitting into multiple releases" |
| Releases in planning | >5 | "Many planned releases; consider consolidating" |
| Release without tasks | 0 tasks | "Empty release - consider adding tasks or cancelling" |
| Planning release age | >30 days | "Stale planning release" |

---

## Part 14: Out of Scope (v1)

### 14.1 Included in v1 (Changed from Original Spec)

| Feature | Status | Notes |
|---------|--------|-------|
| **Git tag integration** | **INCLUDED** | Config-driven, prompt-based, no auto-push |
| **VERSION file integration** | **INCLUDED** | Config-driven, bump on ship |

### 14.2 Deferred to v2

| Feature | Rationale | Target |
|---------|-----------|--------|
| CI/CD automation | Environment-specific | Plugin/hooks |
| Branch tracking | Git-workflow-specific | v2 |
| Rollback/unship | Complexity; rare need | v2 if needed |
| Multi-project coordination | Different problem space | v2 spec |

### 14.3 Intentionally Excluded

| Feature | Rationale | Alternative |
|---------|-----------|-------------|
| Semantic versioning enforcement | Too restrictive; calver exists | Loose validation |
| Release dependencies | Over-engineering | Use task `depends` |
| Auto-push tags | Too dangerous | User runs `git push` |

---

## Appendix A: Design Rationale

### A.1 Why 4 States Instead of 5?

Original spec had 5 states including `stabilization`. Removed because:
- `stabilization` is a workflow discipline (feature freeze), not a system state
- Agents need to answer: "Can I assign work?" and "Has this shipped?"
- 4 states cleanly answer both questions
- Simpler state machine = fewer edge cases

### A.2 Why Automatic Transitions?

Manual transitions add friction and are often forgotten. Automatic `planning` → `development` on focus:
- Reduces cognitive load
- Ensures release status reflects reality
- Mirrors how teams actually work (planning ends when work starts)

### A.3 Why Epics Don't Have shippedRelease?

Epics are **organizational units** (grouping related work), not **shippable units**:
- Epic children may ship in different releases
- Epic completion is orthogonal to release shipping
- Matches GitHub/Jira patterns (milestones apply to issues, not projects)

### A.4 Why VERSION File Integration?

Real-world observation: cleo's own version labels became stale because there was no connection between task tracking and the VERSION file. Integration:
- Ensures consistency between what's tracked and what's released
- Reduces manual version management errors
- Provides semver suggestion based on task scope

### A.5 Why Immutability After Release?

Historical accuracy requires that once a release ships:
- Its contents are frozen (what shipped is what shipped)
- Git commits referencing the release remain accurate
- Changelogs reflect reality, not revised history
- Audit trails remain trustworthy for compliance

**Immutability protects against:**
- Retroactive scope changes ("we actually shipped X in v0.17.0")
- Historical revisionism that breaks traceability
- Inconsistency between task records and git history

This follows the IETF model: "RFCs never change" - shipped releases are historical records.

---

## Appendix B: Industry Precedents

| System | Pattern | Relevance |
|--------|---------|-----------|
| **Linear** | Cycles for sprints, Projects for releases | Separate planning entity from tasks |
| **GitHub** | Milestones group issues, Releases are artifacts | Clear separation of planning vs shipping |
| **Jira** | Fix Version field + Version entity | Hybrid approach validates our design |
| **Semantic Versioning** | Version format standard | Format validation pattern |
| **npm/cargo** | VERSION file as source of truth | VERSION integration pattern |

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| **[SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)** | **AUTHORITATIVE** for specification standards |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | **AUTHORITATIVE** for CLI output format, exit codes, JSON envelope |
| **[LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md)** | Task ID system design; release references use same validation patterns |
| **[TASK-HIERARCHY-SPEC.md](TASK-HIERARCHY-SPEC.md)** | Related: hierarchy + releases provide complementary organization |
| **[RELEASE-VERSION-MANAGEMENT-IMPLEMENTATION-REPORT.md](RELEASE-VERSION-MANAGEMENT-IMPLEMENTATION-REPORT.md)** | Tracks implementation status |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.0.0 | 2025-12-18 | Major revision: 4-state lifecycle, automatic transitions, epic handling, VERSION integration, git tags, config structure, migration tool |
| 1.0.0 | 2025-12-18 | Initial draft from multi-agent research |

---

*End of Specification*
