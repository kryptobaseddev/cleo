# Schema Changes Summary

**Version**: 1.0.0
**Created**: 2025-12-29
**Purpose**: Document all pending schema changes from new specifications

---

## Overview

The following specifications introduce schema changes to `todo.schema.json`:

| Spec | New Fields | New Root Objects |
|------|------------|------------------|
| IMPLEMENTATION-ORCHESTRATION-SPEC | `verification`, `epicLifecycle` | - |
| RELEASE-MANAGEMENT-SPEC | `release` (task field) | `releases` (root) |
| ISSUE-LIFECYCLE-SPEC | `origin` | - |

---

## Part 1: Task Definition Extensions

### 1.1 Verification Field (IMPLEMENTATION-ORCHESTRATION-SPEC)

**Location**: `definitions.task.properties.verification`

```json
{
  "verification": {
    "type": ["object", "null"],
    "default": null,
    "description": "Implementation verification state. Tracks pass/fail status across validation gates.",
    "additionalProperties": false,
    "properties": {
      "passed": {
        "type": "boolean",
        "default": false,
        "description": "Overall verification status. True only when ALL gates pass."
      },
      "round": {
        "type": "integer",
        "minimum": 0,
        "default": 0,
        "description": "Current implementation round (0 = not started)."
      },
      "gates": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "implemented": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "Coder Agent completed implementation."
          },
          "testsPassed": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "Testing Agent verified all tests pass."
          },
          "qaPassed": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "QA Agent verified acceptance criteria."
          },
          "cleanupDone": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "Cleanup Agent completed refactoring."
          },
          "securityPassed": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "Security Agent found no critical issues."
          },
          "documented": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "Docs Agent completed documentation."
          }
        }
      },
      "lastAgent": {
        "type": ["string", "null"],
        "enum": ["planner", "coder", "testing", "qa", "cleanup", "security", "docs", null],
        "description": "Last agent to work on this task."
      },
      "lastUpdated": {
        "type": ["string", "null"],
        "format": "date-time",
        "description": "Timestamp of last verification update."
      },
      "failureLog": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["round", "agent", "reason", "timestamp"],
          "additionalProperties": false,
          "properties": {
            "round": { "type": "integer" },
            "agent": { "type": "string" },
            "reason": { "type": "string", "maxLength": 500 },
            "timestamp": { "type": "string", "format": "date-time" }
          }
        },
        "description": "Log of verification failures for debugging."
      }
    }
  }
}
```

### 1.2 Epic Lifecycle Field (IMPLEMENTATION-ORCHESTRATION-SPEC)

**Location**: `definitions.task.properties.epicLifecycle`

```json
{
  "epicLifecycle": {
    "type": ["string", "null"],
    "enum": ["backlog", "planning", "active", "review", "released", "archived", null],
    "default": null,
    "description": "Epic lifecycle state. Only applicable when type=epic. Null for tasks/subtasks."
  }
}
```

### 1.3 Release Field (RELEASE-MANAGEMENT-SPEC)

**Location**: `definitions.task.properties.release`

```json
{
  "release": {
    "type": ["string", "null"],
    "pattern": "^v\\d+\\.\\d+\\.\\d+(-[a-z0-9.-]+)?$",
    "default": null,
    "description": "Target release version. Set when Epic is assigned to a release."
  }
}
```

### 1.4 Origin Field (ISSUE-LIFECYCLE-SPEC)

**Location**: `definitions.task.properties.origin`

