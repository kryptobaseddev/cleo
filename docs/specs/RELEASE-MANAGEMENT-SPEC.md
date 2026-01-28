# Release Management Specification

**Version**: 2.0.0
**Status**: AUTHORITATIVE
**Created**: 2025-12-29
**Updated**: 2026-01-27
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

This specification defines the **Release Management Protocol** for CLEO, covering the complete lifecycle from release planning through deployment and post-release maintenance. It integrates with the Implementation Orchestration pipeline to provide end-to-end tracking from task completion to production release.

**v2.0.0 Update**: Consolidates consensus decisions from T2539 to establish array storage, 3-state lifecycle, and dogfooding workflow as authoritative design.

### Authority

This specification is **AUTHORITATIVE** for:

- Release lifecycle states and transitions (3 states: planned/active/released)
- Release schema definition in todo.json (array storage)
- Changelog generation integration (scripts/generate-changelog.sh)
- VERSION file integration with `cleo release ship`
- Git tag integration
- Release-to-Epic/Task associations
- Exit codes 50-59 (Release Management)

This specification **SUPERSEDES**:

- `archive/specs/deprecated/RELEASE-VERSION-MANAGEMENT-SPEC.md` (archived per T2539)

This specification **DEFERS TO**:

- [IMPLEMENTATION-ORCHESTRATION-SPEC.md](IMPLEMENTATION-ORCHESTRATION-SPEC.md) for task verification
- [ISSUE-LIFECYCLE-SPEC.md](ISSUE-LIFECYCLE-SPEC.md) for bug-to-release tracking
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) for JSON output standards
- [PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md) for phase definitions

### Consensus Foundation

This specification reflects unanimous consensus on 6 critical decisions (T2539):

1. **Archive conflicting spec** - RELEASE-VERSION-MANAGEMENT-SPEC.md archived
2. **Array storage** - `releases` is an array, not object keyed by version
3. **3 states** - planned/active/released (not 4 or 5 states)
4. **VERSION integration** - `cleo release ship` calls `dev/bump-version.sh`
5. **Unified changelog** - Use `scripts/generate-changelog.sh` (single system)
6. **Dogfooding** - Developers use `cleo release` to build CLEO

### Problem Statement

After tasks are completed through the Implementation Orchestration pipeline, there is no structured process for:

1. **Aggregating completed work** into releasable units
2. **Generating changelogs** from task metadata
3. **Planning roadmaps** for future releases
4. **Tracking release state** from planning to deployment
5. **Linking releases to git tags** and deployment artifacts
6. **Bumping VERSION** in sync with release lifecycle

---

## Part 1: Architecture Overview

### 1.1 Release Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         RELEASE MANAGEMENT FLOW (v2.0)                               │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  IMPLEMENTATION COMPLETE                                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  Tasks: status = "done", verification.passed = true                           │   │
│  └──────────────────────────────────────┬───────────────────────────────────────┘   │
│                                         │                                            │
│                                         ▼                                            │
│  RELEASE PLANNING                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  cleo release create v0.74.0 --target-date 2026-02-01                         │   │
│  │  cleo release plan v0.74.0 --tasks T2536,T2537                                │   │
│  │                                                                               │   │
│  │  Release: status = "planned"                                                  │   │
│  │  Tasks: linked to release                                                     │   │
│  └──────────────────────────────────────┬───────────────────────────────────────┘   │
│                                         │                                            │
│                                         ▼                                            │
│  ACTIVE DEVELOPMENT                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  Work proceeds on linked tasks                                                │   │
│  │  Release: status = "active" (automatic when first task starts)                │   │
│  └──────────────────────────────────────┬───────────────────────────────────────┘   │
│                                         │                                            │
│                                         ▼                                            │
│  RELEASE EXECUTION                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  cleo release ship v0.74.0 --bump-version --create-tag                         │   │
│  │                                                                               │   │
│  │  Actions:                                                                     │   │
│  │  1. Auto-populate release.tasks[] (hybrid date+label discovery)              │   │
│  │  2. Generate CHANGELOG.md (lib/changelog.sh - MANDATORY)                     │   │
│  │  3. Validate changelog entry exists and is non-empty                         │   │
│  │  4. Calls dev/bump-version.sh (VERSION, README, templates)                   │   │
│  │  5. Creates git tag v0.74.0                                                   │   │
│  │  6. Sets status = "released", releasedAt = now()                              │   │
│  └──────────────────────────────────────┬───────────────────────────────────────┘   │
│                                         │                                            │
│                                         ▼                                            │
│  POST-RELEASE                                                                       │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  git push origin main --tags                                                  │   │
│  │  Bug reports → Issue Lifecycle → Hotfix releases (v0.74.1)                    │   │
│  │  Feature requests → RCSD Pipeline → Next release (v0.75.0)                    │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Release-Task Relationship

