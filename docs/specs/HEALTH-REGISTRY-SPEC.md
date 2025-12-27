# Health Registry System - Unified Specification v1.0

**Status**: AUTHORITATIVE - Supersedes VERSION-GUARD-SPEC.md and VERSION-GUARD-FINAL-DESIGN.md

**Created**: 2025-12-20
**Based on**: 5 challenge agent analyses + sequential thinking synthesis

---

## Executive Summary

This specification defines a **comprehensive Health Registry System** for cleo that goes beyond simple version guards to provide:

1. **Central Project Registry** - Track all initialized projects globally
2. **Health Monitoring** - 36 checks across 6 dimensions with scoring
3. **LLM-Agent-First Design** - JSON by default, structured errors, recovery hints
4. **Git Sync Support** - Cross-machine identity via project UUID

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Central Project Registry](#2-central-project-registry)
3. [Health Monitoring System](#3-health-monitoring-system)
4. [Exit Code Taxonomy](#4-exit-code-taxonomy)
5. [LLM-Agent-First Protocols](#5-llm-agent-first-protocols)
6. [Git Sync Support](#6-git-sync-support)
7. [Implementation Roadmap](#7-implementation-roadmap)
8. [Files to Create/Modify](#8-files-to-createmodify)

---

## 1. Architecture Overview

### What We're Building

```
┌─────────────────────────────────────────────────────────────────────┐
│                    HEALTH REGISTRY SYSTEM                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ~/.cleo/                                                     │
│  ├── registry/                                                       │
│  │   ├── registry.json      ← Central project registry              │
│  │   ├── registry.lock      ← Concurrent access lock                │
│  │   └── health-cache.json  ← TTL-based health cache                │
│  ├── lib/                                                            │
│  │   ├── registry.sh        ← Registry operations                   │
│  │   ├── health.sh          ← Health check engine                   │
│  │   └── validation.sh      ← Extended (existing)                   │
│  └── schemas/                                                        │
│      ├── registry.schema.json                                        │
│      └── health.schema.json                                          │
│                                                                      │
│  Per-Project (.cleo/)                                              │
│  ├── project.json           ← Project UUID + metadata               │
│  ├── todo.json              ← Extended with _meta.version           │
│  └── health-history.json    ← Local health trend data               │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Extend, Don't Replace** - Build on existing lib/validation.sh, not new files
2. **Performance First** - head+grep for fast path, jq fallback for reliability
3. **LLM-Agent-First** - JSON output by default, structured errors always
4. **Backward Compatible** - Old projects work without modification
5. **Fail Safe** - Warn by default for additive changes, block for breaking

---

## 2. Central Project Registry

### Registry Schema

**Location**: `~/.cleo/registry/registry.json`

```json
{
  "$schema": "https://cleo.dev/schemas/v1/registry.schema.json",
  "version": "1.0.0",
  "_meta": {
    "checksum": "a7b3c9d2e1f4a7b3",
    "createdAt": "2025-12-20T10:00:00Z",
    "lastUpdated": "2025-12-20T15:30:00Z",
    "totalProjects": 5,
    "healthSummary": {
      "healthy": 4,
      "degraded": 0,
      "orphaned": 1
    }
  },
  "config": {
    "storePlainPaths": true,
    "autoRegisterOnInit": true,
    "autoRegisterOnCommand": false,
    "trackAccessOnCommand": true,
    "orphanCheckDays": 30
  },
  "projects": {
    "a7b3c9d2e1f4": {
      "id": "a7b3c9d2e1f4",
      "pathHash": "a7b3c9d2e1f4",
      "path": "/home/user/projects/my-app",
      "name": "my-app",
      "displayName": "My Application",
      "initialized": {
        "at": "2025-12-01T10:00:00Z",
        "version": "0.23.1",
        "schemaVersion": "2.3.0"
      },
      "lastAccess": {
        "at": "2025-12-20T15:30:00Z",
        "command": "list",
        "version": "0.24.0"
      },
      "health": {
        "status": "healthy",
        "score": 95,
        "lastCheck": "2025-12-20T15:30:00Z",
        "issues": []
      },
      "stats": {
        "totalTasks": 45,
        "pendingTasks": 12,
        "activeTasks": 1,
        "completedTasks": 30,
        "archivedTasks": 150
      },
      "flags": {
        "isOrphan": false,
        "isFavorite": false
      }
    }
  },
  "recentlyAccessed": ["a7b3c9d2e1f4", "b8c4d0e3f5a6"],
  "favorites": ["a7b3c9d2e1f4"]
}
```

### Project ID Generation

Deterministic SHA-256 hash of canonical absolute path, truncated to 12 hex chars:

```bash
calculate_project_id() {
    local path="$1"
    local canonical_path
    canonical_path=$(realpath "$path" 2>/dev/null || echo "$path")
    echo -n "$canonical_path" | sha256sum | cut -c1-12
}
# Example: /home/user/projects/my-app → "a7b3c9d2e1f4"
```

### Project Identity (for Git Sync)

Each project gets a UUID stored in `.cleo/project.json`:

```json
{
  "projectId": "550e8400-e29b-41d4-a716-446655440000",
  "projectName": "my-awesome-app",
  "createdAt": "2025-11-01T10:00:00Z",
  "knownPaths": [
    "/home/dev/myproject",
    "/Users/dev/work/myproject"
  ]
}
```

This enables cross-machine identity - same project recognized by UUID regardless of path.

### Registration Flow

```
ct init
    │
    ▼
┌─────────────────────────────┐
│ 1. Create .cleo/ folder   │
│ 2. Generate project UUID    │
│ 3. Create project.json      │
│ 4. Calculate project ID     │
│    (SHA256 of path)         │
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│ 5. Lock registry            │
│ 6. Check existing entry     │
│    by projectId or pathHash │
│ 7. Create/update entry      │
│ 8. Atomic write registry    │
│ 9. Unlock                   │
└─────────────────────────────┘
```

### Orphan Detection

```
Health Status Flow:

    Path exists? ─────────────────────────────────────────┐
         │                                                 │
         │ YES                                             │ NO
         ▼                                                 ▼
    .cleo/todo.json exists?                    Days since last access?
         │                                                 │
    ├─ YES → HEALTHY                              ├─ < 7 days → POSSIBLY_MOVED
    │                                              ├─ < 30 days → ORPHAN_SUSPECTED
    └─ NO → DEGRADED                               └─ >= 30 days → ORPHAN_CONFIRMED
```

### Registry CLI Commands

```bash
# Query commands
ct registry list                    # List all registered projects
ct registry list --healthy          # Filter by health status
ct registry list --orphan           # Show only orphaned projects
ct registry show <id-or-path>       # Show detailed project info
ct registry show .                  # Current project's registry entry
ct registry stats                   # Aggregate stats across all

# Mutation commands
ct registry add [path]              # Register project
ct registry remove <id-or-path>     # Unregister project
ct registry clean                   # Remove confirmed orphans
ct registry clean --dry-run         # Preview removals
ct registry refresh [--all]         # Refresh cached stats

# Discovery
ct registry discover [base-path]    # Scan for unregistered projects
ct registry discover --register     # Auto-register found projects

# Aliases
ct projects                         # Alias for 'ct registry list'
ct proj                             # Short alias
```

---

## 3. Health Monitoring System

### Health Dimensions (6 Categories, 36 Checks)

| Category | Weight | Description |
|----------|--------|-------------|
| **Data Integrity (DI)** | 40% | JSON validity, checksums, schema versions, required fields |
| **Referential Integrity (RI)** | 25% | Dependencies exist, parents exist, no orphans, no cycles |
| **Semantic Integrity (SI)** | 20% | Business rules (single active task, status consistency) |
| **Session/Operational (SO)** | 5% | Stale sessions, lock files, focus consistency |
| **Backup Health (BH)** | 5% | Recent backups exist, backup validation |
| **Configuration Health (CH)** | 5% | Config validity, version compatibility |

### Complete Health Check Registry

#### Category 1: Data Integrity (DI) - 40% Weight

| ID | Check Name | Severity | Auto-Fix |
|----|------------|----------|----------|
| DI-001 | JSON Syntax Valid | CRITICAL | NO |
| DI-002 | Checksum Verification | CRITICAL | SAFE |
| DI-003 | Config Version Match | CRITICAL | SAFE |
| DI-004 | Schema Version Compatible | CRITICAL | CONDITIONAL |
| DI-005 | Required Fields Present | CRITICAL | CONDITIONAL |

#### Category 2: Referential Integrity (RI) - 25% Weight

| ID | Check Name | Severity | Auto-Fix |
|----|------------|----------|----------|
| RI-001 | Task ID Uniqueness | CRITICAL | NO |
| RI-002 | Dependency Exists | CRITICAL | CONDITIONAL |
| RI-003 | No Circular Dependencies | CRITICAL | NO |
| RI-004 | Parent Task Exists | CRITICAL | CONDITIONAL |
| RI-005 | Phase Slug Valid | WARNING | SAFE |
| RI-006 | Focus Task Exists | WARNING | SAFE |
| RI-007 | Labels Index Consistent | INFO | SAFE |

#### Category 3: Semantic Integrity (SI) - 20% Weight

| ID | Check Name | Severity | Auto-Fix |
|----|------------|----------|----------|
| SI-001 | Single Active Task | WARNING | CONDITIONAL |
| SI-002 | Single Active Phase | WARNING | CONDITIONAL |
| SI-003 | Done Tasks Have completedAt | WARNING | SAFE |
| SI-004 | Blocked Tasks Have blockedBy | WARNING | NO |
| SI-005 | Active Phases Have startedAt | WARNING | SAFE |
| SI-006 | Completed Phases Have completedAt | WARNING | SAFE |
| SI-007 | Timestamp Ordering Valid | WARNING | CONDITIONAL |
| SI-008 | No Future Timestamps | WARNING | SAFE |
| SI-009 | Hierarchy Depth Valid | WARNING | NO |
| SI-010 | Sibling Count Valid | WARNING | NO |
| SI-011 | Status Transitions Valid | INFO | N/A |
| SI-012 | CurrentPhase Matches Active | WARNING | SAFE |

#### Category 4: Session/Operational (SO) - 5% Weight

| ID | Check Name | Severity | Auto-Fix |
|----|------------|----------|----------|
| SO-001 | No Stale Sessions | WARNING | SAFE |
| SO-002 | Lock File Staleness | WARNING | SAFE |
| SO-003 | Focus Consistency | WARNING | SAFE |
| SO-004 | Session Note Present | INFO | NO |
| SO-005 | Last Session ID Valid | INFO | SAFE |

#### Category 5: Backup Health (BH) - 5% Weight

| ID | Check Name | Severity | Auto-Fix |
|----|------------|----------|----------|
| BH-001 | Recent Backup Exists | WARNING | SAFE |
| BH-002 | Backup Directory Valid | INFO | SAFE |
| BH-003 | Migration Backups Preserved | INFO | SAFE |
| BH-004 | Backup Metadata Valid | INFO | CONDITIONAL |
| BH-005 | Backup Checksums Match | WARNING | CONDITIONAL |
| BH-006 | Safety Backups Not Expired | INFO | SAFE |

#### Category 6: Configuration Health (CH) - 5% Weight

| ID | Check Name | Severity | Auto-Fix |
|----|------------|----------|----------|
| CH-001 | Config File Exists | WARNING | SAFE |
| CH-002 | Config Schema Valid | WARNING | NO |
| CH-003 | Config Version Current | INFO | CONDITIONAL |
| CH-004 | Validation Settings Sane | INFO | NO |
| CH-005 | Backup Settings Valid | INFO | SAFE |
| CH-006 | Phase Definitions Complete | INFO | SAFE |

### Health Score Calculation

```
HEALTH_SCORE = Σ (category_weight × category_score)

Category Score = 100 - (critical_failures × 25) - (warning_failures × 10) - (info_failures × 3)
                 [minimum 0]
```

**Grade Mapping:**

| Score | Grade | Status | Action |
|-------|-------|--------|--------|
| 90-100 | A | Excellent | No action needed |
| 80-89 | B | Good | Optional improvements |
| 70-79 | C | Fair | Address warnings |
| 60-69 | D | Poor | Must address issues |
| 0-59 | F | Critical | Immediate attention |

### Remediation Classification

- **SAFE** (17 checks): Apply without confirmation - idempotent, non-destructive
- **CONDITIONAL** (9 checks): Requires backup + user opt-in
- **MANUAL** (9 checks): Cannot auto-fix, human judgment required

### Health CLI Commands

```bash
# Health checks
ct health                           # Full health check (JSON output)
ct health --quick                   # Fast subset of critical checks
ct health --category schema         # Check specific category
ct health --fix                     # Preview fixes
ct health --fix --apply             # Apply safe fixes
ct health --fix --apply --force     # Apply conditional fixes (creates backup)
ct health --fix --interactive       # Prompt for each fix

# Registry-wide health
ct registry health --all            # Health check all registered projects
ct registry health --fix --all      # Batch fix all projects
```

---

## 4. Exit Code Taxonomy

### Exit Code Ranges

| Range | Category | Description |
|-------|----------|-------------|
| 0-9 | General | Standard success/failure |
| 10-19 | Hierarchy | Parent/child, depth, sibling issues |
| 20-29 | Concurrency | Lock, session, write conflicts (existing) |
| **30-39** | **Schema/Version** | Version mismatch, migration |
| **50-59** | **Health** | Health check failures |
| 100+ | Special | Internal errors |

### Schema/Version Exit Codes (30-39)

| Code | Constant | Meaning | Recoverable | Recovery Command |
|------|----------|---------|-------------|------------------|
| 30 | EXIT_SCHEMA_OUTDATED | Project schema older than CLI | Yes | `ct migrate run` |
| 31 | EXIT_SCHEMA_INCOMPATIBLE | Major version mismatch | No | Upgrade CLI or downgrade project |
| 32 | EXIT_SCHEMA_AHEAD | Project newer than CLI | Yes | Upgrade CLI |
| 33 | EXIT_SCHEMA_CORRUPT | Cannot parse version | No | Manual fix |
| 35 | EXIT_MIGRATION_IN_PROGRESS | Migration lock held | Yes | Wait/retry |
| 36 | EXIT_MIGRATION_FAILED | Migration failed | Yes | `ct restore` |

### Health Exit Codes (50-59)

| Code | Constant | Meaning | Recoverable |
|------|----------|---------|-------------|
| 50 | EXIT_HEALTH_CRITICAL | Critical health issues | Depends on issue |
| 51 | EXIT_HEALTH_WARNING | Warning-level issues | Yes |
| 52 | EXIT_HEALTH_FIXABLE | Auto-fixable issues found | Yes (`ct health --fix`) |

---

## 5. LLM-Agent-First Protocols

### JSON Output Structure

All commands output JSON when piped (non-TTY). Standard envelope:

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "version": "0.24.0",
    "command": "health",
    "timestamp": "2025-12-20T10:00:00Z",
    "executionMs": 45
  },
  "success": true,
  "data": { ... },
  "warnings": [],
  "errors": []
}
```

### Error Response Structure

```json
{
  "_meta": { ... },
  "success": false,
  "error": {
    "code": "E_SCHEMA_OUTDATED",
    "exitCode": 30,
    "message": "Project schema v2.2.0 is older than CLI v2.3.0",
    "category": "schema",
    "severity": "warning",
    "recoverable": true,
    "autoFix": true,
    "fixCommand": "ct migrate run",
    "context": {
      "projectVersion": "2.2.0",
      "cliVersion": "2.3.0",
      "breaking": false
    }
  }
}
```

### Health Check Response

```json
{
  "_meta": { ... },
  "success": true,
  "healthy": false,
  "summary": {
    "totalChecks": 36,
    "passed": 33,
    "failed": 3,
    "critical": 0,
    "warning": 2,
    "info": 1
  },
  "score": 87,
  "grade": "B",
  "trend": "stable",
  "categories": {
    "dataIntegrity": { "score": 100, "status": "pass", "checks": [...] },
    "referentialIntegrity": { "score": 95, "status": "warning", "checks": [...] }
  },
  "autoFixable": [
    {
      "checkId": "RI-006",
      "fixCommand": "ct focus clear",
      "description": "Clear invalid focus reference"
    }
  ],
  "nextAction": {
    "priority": "high",
    "command": "ct health --fix --apply",
    "reason": "2 auto-fixable issues found"
  }
}
```

### Recommended Session Protocol

```
┌─────────────────────────────────────────────────────────────────┐
│                    SESSION LIFECYCLE                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. SESSION START                                                │
│     ├── ct health --quick                                        │
│     │   └── Exit 0: Proceed                                      │
│     │   └── Exit 50+: Run auto-recovery                          │
│     │                                                            │
│  2. PRE-WRITE CHECK (write operations only)                      │
│     ├── ct health --category schema --quick                      │
│     │   └── Schema outdated? → ct migrate run                    │
│     │   └── Session conflict? → ct session end && start          │
│     │                                                            │
│  3. OPERATION                                                    │
│     ├── ct add/update/complete/...                               │
│     │   └── Success: Continue                                    │
│     │   └── Failure: Check error.recoverable                     │
│     │       └── true: Execute error.fixCommand                   │
│     │       └── false: Escalate to human                         │
│     │                                                            │
│  4. POST-FAILURE RECOVERY                                        │
│     ├── ct health --full                                         │
│     │   └── ct health --fix --apply (if safe)                    │
│     │   └── Retry original operation                             │
│     │                                                            │
│  5. SESSION END                                                  │
│     ├── ct health --quick (log warnings)                         │
│     ├── ct session end                                           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Git Sync Support

### Project UUID for Cross-Machine Identity

Projects identified by UUID (in `.cleo/project.json`), not path:

```json
{
  "projectId": "550e8400-e29b-41d4-a716-446655440000",
  "knownPaths": [
    "/home/dev/myproject",
    "/Users/dev/work/myproject"
  ]
}
```

### Custom Git Merge Driver

```bash
# .gitattributes
.cleo/todo.json merge=cleo

# Git config
git config merge.cleo.driver "cleo merge %O %A %B"
```

### Merge Strategy

Use version number + timestamp for conflict detection:

```json
{
  "_meta": {
    "version": 47,
    "lastModifiedAt": "2025-12-20T14:30:00Z"
  }
}
```

**On git merge conflict:**
1. Compare `_meta.version` - higher wins
2. Tiebreak: compare `_meta.lastModifiedAt` - more recent wins
3. If still tied: git's standard conflict markers, user resolves

**Future enhancement**: Custom git merge driver for automatic resolution.

---

## 7. Implementation Roadmap

### Phase 1: Foundation (v0.24.0)

| Task | Scope | Priority |
|------|-------|----------|
| Add `_meta.version` (increment) to todo.json | Small | P0 |
| Add `_meta.lastWriterVersion` tracking | Small | P0 |
| Add exit codes 30-39 to lib/exit-codes.sh | Small | P0 |
| Create `~/.cleo/registry/` structure | Small | P0 |
| Create lib/registry.sh with CRUD operations | Medium | P0 |
| Modify init.sh to register projects | Small | P0 |
| Add `ct registry list` command | Medium | P1 |

### Phase 2: Health System (v0.25.0)

| Task | Scope | Priority |
|------|-------|----------|
| Create lib/health.sh with 36 checks | Large | P0 |
| Add `ct health` command with JSON output | Medium | P0 |
| Implement health score calculation | Medium | P1 |
| Add `ct health --fix` with safety levels | Medium | P1 |
| Add health caching with TTL | Small | P2 |

### Phase 3: Version Guards (v0.25.0)

| Task | Scope | Priority |
|------|-------|----------|
| Add fast_version_check to wrapper | Medium | P0 |
| Add validate_version_with_policy to validation.sh | Medium | P0 |
| Integrate version check in write scripts | Medium | P0 |
| Add CLEO_VERSION_CHECK env override | Small | P1 |
| Add config: migration.policy, migration.checkOnWrite | Small | P1 |

### Phase 4: Git Sync (v0.26.0)

| Task | Scope | Priority |
|------|-------|----------|
| Add project UUID to .cleo/project.json | Small | P1 |
| Add custom git merge driver | Medium | P2 |
| Add registry reconciliation | Medium | P2 |

### Phase 5: Scalability (v0.27.0)

| Task | Scope | Priority |
|------|-------|----------|
| Add sharded registry (50+ projects) | High | P3 |
| Add SQLite backend (500+ projects) | High | P3 |
| Add `ct registry gc` command | Medium | P3 |

---

## 8. Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `lib/registry.sh` | Registry CRUD operations |
| `lib/health.sh` | Health check engine |
| `scripts/registry.sh` | Registry command handler |
| `scripts/health.sh` | Health command handler |
| `schemas/registry.schema.json` | Registry JSON schema |
| `schemas/health.schema.json` | Health output JSON schema |
| `templates/registry.template.json` | Empty registry template |
| `templates/project.template.json` | Project identity template |

### Modified Files

| File | Changes |
|------|---------|
| `lib/exit-codes.sh` | Add exit codes 30-59 |
| `lib/validation.sh` | Add validate_version_with_policy() |
| `scripts/init.sh` | Add project registration, create project.json |
| `install.sh` | Create registry directory, add registry command |
| `schemas/todo.schema.json` | Add _meta.version, lastModifiedBy |
| `schemas/config.schema.json` | Add migration.policy, migration.checkOnWrite |
| `scripts/add-task.sh` | Add version check after lock |
| `scripts/update-task.sh` | Add version check after lock |
| `scripts/complete-task.sh` | Add version check after lock |
| `scripts/archive.sh` | Add version check after lock |
| Wrapper script | Add fast_version_check() |

---

## Appendix A: Gap Resolutions

Issues identified by Spec Challenge Agent and resolutions:

| Gap | Resolution |
|-----|------------|
| head+grep fragility | Add jq fallback: `grep ... \|\| jq ...` |
| Exit code 25 arbitrary | Use semantic range 30-39 |
| Multi-file version consistency | Add cross-file check before archive ops |
| "Project ahead" should block | Changed to block, not warn |
| Incomplete WRITE_COMMANDS | Audit: add restore, config set |
| lastWriterVersion uses jq | Embed in atomic write jq call |
| Error recovery missing | Added rollback via `ct restore` |
| Plugin integration | Documented as "not supported in v1" |

---

## Appendix B: Superseded Documents

This specification supersedes:

1. `docs/specs/VERSION-GUARD-SPEC.md` - Original proposal (contradicted by challenge agents)
2. `docs/specs/VERSION-GUARD-FINAL-DESIGN.md` - Refined but narrow (version-only focus)

The above documents should be marked with:
```markdown
> **SUPERSEDED**: This document has been superseded by [HEALTH-REGISTRY-SPEC.md](./HEALTH-REGISTRY-SPEC.md)
```

---

## Appendix C: Success Criteria

1. **Performance**: < 5ms for fast version check, < 100ms for full health
2. **Safety**: No data corruption on version mismatch
3. **UX**: Clear, actionable JSON messages for LLM consumption
4. **Compatibility**: Existing scripts/automation continue to work
5. **Testability**: All new code has unit + integration tests
6. **Coverage**: 36 health checks across all data integrity dimensions

---

*Document version: 1.0.0*
*Generated by: Sequential thinking + 5 challenge agents synthesis*