```json
{
  "origin": {
    "type": ["object", "null"],
    "default": null,
    "description": "External origin tracking for issues, bugs, and feature requests.",
    "additionalProperties": false,
    "properties": {
      "type": {
        "type": "string",
        "enum": ["internal", "bug-report", "feature-request", "security", "technical-debt", "dependency", "regression"],
        "description": "How this work was initiated"
      },
      "ref": {
        "type": ["string", "null"],
        "maxLength": 100,
        "pattern": "^[A-Z]+-\\d+$|^#\\d+$|^[a-f0-9]{7,40}$",
        "description": "External reference (GH-123, JIRA-456, #123, commit hash)"
      },
      "url": {
        "type": ["string", "null"],
        "format": "uri",
        "description": "URL to external issue tracker"
      },
      "reportedAt": {
        "type": ["string", "null"],
        "format": "date-time",
        "description": "When issue was originally reported"
      },
      "reporter": {
        "type": ["string", "null"],
        "maxLength": 100,
        "description": "Who reported (username, email, 'anonymous')"
      },
      "severity": {
        "type": ["string", "null"],
        "enum": ["critical", "major", "minor", "trivial", null],
        "description": "Issue severity (for bug-report, security, regression)"
      },
      "affectedVersion": {
        "type": ["string", "null"],
        "pattern": "^v?\\d+\\.\\d+\\.\\d+",
        "description": "Version where issue was discovered"
      },
      "affectedEpic": {
        "type": ["string", "null"],
        "pattern": "^T\\d{3,}$",
        "description": "Epic whose functionality is affected"
      },
      "resolution": {
        "type": ["string", "null"],
        "enum": ["fixed", "wontfix", "duplicate", "invalid", "cannot-reproduce", null],
        "description": "How issue was resolved"
      },
      "fixedIn": {
        "type": ["string", "null"],
        "pattern": "^v\\d+\\.\\d+\\.\\d+",
        "description": "Release version containing the fix"
      },
      "duplicateOf": {
        "type": ["string", "null"],
        "pattern": "^T\\d{3,}$",
        "description": "If duplicate, which task is the original"
      },
      "verifiedAt": {
        "type": ["string", "null"],
        "format": "date-time",
        "description": "When fix was verified"
      },
      "verifiedBy": {
        "type": ["string", "null"],
        "maxLength": 100,
        "description": "Who verified the fix"
      }
    },
    "required": ["type"]
  }
}
```

---

## Part 2: Root Object Extensions

### 2.1 Releases Registry (RELEASE-MANAGEMENT-SPEC)

**Location**: `properties.releases`

```json
{
  "releases": {
    "type": "object",
    "description": "Release registry. Keys are semver version strings.",
    "additionalProperties": false,
    "patternProperties": {
      "^v\\d+\\.\\d+\\.\\d+(-[a-z0-9.-]+)?$": {
        "$ref": "#/definitions/releaseDefinition"
      }
    }
  }
}
```

### 2.2 Release Definition

**Location**: `definitions.releaseDefinition`

```json
{
  "releaseDefinition": {
    "type": "object",
    "required": ["status", "createdAt"],
    "additionalProperties": false,
    "properties": {
      "status": {
        "type": "string",
        "enum": ["planned", "in-progress", "staging", "released", "deprecated"],
        "description": "Release lifecycle state"
      },
      "name": {
        "type": ["string", "null"],
        "maxLength": 100,
        "description": "Human-readable release name (e.g., 'Multi-Session Support')"
      },
      "type": {
        "type": "string",
        "enum": ["major", "minor", "patch", "hotfix"],
        "description": "Semantic versioning type"
      },
      "description": {
        "type": ["string", "null"],
        "maxLength": 500,
        "description": "Release summary for changelog header"
      },
      "epics": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^T\\d{3,}$"
        },
        "description": "Epic IDs included in this release"
      },
      "issues": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^T\\d{3,}$"
        },
        "description": "Issue/bug task IDs fixed in this release"
      },
      "breakingChanges": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 200
        },
        "description": "List of breaking changes (for major versions)"
      },
      "createdAt": {
        "type": "string",
        "format": "date-time",
        "description": "When release was created in CLEO"
      },
      "targetDate": {
        "type": ["string", "null"],
        "format": "date",
        "description": "Planned release date (roadmap)"
      },
      "releasedAt": {
        "type": ["string", "null"],
        "format": "date-time",
        "description": "When release was shipped"
      },
      "gitTag": {
        "type": ["string", "null"],
        "description": "Git tag reference"
      },
      "changelogPath": {
        "type": ["string", "null"],
        "description": "Path to generated changelog file"
      },
      "notes": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 500
        },
        "description": "Release notes and deployment instructions"
      }
    }
  }
}
```

---

## Part 3: Exit Code Extensions

### 3.1 Implementation Orchestration (40-49)

| Code | Constant | Meaning |
|------|----------|---------|
| 40 | `E_VERIFICATION_INIT_FAILED` | Could not initialize verification |
| 41 | `E_GATE_UPDATE_FAILED` | Could not update verification gate |
| 42 | `E_INVALID_GATE` | Unknown gate name |
| 43 | `E_INVALID_AGENT` | Unknown agent name |
| 44 | `E_MAX_ROUNDS_EXCEEDED` | Task exceeded maximum rounds |
| 45 | `E_GATE_DEPENDENCY` | Tried to set gate before prerequisite |
| 46 | `E_VERIFICATION_LOCKED` | Verification is locked (task completed) |
| 47 | `E_ROUND_MISMATCH` | Round number doesn't match current |

### 3.2 Release Management (50-59)