```
Release v0.74.0
├── Epic T2536: Unified Release System
│   ├── Task T2539: Consensus decisions     (status: done)
│   ├── Task T2540: Update spec             (status: done)
│   └── Task T2541: Implement features      (status: active)
├── Epic T2550: Documentation Updates
│   └── Task T2551: Update release docs     (status: pending)
└── Bugs Fixed
    ├── Task T2560: Fix version sync bug    (status: done)
    └── Task T2561: Fix tag creation        (status: done)
```

---

## Part 2: Schema Definition

### 2.1 Release Array Storage

Add to `todo.json` root:

```json
{
  "releases": {
    "type": "array",
    "description": "Release registry using array storage (consensus: T2539)",
    "items": {
      "$ref": "#/definitions/releaseDefinition"
    },
    "default": []
  }
}
```

**Rationale**: Array storage is current implementation reality (scripts/release.sh), consistent with task hierarchy patterns, and easier to filter/sort than object-keyed storage.

### 2.2 Release Definition

```json
{
  "definitions": {
    "releaseDefinition": {
      "type": "object",
      "required": ["version", "status", "createdAt"],
      "additionalProperties": false,
      "properties": {
        "version": {
          "type": "string",
          "pattern": "^v\\d+\\.\\d+\\.\\d+(-[a-z0-9.-]+)?$",
          "description": "Semver version string (e.g., v0.74.0)"
        },
        "status": {
          "type": "string",
          "enum": ["planned", "active", "released"],
          "description": "Release lifecycle state (3 states per consensus)"
        },
        "name": {
          "type": ["string", "null"],
          "maxLength": 100,
          "description": "Human-readable release name"
        },
        "description": {
          "type": ["string", "null"],
          "maxLength": 500,
          "description": "Release summary for changelog header"
        },
        "tasks": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^T\\d{3,}$"
          },
          "description": "Task IDs included in this release (populated automatically via hybrid date+label strategy or manually via --tasks flag)"
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
          "description": "Git tag reference (e.g., v0.74.0)"
        },
        "changelog": {
          "type": ["string", "null"],
          "description": "Generated CHANGELOG.md content for this release (cached)"
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

**Key Changes from v1.0**:
- **Array storage** (not object keyed by version)
- **3 states** (removed in-progress, staging, deprecated)
- **Simplified tasks array** (no separate epics/issues arrays)
- **Removed type field** (inferred from version bump)
- **Removed breakingChanges** (document in notes or changelog)

---

## Part 3: Release Lifecycle

### 3.1 State Machine (3 States)

```
                    ┌───────────────────────────────────────────────────┐
                    │          RELEASE LIFECYCLE (v2.0)                 │
                    └───────────────────────────────────────────────────┘

                              cleo release create
                    ┌───────────┐ ──────────────► ┌─────────────┐
                    │ (none)    │                 │   PLANNED   │
                    └───────────┘                 └──────┬──────┘
                                                         │
                                          auto: first task active
                                          manual: cleo release start
                                                         │
                                                         ▼
                                                  ┌─────────────┐
                                                  │   ACTIVE    │
                                                  └──────┬──────┘
                                                         │
                                                cleo release ship
                                                         │
                                                         ▼
                                                  ┌─────────────┐
                                                  │  RELEASED   │ (immutable)
                                                  └─────────────┘
```

### 3.2 State Definitions

| State | Description | Allowed Operations |
|-------|-------------|-------------------|
| `planned` | Release created, collecting tasks | Add/remove tasks, set target date, update metadata |
| `active` | Work in progress on included tasks | Add tasks, update progress, notes |
| `released` | Shipped to production (IMMUTABLE) | Read-only, cannot modify tasks |

**Removed states** (from v1.0): `in-progress` (merged into active), `staging` (unnecessary ceremony), `deprecated` (use notes field).

### 3.3 State Transition Rules

| Transition | Condition | Trigger |
|------------|-----------|---------|
| (none) → planned | User action | `cleo release create <version>` |
| planned → active | Any task starts work | Automatic or `cleo release start <version>` |
| active → released | All validation gates pass | `cleo release ship <version>` |

**Locked State**: Once `released`, the release entry is **immutable**. No task additions, no metadata changes (except appending notes).

---

## Part 4: CLI Commands

### 4.1 Release Management

```bash
# Create a new release
cleo release create <version> [OPTIONS]
  --name <string>           # Release name (e.g., "Unified Release System")
  --target-date <YYYY-MM-DD>  # Planned release date
  --description <string>    # Release summary

