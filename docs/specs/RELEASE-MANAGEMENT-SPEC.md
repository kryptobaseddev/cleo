# Release Management Specification

**Version**: 1.0.0
**Status**: DRAFT
**Created**: 2025-12-29
**Related**: IMPLEMENTATION-ORCHESTRATION-SPEC.md, ISSUE-LIFECYCLE-SPEC.md, PROJECT-LIFECYCLE-SPEC.md

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Preamble

### Purpose

This specification defines the **Release Management Protocol** for CLEO, covering the complete lifecycle from release planning through deployment and post-release maintenance. It integrates with the Implementation Orchestration pipeline to provide end-to-end tracking from task completion to production release, including changelog generation and roadmap management.

### Authority

This specification is **AUTHORITATIVE** for:

- Release lifecycle states and transitions
- Release schema definition in todo.json
- Changelog generation from completed tasks
- Roadmap management and visualization
- Version numbering conventions (semver)
- Git tag integration
- Release-to-Epic/Task associations
- Exit codes 50-59 (Release Management)

This specification **DEFERS TO**:

- [IMPLEMENTATION-ORCHESTRATION-SPEC.md](IMPLEMENTATION-ORCHESTRATION-SPEC.md) for task verification
- [ISSUE-LIFECYCLE-SPEC.md](ISSUE-LIFECYCLE-SPEC.md) for bug-to-release tracking
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) for JSON output standards
- [PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md) for phase definitions

### Problem Statement

After tasks are completed through the Implementation Orchestration pipeline, there is no structured process for:

1. **Aggregating completed work** into releasable units
2. **Generating changelogs** from task metadata
3. **Planning roadmaps** for future releases
4. **Tracking release state** from planning to deployment
5. **Linking releases to git tags** and deployment artifacts

---

## Part 1: Architecture Overview

### 1.1 Release Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         RELEASE MANAGEMENT FLOW                                      │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  IMPLEMENTATION COMPLETE                                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  Epic: epicLifecycle = "review"                                               │   │
│  │  All tasks: status = "done", verification.passed = true                       │   │
│  └──────────────────────────────────────┬───────────────────────────────────────┘   │
│                                         │                                            │
│                                         ▼                                            │
│  RELEASE PLANNING                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  ct release create v0.42.0 --name "Multi-Session Support"                     │   │
│  │  ct release plan v0.42.0 --add T998,T999                                      │   │
│  │                                                                               │   │
│  │  Release: status = "planned"                                                  │   │
│  │  Epics: release = "v0.42.0"                                                   │   │
│  └──────────────────────────────────────┬───────────────────────────────────────┘   │
│                                         │                                            │
│                                         ▼                                            │
│  RELEASE PREPARATION                                                                │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  ct release changelog v0.42.0        # Generate changelog                     │   │
│  │  ct release verify v0.42.0           # All Epics reviewed, all tasks pass     │   │
│  │                                                                               │   │
│  │  Release: status = "staging"                                                  │   │
│  └──────────────────────────────────────┬───────────────────────────────────────┘   │
│                                         │                                            │
│                                         ▼                                            │
│  RELEASE EXECUTION                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  ct release ship v0.42.0             # Git tag, mark released                 │   │
│  │                                                                               │   │
│  │  Release: status = "released", releasedAt = now()                             │   │
│  │  Epics: epicLifecycle = "released"                                            │   │
│  │  Git: tag v0.42.0 created                                                     │   │
│  └──────────────────────────────────────┬───────────────────────────────────────┘   │
│                                         │                                            │
│                                         ▼                                            │
│  POST-RELEASE                                                                       │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  Bug reports → Issue Lifecycle → Hotfix releases (v0.42.1)                    │   │
│  │  Feature requests → RCSD Pipeline → Next release (v0.43.0)                    │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Release-Epic-Task Relationship