| Code | Constant | Meaning |
|------|----------|---------|
| 50 | `E_RELEASE_EXISTS` | Release version already exists |
| 51 | `E_RELEASE_NOT_FOUND` | Release version not found |
| 52 | `E_INVALID_VERSION` | Version string doesn't match semver |
| 53 | `E_EPIC_NOT_REVIEWED` | Epic not in "review" state |
| 54 | `E_TASKS_INCOMPLETE` | Release has incomplete tasks |
| 55 | `E_INVALID_TRANSITION` | Invalid release state transition |
| 56 | `E_CHANGELOG_FAILED` | Changelog generation failed |
| 57 | `E_GIT_TAG_FAILED` | Git tag creation failed |
| 58 | `E_RELEASE_LOCKED` | Released/deprecated releases cannot be modified |
| 59 | `E_EPIC_ALREADY_RELEASED` | Epic is already in another release |

### 3.3 Issue Management (60-69)

| Code | Constant | Meaning |
|------|----------|---------|
| 60 | `E_ISSUE_CREATE_FAILED` | Failed to create issue |
| 61 | `E_INVALID_ORIGIN_TYPE` | Unknown origin type |
| 62 | `E_INVALID_SEVERITY` | Unknown severity level |
| 63 | `E_INVALID_RESOLUTION` | Unknown resolution type |
| 64 | `E_ALREADY_VERIFIED` | Issue already verified |
| 65 | `E_NOT_FIXED` | Cannot verify unfixed issue |
| 66 | `E_DUPLICATE_NOT_FOUND` | Duplicate-of task doesn't exist |
| 67 | `E_CANNOT_REOPEN` | Cannot reopen (wrong state) |
| 68 | `E_EXTERNAL_SYNC_FAILED` | Failed to sync with external tracker |
| 69 | `E_ISSUE_LOCKED` | Issue is locked (released) |

---

## Part 4: New CLI Commands Summary

### 4.1 Verification Commands (IMPLEMENTATION-ORCHESTRATION-SPEC)

```bash
ct verify <task-id> --init
ct verify <task-id> --gate <gate> --value <bool> --agent <agent>
ct verify <task-id> --reset --round N
ct verify <task-id> --reset-downstream --from <gate>
ct list --verification-status <pending|in-progress|failed|passed>
ct show <task-id> --verification
```

### 4.2 Epic Lifecycle Commands (IMPLEMENTATION-ORCHESTRATION-SPEC)

```bash
ct epic lifecycle <epic-id> <state>
ct epic verify <epic-id>
ct epic ready <epic-id>
ct list --type epic --lifecycle <state>
ct show <epic-id> --lifecycle
```

### 4.3 Release Commands (RELEASE-MANAGEMENT-SPEC)

```bash
ct release create <version> --name <name> --type <type>
ct release plan <version> --add <epics>
ct release list
ct release show <version>
ct release start <version>
ct release stage <version>
ct release ship <version>
ct release deprecate <version>
ct release changelog <version>
ct release verify <version>
ct roadmap
```

### 4.4 Issue Commands (ISSUE-LIFECYCLE-SPEC)

```bash
ct issue create <title> --type <type> --severity <severity>
ct issue triage <task-id> --severity <severity> --priority <priority>
ct issue list --type <type> --severity <severity>
ct issue verify <task-id>
ct issue close <task-id> --resolution <resolution>
ct issue reopen <task-id> --reason <reason>
ct issue link-release <task-id> <version>
ct issue stats
```

---

## Part 5: Implementation Priority

### Phase 1: Schema Updates (Required First)
1. Add `verification` to task schema
2. Add `epicLifecycle` to task schema
3. Add `release` to task schema
4. Add `origin` to task schema
5. Add `releases` root object
6. Add `releaseDefinition` to definitions

### Phase 2: Core Commands
1. `ct verify` command family
2. `ct epic lifecycle` command
3. `ct release create/plan/list/show`
4. `ct issue create/triage/list`

### Phase 3: Advanced Features
1. Changelog generation
2. Roadmap visualization
3. Git integration
4. External tracker sync

---

## Part 6: Migration Notes

### Existing Tasks
- All existing tasks will have `verification: null`, `epicLifecycle: null`, `release: null`, `origin: null`
- No data migration required - fields are optional with null defaults
- Validation remains backward compatible

### Schema Version
- Schema version bump: `2.4.0` → `2.5.0`
- Add new fields to `schemaVersion` description

---

*This document is auto-generated from specification analysis. Update as specs evolve.*