# Plan release contents
cleo release plan <version> [OPTIONS]
  --tasks <task-ids>        # Add tasks to release (comma-separated)
  --remove <task-ids>       # Remove tasks from release

# List releases
cleo release list [OPTIONS]
  --status <status>         # Filter by status (planned|active|released)
  --format <text|json|markdown>
  --include-tasks           # Show task details

# Show release details
cleo release show <version> [OPTIONS]
  --format <text|json|markdown>
  --include-tasks           # Show all tasks in release

# Update release state
cleo release start <version>    # planned → active (usually automatic)
cleo release ship <version> [OPTIONS]  # active → released
  --bump-version            # Call dev/bump-version.sh before tagging
  --create-tag              # Create git tag (optional, config-driven)
  --skip-changelog          # Skip changelog generation (EMERGENCY USE ONLY)
  --push                    # Push tag to remote (optional)

# Note: Changelog generation is MANDATORY by default (no flag needed)

# Verify release readiness
cleo release verify <version>
  # Checks: validation gates from protocols/release.md
  # - All tests pass (./tests/run-all-tests.sh)
  # - Schema validation (cleo validate)
  # - VERSION consistency
  # - Changelog updated

# Add release notes
cleo release note <version> <note>
```

### 4.2 VERSION Integration

When `--bump-version` flag is used with `cleo release ship`:

```bash
# 1. Call dev/bump-version.sh
./dev/bump-version.sh <new-version>

# 2. Updates:
#    - VERSION file (source of truth)
#    - README.md badge
#    - templates/*.md
#    - Syncs all version references

# 3. Validation:
#    - Ensure VERSION matches release version
#    - No uncommitted changes to VERSION-dependent files
```

**Flags**:
- `--bump-version`: Call bump script (default: prompt user)
- `--skip-version-check`: Skip VERSION consistency check (edge cases)

**Config** (`config.json`):
```json
{
  "release": {
    "autoBumpVersion": false,  # Require explicit --bump-version flag
    "validateVersion": true     # Verify VERSION matches release
  }
}
```

### 4.3 Git Tag Integration

When `--create-tag` flag is used with `cleo release ship`:

```bash
# 1. Create annotated git tag
git tag -a "v${VERSION}" -m "Release ${VERSION}: ${RELEASE_NAME}

${DESCRIPTION}

Tasks: ${TASK_IDS}"

# 2. Optional: push tag
if [[ $PUSH_TAG == true ]]; then
  git push origin "v${VERSION}"
fi
```

**Flags**:
- `--create-tag`: Create git tag (default: prompt user)
- `--push`: Push tag to remote (default: false)

**Config** (`config.json`):
```json
{
  "release": {
    "gitIntegration": {
      "enabled": true,
      "autoTag": false,      # Require explicit --create-tag
      "autoPush": false,     # Require explicit --push
      "tagPrefix": "v",
      "tagMessageTemplate": "Release ${version}: ${name}\n\n${description}\n\nTasks: ${tasks}"
    }
  }
}
```

#### Git Credential Hang Fix

**Issue**: `git push origin "$tag" 2>/dev/null` hangs on line 626 of scripts/release.sh when:
- SSH keys not configured OR
- No credential helper set

**Root cause**: Git prompts for username/password on stdin, but `2>/dev/null` hides the prompt, causing infinite wait.

**Solution** (MUST implement):

```bash
# scripts/release.sh line 626
if [[ "$PUSH_TAG" == "true" ]]; then
    log_info "Pushing tag to remote..."

    # Detect if credentials are available (non-interactive check)
    if ! git ls-remote --exit-code --tags origin >/dev/null 2>&1; then
        log_warn "Git credential check failed - remote may not be accessible"
        log_warn "Run manually: git push origin $normalized"
    else
        # Use GIT_TERMINAL_PROMPT=0 to prevent hang on credential prompt
        if ! GIT_TERMINAL_PROMPT=0 git push origin "$normalized" 2>&1; then
            log_error "Failed to push tag to remote" "E_TAG_CREATION_FAILED" "$EXIT_TAG_CREATION_FAILED" "Push manually: git push origin $normalized"
            # Don't exit - tag was created successfully locally
        else
            log_info "Tag pushed to remote"
        fi
    fi