```
Release v0.42.0
├── Epic T998: Multi-Session Support        (epicLifecycle: released)
│   ├── Task T1008: Fix session status      (phase: core, status: done)
│   ├── Task T1013: Design binding spec     (phase: setup, status: done)
│   └── Task T1022: Fix session end         (phase: core, status: done)
├── Epic T999: Session Documentation        (epicLifecycle: released)
│   └── Task T999-1: Write session docs     (phase: polish, status: done)
└── Bugs Fixed
    ├── Issue ISS-001: Session timeout      (status: closed, fixedIn: v0.42.0)
    └── Issue ISS-002: Resume fails         (status: closed, fixedIn: v0.42.0)
```

---

## Part 2: Schema Definition

### 2.1 Release Registry

Add to `todo.json` root:

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

```json
{
  "definitions": {
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
}
```

### 2.3 Task Schema Extension

Add to task definition:

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

### 2.4 Epic Lifecycle Extension

Add to task definition (for type=epic only):

```json
{
  "epicLifecycle": {
    "type": ["string", "null"],
    "enum": ["backlog", "planning", "active", "review", "released", "archived", null],
    "default": null,
    "description": "Epic lifecycle state. Only applicable when type=epic."
  }
}
```

---

## Part 3: Release Lifecycle

### 3.1 State Machine

```
                    ┌───────────────────────────────────────────────────────────┐
                    │                    RELEASE LIFECYCLE                       │
                    └───────────────────────────────────────────────────────────┘

                              ct release create
                    ┌───────────┐ ─────────────────► ┌─────────────┐
                    │ (none)    │                    │   PLANNED   │
                    └───────────┘                    └──────┬──────┘
                                                           │
                                            ct release start (or first Epic active)
                                                           │
                                                           ▼
                                                    ┌─────────────┐
                                                    │ IN-PROGRESS │
                                                    └──────┬──────┘
                                                           │
                                               ct release stage (all Epics reviewed)
                                                           │
                                                           ▼
                                                    ┌─────────────┐
                                                    │   STAGING   │
                                                    └──────┬──────┘
                                                           │
                                                    ct release ship
                                                           │
                                                           ▼
                                                    ┌─────────────┐
                                                    │  RELEASED   │
                                                    └──────┬──────┘
                                                           │
                                               ct release deprecate (optional)
                                                           │
                                                           ▼
                                                    ┌─────────────┐
                                                    │ DEPRECATED  │
                                                    └─────────────┘
```

### 3.2 State Definitions

| State | Description | Allowed Operations |
|-------|-------------|-------------------|
| `planned` | Release created, collecting Epics | Add/remove Epics, set target date |
| `in-progress` | Active development on included Epics | Add Epics, update progress |
| `staging` | All Epics complete, pre-release validation | Generate changelog, final testing |
| `released` | Shipped to production | Cannot modify Epics, can add notes |
| `deprecated` | End of life | Read-only |

### 3.3 State Transition Rules

| Transition | Condition | Action |
|------------|-----------|--------|
| planned → in-progress | Any Epic starts active | Automatic or manual |
| in-progress → staging | All Epics epicLifecycle=review | Manual: `ct release stage` |
| staging → released | QA approval, changelog generated | Manual: `ct release ship` |
| released → deprecated | EOL decision | Manual: `ct release deprecate` |

---

## Part 4: CLI Commands

### 4.1 Release Management

```bash
# Create a new release
ct release create <version> [OPTIONS]
  --name <string>           # Release name (e.g., "Multi-Session Support")
  --type <major|minor|patch|hotfix>  # Semver type (default: auto-detect)
  --target-date <YYYY-MM-DD>  # Planned release date
  --description <string>    # Release summary

# Plan release contents
ct release plan <version> [OPTIONS]
  --add <epic-ids>          # Add Epics to release (comma-separated)
  --remove <epic-ids>       # Remove Epics from release
  --add-issue <task-ids>    # Add bug fixes to release

# List releases
ct release list [OPTIONS]
  --status <status>         # Filter by status
  --format <text|json|markdown>
  --include-epics           # Show Epic details

# Show release details
ct release show <version> [OPTIONS]
  --format <text|json|markdown>
  --include-tasks           # Show all tasks in release

# Update release state
ct release start <version>    # planned → in-progress
ct release stage <version>    # in-progress → staging (validates all Epics)
ct release ship <version>     # staging → released (creates git tag)
ct release deprecate <version>  # released → deprecated

# Generate changelog
ct release changelog <version> [OPTIONS]
  --format <markdown|json|conventional>
  --output <path>           # Write to file (default: stdout)
  --include-commits         # Include git commit hashes
  --since <version>         # Generate from previous version

# Verify release readiness
ct release verify <version>
  # Checks: all Epics reviewed, all tasks done, no blocking issues

# Add release notes
ct release note <version> <note>
```

### 4.2 Roadmap Commands

```bash
# Show roadmap
ct roadmap [OPTIONS]
  --format <text|json|markdown|gantt>
  --include-completed       # Include released versions
  --horizon <quarters>      # How far ahead to show (default: 4)

# Set release target date
ct release target <version> <YYYY-MM-DD>

# Reorder roadmap (change target dates)
ct roadmap reorder <version> --after <other-version>
ct roadmap reorder <version> --before <other-version>
```

### 4.3 Examples

```bash
# Create and plan a release
ct release create v0.42.0 --name "Multi-Session Support" --type minor
ct release plan v0.42.0 --add T998,T999

# As work progresses
ct release start v0.42.0  # or automatic when Epic goes active

# When Epics are complete
ct release stage v0.42.0
ct release verify v0.42.0
ct release changelog v0.42.0 --output CHANGELOG-v0.42.0.md

# Ship it
ct release ship v0.42.0
# Creates git tag, marks Epics as released

# View roadmap
ct roadmap --format markdown
```

---

## Part 5: Changelog Generation

### 5.1 Changelog Format