fi
```

**Behavior**:
- `GIT_TERMINAL_PROMPT=0` prevents interactive credential prompts
- Fail fast with clear error message
- Tag still created locally (user can push manually)
- No infinite hang

### 4.4 Changelog Integration

**Decision**: T2607 consensus - Changelog generation is **MANDATORY** during `cleo release ship`

#### Two-Stage Pipeline

CLEO uses a two-stage changelog pipeline (clarified per T2539 consensus analysis):

**Stage 1: Tasks → CHANGELOG.md** (`lib/changelog.sh`)
- Input: Task metadata from `release.tasks[]`
- Transform: Categorize by labels (feature/fix/docs/refactor/test/breaking)
- Output: CHANGELOG.md entry (Keep a Changelog format)
- Trigger: `cleo release ship` (mandatory)

**Stage 2: CHANGELOG.md → Mintlify Docs** (`scripts/generate-changelog.sh`)
- Input: CHANGELOG.md (markdown)
- Transform: Parse markdown → MDX with Update components
- Output: `docs/changelog/overview.mdx`
- Trigger: `dev/release-version.sh` or manual

#### Task Association Strategy

**Hybrid date + label** (T2609 consensus - 92% confidence, 85-95% accuracy):

```bash
populate_release_tasks() {
    # Find tasks completed between prev_release and current_release
    # Filter by labels: version/changelog/release
    # Exclude epics (type != "epic")
    # See CHANGELOG-GENERATION-SPEC.md for full algorithm
}
```

**Required labels** (at least ONE):
- Version: `v0.75.0` or `0.75.0`
- Generic: `changelog` or `release`

#### Generation Behavior

```bash
# In scripts/release.sh cmd_ship():
cmd_ship() {
    local version="$1"

    # Step 1: Populate release tasks (automatic discovery)
    log_info "Discovering tasks for $version..."
    populate_release_tasks "$version"

    # Step 2: ALWAYS generate changelog (no flag needed)
    log_info "Generating changelog for $version..."
    source lib/changelog.sh
    if ! generate_changelog "$version"; then
        log_error "Changelog generation failed for $version"
        exit $EXIT_CHANGELOG_GENERATION_FAILED
    fi

    # Step 3: Validate changelog entry
    validate_release "$version"

    # Step 4: Create git tag, update status
    # ...
}
```

**Flags**:
- **REMOVED**: `--write-changelog` (was optional, now mandatory)
- **ADDED**: `--skip-changelog` (emergency escape hatch, explicit override)

**Validation Gates** (before git tag creation):
1. Changelog entry exists: `grep "^## \[v$version\]" CHANGELOG.md`
2. Entry non-empty: Content after header
3. Task IDs valid: All `(T####)` references exist in todo.json

**See**: [CHANGELOG-GENERATION-SPEC.md](CHANGELOG-GENERATION-SPEC.md) for complete specification

### 4.5 Examples

```bash
# DOGFOODING WORKFLOW (Build CLEO with CLEO)
# ============================================

# 1. Create release
cleo release create v0.74.0 --name "Unified Release System" --target-date 2026-02-01

# 2. Plan release (link tasks)
cleo release plan v0.74.0 --tasks T2536,T2537,T2539,T2540,T2541,T2542,T2543

# 3. Work proceeds (automatic state transition)
# (as tasks are completed, release status → active)

# 4. Ship release (all-in-one)
cleo release ship v0.74.0 --bump-version --create-tag

# 5. Push to GitHub
git push origin main --tags

# No need for dev/release-version.sh - CLEO builds CLEO!
```

---

## Part 5: Validation Gates

Before `cleo release ship` completes, the following gates MUST pass:

### 5.1 Required Validations

| Gate | Command | Purpose |
|------|---------|---------|
| **Tests** | `./tests/run-all-tests.sh` | All unit/integration tests pass |
| **Schema** | `cleo validate` | All JSON files valid against schemas |
| **Version** | Check VERSION file | Matches release version (if --bump-version used) |
| **Changelog** | Check CHANGELOG.md | Updated for this release (MANDATORY - always generated) |

### 5.2 Validation Protocol

```bash
# From protocols/release.md
validate_release() {
  local version=$1

  # 1. Tests
  ./tests/run-all-tests.sh || return 55

  # 2. Schema
  cleo validate || return 54

  # 3. VERSION consistency
  if [[ $BUMP_VERSION == true ]]; then
    local version_file=$(cat VERSION)
    [[ $version_file == $version ]] || return 55
  fi

  # 4. Changelog (MANDATORY - always check unless --skip-changelog)
  if [[ "${SKIP_CHANGELOG:-false}" != "true" ]]; then
    # Check entry exists
    grep -q "## \[$version\]" CHANGELOG.md || return 52

    # Check entry is not empty
    local section_content
    section_content=$(extract_changelog_section "$version")
    [[ -n "$section_content" && ! "$section_content" =~ ^[[:space:]]*$ ]] || return 52
  fi

  return 0
}
```

### 5.3 Failure Handling

If any gate fails, `cleo release ship` MUST:
- Exit with appropriate error code (50-59 range)
- NOT create git tag
- NOT set status to "released"
- Report which gate failed

---

## Part 6: Error Codes (50-59)

| Code | Constant | Meaning | Recovery |
|------|----------|---------|----------|
| 50 | `E_RELEASE_NOT_FOUND` | Release version not found | Check version, use `cleo release list` |
| 51 | `E_RELEASE_EXISTS` | Release version already exists | Use different version or update existing |
| 52 | `E_CHANGELOG_GENERATION_FAILED` | Changelog entry not found or empty | Ensure tasks labeled, run generate_changelog() |
| 53 | `E_CHANGELOG_VALIDATION_FAILED` | Invalid task IDs or format | Verify task IDs exist in todo.json |
| 54 | `E_VALIDATION_FAILED` | Schema validation failed | Run `cleo validate --fix` |
| 55 | `E_VERSION_BUMP_FAILED` | dev/bump-version.sh failed | Check VERSION file, ensure no conflicts |
| 56 | `E_TAG_CREATION_FAILED` | Git tag creation failed | Check git status, ensure tag doesn't exist |
| 57 | `E_RELEASE_LOCKED` | Released releases cannot be modified | Create new version (hotfix) |
| 58 | `E_INVALID_VERSION` | Version string doesn't match semver | Use v{major}.{minor}.{patch} format |
| 58 | `E_INVALID_TRANSITION` | Invalid release state transition | Check release status, verify workflow |
| 59 | `E_TASKS_INCOMPLETE` | Release has incomplete tasks | Complete tasks or remove from release |

**Exit Code Rationale**: Range 50-59 reserved for release management to avoid conflicts with:
- Task operations (0-22)
- Session operations (30-39)
- Research operations (70-79)

---

## Part 7: Roadmap Management

### 7.1 Roadmap Data Model

Roadmap is **computed** from releases with `status != released`:

```json
{
  "roadmap": [
    {
      "version": "v0.74.0",
      "name": "Unified Release System",
      "status": "active",
      "targetDate": "2026-02-01",
      "progress": {
        "tasksTotal": 10,
        "tasksComplete": 7,
        "percentComplete": 70
      },
      "tasks": [
        {"id": "T2536", "title": "EPIC: Unified Release System", "status": "active"},
        {"id": "T2537", "title": "Research release systems", "status": "done"}
      ]
    },
    {
      "version": "v0.75.0",
      "name": "Implementation Orchestration",
      "status": "planned",
      "targetDate": "2026-03-01",
      "progress": {
        "tasksTotal": 25,
        "tasksComplete": 0,
        "percentComplete": 0
      },
      "tasks": []
    }
  ]
}
```

### 7.2 Roadmap Commands

```bash
# Show roadmap
cleo roadmap [OPTIONS]
  --format <text|json|markdown>
  --include-completed       # Include released versions
  --horizon <months>        # How far ahead to show (default: 6)

# Set release target date
cleo release target <version> <YYYY-MM-DD>
```

---

## Part 8: Deprecation Notice

### 8.1 Archived Specification

**RELEASE-VERSION-MANAGEMENT-SPEC.md** has been archived to `archive/specs/deprecated/` per T2539 consensus.

**Rationale**: Zero implementation, conflicting design (object storage, 4 states), maintenance burden.

**Migration**: Core ideas (VERSION integration, git tags) incorporated into this spec.

### 8.2 Deprecated Development Script

**dev/release-version.sh** will be deprecated over 6-month transition period (Feb 2026 - Aug 2026).

**Replacement**: Developers MUST use `cleo release ship` for all releases (dogfooding).

**Transition Plan**:
1. Feb 2026: Add deprecation notice to dev/release-version.sh
2. Feb-Aug 2026: Both paths supported, migration encouraged
3. Aug 2026: Remove dev/release-version.sh

**Migration Example**:
```bash
# OLD (dev script)
./dev/release-version.sh v0.74.0

# NEW (dogfooding)
cleo release create v0.74.0 --name "Release Name"
cleo release plan v0.74.0 --tasks T001,T002
cleo release ship v0.74.0 --bump-version --create-tag
git push origin main --tags
```

### 8.3 Changelog Pipeline Clarification

**CORRECTION**: Per T2539 consensus analysis, `lib/changelog.sh` and `scripts/generate-changelog.sh` are **NOT competing systems**.

**Two-Stage Pipeline** (sequential, non-overlapping):

| Stage | Script | Purpose | Input → Output |
|-------|--------|---------|----------------|
| 1 | `lib/changelog.sh` | Tasks → CHANGELOG.md | Task metadata → Keep a Changelog format |
| 2 | `scripts/generate-changelog.sh` | CHANGELOG.md → Docs | Markdown → Mintlify MDX |

**Status**: BOTH scripts are active and required. No deprecation.

---

## Part 9: Conformance

### 9.1 Conformance Requirements

A conforming implementation MUST:

- Support 3-state lifecycle (planned/active/released)
- Implement array storage for releases
- Support all CLI commands (Part 4)
- Use exit codes 50-59 (Part 6)
- Support VERSION integration (Part 4.2)
- Support git tag integration (Part 4.3)
- Support changelog integration (Part 4.4)
- Implement validation gates (Part 5)

A conforming implementation SHOULD:

- Support roadmap visualization (Part 7)
- Provide helpful error messages with fix commands
- Support configuration options for automation

A conforming implementation MAY:

- Support additional changelog formats
- Support custom tag naming conventions
- Integrate with external release tools
- Add automation hooks

---

## Part 10: Related Specifications

| Document | Relationship |
|----------|--------------|
| **[IMPLEMENTATION-ORCHESTRATION-SPEC.md](IMPLEMENTATION-ORCHESTRATION-SPEC.md)** | **Upstream**: Tasks flow from implementation to release |
| **[ISSUE-LIFECYCLE-SPEC.md](ISSUE-LIFECYCLE-SPEC.md)** | **Related**: Issues fixed in releases |
| **[PROJECT-LIFECYCLE-SPEC.md](PROJECT-LIFECYCLE-SPEC.md)** | **Context**: Overall project lifecycle model |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | **AUTHORITATIVE**: JSON output standards |
| **[PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md)** | **Related**: Phase definitions |
| **protocols/release.md** | **Implementation**: Shell implementation details |

---

## Appendix A: Quick Reference

### Release Commands

```bash
# Lifecycle
cleo release create v0.74.0 --name "Release Name" --target-date 2026-02-01
cleo release plan v0.74.0 --tasks T001,T002
cleo release ship v0.74.0 --bump-version --create-tag

# Queries
cleo release list
cleo release show v0.74.0
cleo release verify v0.74.0

# Roadmap
cleo roadmap --format markdown
```

### Release State Flow

```
create → planned → active → released (immutable)
```

### Validation Gates

```
Tests → Schema → VERSION → Changelog → Ship
```

---

## Appendix B: Version History

### Version 2.0.0 (2026-01-27)

**Major update**: Consensus-driven redesign per T2539

- **BREAKING**: Array storage (not object keyed by version)
- **BREAKING**: 3 states (removed in-progress, staging, deprecated)
- **NEW**: VERSION integration via `--bump-version` flag
- **NEW**: Git tag integration via `--create-tag` flag
- **NEW**: Changelog unification (scripts/generate-changelog.sh)
- **NEW**: Validation gates from protocols/release.md
- **NEW**: Exit codes 50-59 standardized
- **NEW**: Dogfooding workflow (build CLEO with CLEO)
- **DEPRECATED**: dev/release-version.sh (6-month transition)
- **DEPRECATED**: lib/changelog.sh (replaced by generate-changelog.sh)
- **ARCHIVED**: RELEASE-VERSION-MANAGEMENT-SPEC.md

### Version 1.0.0 (2025-12-29)

- Initial specification
- 5-state lifecycle (planned/in-progress/staging/released/deprecated)
- Object-keyed storage (releases as object)
- Changelog generation from tasks
- Roadmap management
- Git tag integration

---

*End of Specification*