Generated changelogs follow [Keep a Changelog](https://keepachangelog.com/) format:

```markdown
# Changelog

## [v0.42.0] - 2025-12-29 - Multi-Session Support

### Added
- Multi-session support for concurrent LLM agents (T998)
- Session binding with automatic context detection (T1013)
- Epic lifecycle tracking for release management (T1000)

### Changed
- Session status command now shows all sessions (T1008)
- Focus commands are now session-aware (T1015)

### Fixed
- Session end no longer fails silently (T1022)
- Resume correctly restores previous focus (ISS-001)

### Breaking Changes
- `session start` now requires `--scope` or `--focus` flag

### Contributors
- @claude-agent (implementation)
- @user (review)

---

## [v0.41.7] - 2025-12-28

...
```

### 5.2 Changelog Entry Sources

| Entry Type | Source | Example |
|------------|--------|---------|
| **Added** | Epic title where labels include `feature` or new capability | New feature Epics |
| **Changed** | Epic title where labels include `enhancement` | Enhancement Epics |
| **Fixed** | Issues with `origin.type = bug-report` | Bug fixes |
| **Deprecated** | Tasks with label `deprecation` | Deprecation notices |
| **Removed** | Tasks with label `removal` | Removed features |
| **Security** | Issues with `origin.type = security` | Security fixes |
| **Breaking** | Release `breakingChanges` array | Major version bumps |

### 5.3 Changelog Generation Algorithm

```python
def generate_changelog(release_version: str) -> str:
    release = get_release(release_version)

    sections = {
        "Added": [],
        "Changed": [],
        "Fixed": [],
        "Deprecated": [],
        "Removed": [],
        "Security": [],
    }

    # Process Epics
    for epic_id in release.epics:
        epic = get_task(epic_id)
        labels = epic.labels or []

        if "feature" in labels or "capability" in labels:
            sections["Added"].append(f"- {epic.title} ({epic_id})")
        elif "enhancement" in labels:
            sections["Changed"].append(f"- {epic.title} ({epic_id})")
        elif "deprecation" in labels:
            sections["Deprecated"].append(f"- {epic.title} ({epic_id})")
        elif "removal" in labels:
            sections["Removed"].append(f"- {epic.title} ({epic_id})")
        else:
            sections["Added"].append(f"- {epic.title} ({epic_id})")

    # Process Issues
    for issue_id in release.issues:
        issue = get_task(issue_id)
        origin = issue.origin or {}

        if origin.get("type") == "security":
            sections["Security"].append(f"- {issue.title} ({issue_id})")
        else:
            sections["Fixed"].append(f"- {issue.title} ({issue_id})")

    # Format output
    output = f"## [{release_version}] - {release.releasedAt or 'Unreleased'}"
    if release.name:
        output += f" - {release.name}"
    output += "\n\n"

    for section, entries in sections.items():
        if entries:
            output += f"### {section}\n"
            output += "\n".join(entries)
            output += "\n\n"

    if release.breakingChanges:
        output += "### Breaking Changes\n"
        for change in release.breakingChanges:
            output += f"- {change}\n"
        output += "\n"

    return output
```

---

## Part 6: Roadmap Management

### 6.1 Roadmap Data Model

Roadmap is **computed** from releases with `status != released`:

```json
{
  "roadmap": [
    {
      "version": "v0.42.0",
      "name": "Multi-Session Support",
      "status": "staging",
      "targetDate": "2025-12-30",
      "progress": {
        "epicsTotal": 2,
        "epicsComplete": 2,
        "tasksTotal": 15,
        "tasksComplete": 15,
        "percentComplete": 100
      },
      "epics": [
        {"id": "T998", "title": "Multi-Session Support", "epicLifecycle": "review"},
        {"id": "T999", "title": "Session Documentation", "epicLifecycle": "review"}
      ]
    },
    {
      "version": "v0.43.0",
      "name": "Implementation Orchestration",
      "status": "planned",
      "targetDate": "2025-01-15",
      "progress": {
        "epicsTotal": 3,
        "epicsComplete": 0,
        "tasksTotal": 25,
        "tasksComplete": 0,
        "percentComplete": 0
      },
      "epics": [
        {"id": "T1000", "title": "Implementation Agents", "epicLifecycle": "planning"},
        {"id": "T1001", "title": "Verification System", "epicLifecycle": "backlog"},
        {"id": "T1002", "title": "Security Agent", "epicLifecycle": "backlog"}
      ]
    }
  ]
}
```

### 6.2 Roadmap Visualization

**Text Format**:
```
ROADMAP
═══════════════════════════════════════════════════════════════════════════════

v0.42.0 - Multi-Session Support          [████████████████████] 100%  Dec 30
  ├── T998: Multi-Session Support        [review]
  └── T999: Session Documentation        [review]

v0.43.0 - Implementation Orchestration   [░░░░░░░░░░░░░░░░░░░░]   0%  Jan 15
  ├── T1000: Implementation Agents       [planning]
  ├── T1001: Verification System         [backlog]
  └── T1002: Security Agent              [backlog]

v0.44.0 - Release Management             [░░░░░░░░░░░░░░░░░░░░]   0%  Feb 01
  └── (no epics assigned)
```

**Markdown Format**:
```markdown
# Roadmap

## Q4 2025

### v0.42.0 - Multi-Session Support (Dec 30)
**Status**: Staging | **Progress**: 100%

- [x] T998: Multi-Session Support
- [x] T999: Session Documentation

## Q1 2026

### v0.43.0 - Implementation Orchestration (Jan 15)
**Status**: Planned | **Progress**: 0%

- [ ] T1000: Implementation Agents
- [ ] T1001: Verification System
- [ ] T1002: Security Agent
```

---

## Part 7: Git Integration

### 7.1 Tag Creation

When `ct release ship` is executed:

```bash
# 1. Verify release is in staging state
# 2. Create annotated git tag
git tag -a "v${VERSION}" -m "Release ${VERSION}: ${RELEASE_NAME}

${CHANGELOG_SUMMARY}

Epics: ${EPIC_IDS}
Issues Fixed: ${ISSUE_IDS}"

# 3. Push tag (if configured)
git push origin "v${VERSION}"
```

### 7.2 Git Integration Configuration

```json
{
  "release": {
    "gitIntegration": {
      "enabled": true,
      "autoTag": true,
      "autoPush": false,
      "tagPrefix": "v",
      "tagMessageTemplate": "Release ${version}: ${name}\n\n${description}"
    }
  }
}
```

---

## Part 8: Error Codes (50-59)

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

---

## Part 9: Automation Hooks

### 9.1 Release Event Hooks

```json
{
  "hooks": {
    "onReleaseCreated": ["notify-team.sh"],
    "onReleaseStaged": ["run-qa-tests.sh", "generate-docs.sh"],
    "onReleaseShipped": ["deploy-production.sh", "notify-users.sh"],
    "onEpicAddedToRelease": ["update-roadmap.sh"]
  }
}
```

### 9.2 CI/CD Integration

```yaml
# GitHub Actions example
on:
  release:
    types: [created]

jobs:
  deploy:
    steps:
      - name: Verify CLEO release state
        run: |
          VERSION=${{ github.event.release.tag_name }}
          ct release verify $VERSION || exit 1

      - name: Deploy
        run: ./deploy.sh production

      - name: Update CLEO release
        run: ct release ship $VERSION
```

---

## Part 10: Conformance

### 10.1 Conformance Requirements

A conforming implementation MUST:

- Support all release lifecycle states (Part 3)
- Implement release schema (Part 2)
- Support changelog generation (Part 5)
- Support all CLI commands (Part 4)
- Use exit codes 50-59 (Part 8)

A conforming implementation SHOULD:

- Support roadmap visualization (Part 6)
- Support git integration (Part 7)
- Support automation hooks (Part 9)

A conforming implementation MAY:

- Support additional changelog formats
- Support custom tag naming conventions
- Integrate with external release tools

---

## Part 11: Related Specifications

| Document | Relationship |
|----------|--------------|
| **[IMPLEMENTATION-ORCHESTRATION-SPEC.md](IMPLEMENTATION-ORCHESTRATION-SPEC.md)** | **Upstream**: Tasks flow from implementation to release |
| **[ISSUE-LIFECYCLE-SPEC.md](ISSUE-LIFECYCLE-SPEC.md)** | **Related**: Issues fixed in releases |
| **[PROJECT-LIFECYCLE-SPEC.md](PROJECT-LIFECYCLE-SPEC.md)** | **Context**: Overall project lifecycle model |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | **AUTHORITATIVE**: JSON output standards |
| **[PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md)** | **Related**: Phase definitions |

---

## Appendix A: Quick Reference

### Release Commands

```bash
# Lifecycle
ct release create v0.42.0 --name "Feature Name"
ct release plan v0.42.0 --add T998,T999
ct release start v0.42.0
ct release stage v0.42.0
ct release ship v0.42.0

# Queries
ct release list
ct release show v0.42.0
ct release verify v0.42.0

# Changelog
ct release changelog v0.42.0 --format markdown

# Roadmap
ct roadmap
ct roadmap --format markdown
```

### Release State Flow

```
create → planned → in-progress → staging → released → deprecated
```

### Semver Rules

| Change Type | Version Bump | Example |
|-------------|--------------|---------|
| Breaking changes | Major | 1.0.0 → 2.0.0 |
| New features (backward compatible) | Minor | 1.0.0 → 1.1.0 |
| Bug fixes | Patch | 1.0.0 → 1.0.1 |
| Critical bug fix (post-release) | Hotfix | 1.0.0 → 1.0.1 |

---

## Appendix B: Version History

### Version 1.0.0 (2025-12-29)

- Initial specification
- Release lifecycle states and transitions
- Changelog generation from tasks/Epics
- Roadmap management
- Git tag integration
- Exit codes 50-59

---

*End of Specification*
