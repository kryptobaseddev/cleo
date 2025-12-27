# Specification Index

> **GENERATED FILE** - This markdown is generated from [`SPEC-INDEX.json`](SPEC-INDEX.json).
> For programmatic access, use the JSON file directly.

**Purpose**: Human-readable view of the specification catalog
**Last Updated**: 2025-12-19
**Total Specifications**: 14 | **Implementation Reports**: 6
**Index Version**: 1.0.0

---

## LLM Agent Usage (Preferred)

```bash
# Query authoritative source for a domain
jq '.authorities["task-ids"]' docs/specs/SPEC-INDEX.json
# → "LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md"

# List all IMMUTABLE specs
jq '.specs[] | select(.status == "IMMUTABLE") | .file' docs/specs/SPEC-INDEX.json

# Get dependencies for a spec
jq '.specs[] | select(.file == "TASK-HIERARCHY-SPEC.md") | .dependsOn' docs/specs/SPEC-INDEX.json

# Find specs by domain
jq '.specs[] | select(.domain == "phase-lifecycle")' docs/specs/SPEC-INDEX.json

# Get implementation progress
jq '.reports[] | {file, progress, notes}' docs/specs/SPEC-INDEX.json
```

### Why JSON?

| Aspect | JSON | Markdown |
|--------|------|----------|
| Parsing | `jq`, native | Regex, heuristics |
| Validation | Schema-enforced | None |
| Queries | Structured (`select`, `map`) | Text search |
| Updates | Programmatic | Manual editing |
| Token efficiency | Compact | Formatting overhead |

---

## Human Navigation

### For Developers
1. Start with **Status** to understand document maturity
2. Check **Synopsis** for quick understanding
3. Follow **Implementation Report** links for current progress

---

## Quick Reference

### Spec Status Legend

| Status | Meaning | Can Change | When to Use |
|--------|---------|------------|-------------|
| **IMMUTABLE** | Locked forever, authoritative reference | NEVER | Permanent design decisions |
| **ACTIVE** | Current design, may evolve carefully | Yes (versioned) | Evolving features |
| **APPROVED** | Endorsed for implementation | Yes (formal amendments) | Stable designs |
| **DRAFT** | Work in progress | Yes (freely) | New designs under review |
| **DEPRECATED** | Historical only, superseded | No | Legacy reference |

### Document Type Legend

| Type | Purpose | Contains |
|------|---------|----------|
| **SPEC** | Requirements and contracts | WHAT system does |
| **IMPLEMENTATION-REPORT** | Progress tracking | Status, checklists, % |
| **GUIDELINES** | Standards and best practices | HOW to write specs |
| **PLAN** | Implementation strategy | Sequencing, tasks |

### Status Distribution

| Status | Count | Documents |
|--------|-------|-----------|
| **IMMUTABLE** | 2 | SPEC-BIBLE-GUIDELINES, LLM-TASK-ID-SYSTEM-DESIGN-SPEC |
| **ACTIVE** | 5 | LLM-AGENT-FIRST, CONFIG-SYSTEM, FILE-LOCKING, PHASE-SYSTEM, TODOWRITE-SYNC |
| **APPROVED** | 1 | HIERARCHY-ENHANCEMENT |
| **DRAFT** | 2 | FIND-COMMAND, RELEASE-VERSION-MANAGEMENT |
| **PLANNING** | 1 | LLM-AGENT-FIRST-FINALIZATION-PLAN |
| **IMPLEMENTED** | 3 | PHASE-DELETE, PHASE-RENAME, PHASE-ROLLBACK |

---

## All Specifications

### Core System Specifications

| Document | Version | Status | Last Updated | Synopsis |
|----------|---------|--------|--------------|----------|
| [**SPEC-BIBLE-GUIDELINES.md**](SPEC-BIBLE-GUIDELINES.md) | 1.0.0 | **IMMUTABLE** | 2025-12-17 | Authoritative standards for writing specifications. Defines SPEC vs IMPLEMENTATION-REPORT separation, RFC 2119 usage, status lifecycle. |
| [**LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md**](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) | 1.0.0 FINAL | **IMMUTABLE** | 2025-01-17 | Task ID system design (T001 format). Flat sequential IDs with parentId for hierarchy. Six guarantees: unique, immutable, stable, sequential, referenceable, recoverable. |
| [**LLM-AGENT-FIRST-SPEC.md**](LLM-AGENT-FIRST-SPEC.md) | 3.0 | **ACTIVE** | 2025-12-18 | CLI design standard for LLM agents. JSON output by default, TTY auto-detection, 32 commands, standardized exit/error codes, universal flags. |
| [**PHASE-SYSTEM-SPEC.md**](PHASE-SYSTEM-SPEC.md) | v2.2.0+ | **ACTIVE** | 2025-12-17 | Dual-level phase model: project lifecycle phases vs task categorization. Defines phase transitions, history, validation rules. |
| [**CONFIG-SYSTEM-SPEC.md**](CONFIG-SYSTEM-SPEC.md) | 1.0.0 | **ACTIVE** | 2025-12-19 | Configuration system with global (~/.cleo/config.json) and project (.cleo/config.json) configs. Priority resolution, environment variables. |
| [**FILE-LOCKING-SPEC.md**](FILE-LOCKING-SPEC.md) | 1.0.0 | **ACTIVE** | 2025-12-19 | File locking & concurrency safety. Exclusive locks via flock, 30s timeout, atomic write operations, error recovery. |

### Feature Specifications

| Document | Version | Status | Last Updated | Synopsis |
|----------|---------|--------|--------------|----------|
| [**TASK-HIERARCHY-SPEC.md**](TASK-HIERARCHY-SPEC.md) | 1.2.0 | **APPROVED** | 2025-01-17 | Epic → Task → Subtask taxonomy with max depth 3, max 7 siblings. Flat ID + parentId design. Schema v2.3.0. |
| [**TODOWRITE-SYNC-SPEC.md**](TODOWRITE-SYNC-SPEC.md) | 1.0.0 | **ACTIVE** | 2025-12-18 | Bidirectional sync between cleo (durable) and Claude Code TodoWrite (ephemeral). Lossy by design with ID preservation via [T###] prefix. |
| [**FIND-COMMAND-SPEC.md**](FIND-COMMAND-SPEC.md) | 1.0 | **DRAFT** | 2025-12-18 | Fuzzy task search command. Context reduction 355KB→1KB (99.7%). ID prefix matching, match scoring, minimal output. |
| [**RELEASE-VERSION-MANAGEMENT-SPEC.md**](RELEASE-VERSION-MANAGEMENT-SPEC.md) | 2.0.0 | **DRAFT** | 2025-12-18 | Release version tracking with 4-state lifecycle (planning→development→released/cancelled). VERSION file integration, git tags. |

### Planning Documents

| Document | Version | Status | Last Updated | Synopsis |
|----------|---------|--------|--------------|----------|
| [**LLM-AGENT-FIRST-FINALIZATION-PLAN.md**](LLM-AGENT-FIRST-FINALIZATION-PLAN.md) | - | **PLANNING** | 2025-12-18 | Addresses 47 findings from 5 adversarial agents. 4 phases (P0-P3) with 28 tasks. Performance (689 jq calls→~50), test coverage (0%→80%). |

### Phase Implementation Guides

| Document | Version | Status | Last Updated | Synopsis |
|----------|---------|--------|--------------|----------|
| [**PHASE-DELETE-IMPLEMENTATION.md**](PHASE-DELETE-IMPLEMENTATION.md) | - | **IMPLEMENTED** | v0.16.0+ | `phase delete` command with orphan prevention, force flag, task reassignment. |
| [**PHASE-RENAME-IMPLEMENTATION.md**](PHASE-RENAME-IMPLEMENTATION.md) | - | **IMPLEMENTED** | v0.16.0+ | Atomic phase rename with task reference updates and rollback safety. |
| [**PHASE-ROLLBACK-IMPLEMENTATION.md**](PHASE-ROLLBACK-IMPLEMENTATION.md) | - | **IMPLEMENTED** | v0.14.0 | Rollback detection with --rollback flag, interactive confirmation, JSON mode. |

---

## Implementation Reports

| Specification | Implementation Report | Progress | Notes |
|---------------|----------------------|----------|-------|
| LLM-AGENT-FIRST-SPEC | [LLM-AGENT-FIRST-IMPLEMENTATION-REPORT.md](LLM-AGENT-FIRST-IMPLEMENTATION-REPORT.md) | **100%** | All 32 commands have complete `_meta` envelopes |
| TODOWRITE-SYNC-SPEC | [TODOWRITE-SYNC-IMPLEMENTATION-REPORT.md](TODOWRITE-SYNC-IMPLEMENTATION-REPORT.md) | 85% | 16/18 core features complete, v1 stable |
| FILE-LOCKING-SPEC | [FILE-LOCKING-IMPLEMENTATION-REPORT.md](FILE-LOCKING-IMPLEMENTATION-REPORT.md) | ~70% | Core done, script integration partial |
| CONFIG-SYSTEM-SPEC | [CONFIG-SYSTEM-IMPLEMENTATION-REPORT.md](CONFIG-SYSTEM-IMPLEMENTATION-REPORT.md) | ~60% | 8/14 components complete (T382 epic) |
| LLM-TASK-ID-SYSTEM-DESIGN-SPEC | [LLM-TASK-ID-SYSTEM-DESIGN-IMPLEMENTATION-REPORT.md](LLM-TASK-ID-SYSTEM-DESIGN-IMPLEMENTATION-REPORT.md) | Varies | ID system works, hierarchy pending |
| RELEASE-VERSION-MANAGEMENT-SPEC | [RELEASE-VERSION-MANAGEMENT-IMPLEMENTATION-REPORT.md](RELEASE-VERSION-MANAGEMENT-IMPLEMENTATION-REPORT.md) | 0% | Research complete, v0.20.0 target |

---

## Domain Authority Map

> **What is this?** Declares which specification is the AUTHORITATIVE source for each domain.
> When specs conflict, defer to the authoritative source.

| Domain | Authoritative Spec | Defers To |
|--------|-------------------|-----------|
| **Task IDs** | [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) | - |
| **Specification Writing** | [SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md) | - |
| **LLM-First Design** | [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) | SPEC-BIBLE-GUIDELINES for spec structure |
| **Phase Lifecycle** | [PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md) | LLM-TASK-ID-SYSTEM-DESIGN-SPEC for ID handling |
| **Task Hierarchy** | [TASK-HIERARCHY-SPEC.md](TASK-HIERARCHY-SPEC.md) | LLM-TASK-ID-SYSTEM-DESIGN-SPEC for ID contract |
| **TodoWrite Sync** | [TODOWRITE-SYNC-SPEC.md](TODOWRITE-SYNC-SPEC.md) | LLM-TASK-ID-SYSTEM-DESIGN-SPEC for IDs, PHASE-SYSTEM-SPEC for phases |
| **Configuration** | [CONFIG-SYSTEM-SPEC.md](CONFIG-SYSTEM-SPEC.md) | - |
| **File Operations** | [FILE-LOCKING-SPEC.md](FILE-LOCKING-SPEC.md) | - |
| **Versioning** | [RELEASE-VERSION-MANAGEMENT-SPEC.md](RELEASE-VERSION-MANAGEMENT-SPEC.md) | - |
| **Search** | [FIND-COMMAND-SPEC.md](FIND-COMMAND-SPEC.md) | LLM-TASK-ID-SYSTEM-DESIGN-SPEC for ID validation |

---

## Specification Dependencies

### Dependency Graph

```
SPEC-BIBLE-GUIDELINES.md (Meta-level authority)
    │
    ├─► All specifications follow these guidelines
    │
    └─► LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md (ID authority - IMMUTABLE)
            │
            ├─► PHASE-SYSTEM-SPEC.md
            │       ├─► PHASE-DELETE-IMPLEMENTATION.md
            │       ├─► PHASE-RENAME-IMPLEMENTATION.md
            │       └─► PHASE-ROLLBACK-IMPLEMENTATION.md
            │
            ├─► TASK-HIERARCHY-SPEC.md
            │       └─► Depends on: flat ID + parentId design
            │
            ├─► TODOWRITE-SYNC-SPEC.md
            │       └─► Depends on: ID format, PHASE-SYSTEM-SPEC
            │
            └─► FIND-COMMAND-SPEC.md
                    └─► Depends on: ID validation patterns

LLM-AGENT-FIRST-SPEC.md (Design philosophy)
    │
    └─► Influences: all command implementations

FILE-LOCKING-SPEC.md (Infrastructure)
    │
    └─► Depended on by: all write operations

CONFIG-SYSTEM-SPEC.md (Infrastructure)
    │
    └─► Provides config for: all features
```

### Dependency Table

| Specification | Depends On | Depended On By |
|---------------|------------|----------------|
| SPEC-BIBLE-GUIDELINES | - | All specs (meta) |
| LLM-TASK-ID-SYSTEM-DESIGN-SPEC | - | PHASE-SYSTEM, HIERARCHY, TODOWRITE-SYNC, FIND-COMMAND |
| PHASE-SYSTEM-SPEC | LLM-TASK-ID-SYSTEM-DESIGN-SPEC | TODOWRITE-SYNC, phase implementation guides |
| TASK-HIERARCHY-SPEC | LLM-TASK-ID-SYSTEM-DESIGN-SPEC | - |
| TODOWRITE-SYNC-SPEC | LLM-TASK-ID-SYSTEM-DESIGN-SPEC, PHASE-SYSTEM | - |
| CONFIG-SYSTEM-SPEC | - | All features (config provider) |
| FILE-LOCKING-SPEC | - | All write operations |
| LLM-AGENT-FIRST-SPEC | SPEC-BIBLE-GUIDELINES | All command implementations |
| FIND-COMMAND-SPEC | LLM-TASK-ID-SYSTEM-DESIGN-SPEC | - |
| RELEASE-VERSION-MANAGEMENT-SPEC | - | All deliverables |

---

## Specifications by Category

### Design Philosophy
- [SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md) - Specification writing standards
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) - Agent-optimized design principles

### Core Systems
- [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) - Task identification
- [FILE-LOCKING-SPEC.md](FILE-LOCKING-SPEC.md) - Concurrency and atomicity
- [CONFIG-SYSTEM-SPEC.md](CONFIG-SYSTEM-SPEC.md) - Configuration management

### Task Management
- [TASK-HIERARCHY-SPEC.md](TASK-HIERARCHY-SPEC.md) - Epic/Task/Subtask structure
- [PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md) - Phase lifecycle
- [FIND-COMMAND-SPEC.md](FIND-COMMAND-SPEC.md) - Task search

### Integration
- [TODOWRITE-SYNC-SPEC.md](TODOWRITE-SYNC-SPEC.md) - Claude Code integration

### Process
- [RELEASE-VERSION-MANAGEMENT-SPEC.md](RELEASE-VERSION-MANAGEMENT-SPEC.md) - Versioning and releases

---

## Specifications by Status

### IMMUTABLE (Locked Forever)
- [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) - v1.0.0 FINAL
- [SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md) - v1.0.0

### ACTIVE (Current, May Evolve)
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) - v3.0
- [PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md) - v2.2.0+
- [CONFIG-SYSTEM-SPEC.md](CONFIG-SYSTEM-SPEC.md) - v1.0.0
- [FILE-LOCKING-SPEC.md](FILE-LOCKING-SPEC.md) - v1.0.0
- [TODOWRITE-SYNC-SPEC.md](TODOWRITE-SYNC-SPEC.md) - v1.0.0

### APPROVED (Endorsed, Formal Amendments)
- [TASK-HIERARCHY-SPEC.md](TASK-HIERARCHY-SPEC.md) - v1.2.0

### DRAFT (Work in Progress)
- [FIND-COMMAND-SPEC.md](FIND-COMMAND-SPEC.md) - v1.0
- [RELEASE-VERSION-MANAGEMENT-SPEC.md](RELEASE-VERSION-MANAGEMENT-SPEC.md) - v2.0.0

---

## Recent Changes Log

> **Maintenance**: Add entries when specs are created, updated, or status changes.
> Keep last 20 entries.

| Date | Specification | Change | Version | Description |
|------|--------------|--------|---------|-------------|
| 2025-12-19 | SPEC-INDEX.md | Created | 1.0.0 | Initial specification index |
| 2025-12-19 | CONFIG-SYSTEM-SPEC | Updated | 1.0.0 | Status updated |
| 2025-12-19 | FILE-LOCKING-SPEC | Updated | 1.0.0 | Status updated |
| 2025-12-18 | LLM-AGENT-FIRST-SPEC | Updated | 3.0 | Compliance scoring rubric |
| 2025-12-18 | TODOWRITE-SYNC-SPEC | Updated | 1.0.0 | v1 stable release |
| 2025-12-18 | FIND-COMMAND-SPEC | Created | 1.0 | New search command spec |
| 2025-12-18 | RELEASE-VERSION-MANAGEMENT-SPEC | Updated | 2.0.0 | Research complete |
| 2025-12-17 | SPEC-BIBLE-GUIDELINES | Finalized | 1.0.0 | Set to IMMUTABLE |
| 2025-12-17 | PHASE-SYSTEM-SPEC | Updated | v2.2.0+ | Phase lifecycle commands |
| 2025-12-17 | LLM-TASK-ID-SYSTEM-DESIGN-SPEC | Finalized | 1.0.0 | Set to IMMUTABLE |
| 2025-01-17 | TASK-HIERARCHY-SPEC | Updated | 1.2.0 | Schema v2.3.0 |

---

## How to Add a New Specification

### Process

1. **Create the specification**
   - Use template from [SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)
   - Follow naming: `[DOMAIN]-SPEC.md` or `[DOMAIN]-[FEATURE]-SPEC.md`
   - Set initial status to **DRAFT**

2. **Create implementation report (optional)**
   - Use template from SPEC-BIBLE-GUIDELINES Part 8
   - Naming: `[SPEC-NAME]-IMPLEMENTATION-REPORT.md`

3. **Update this index**
   - Add entry to appropriate "All Specifications" table
   - Add to "Domain Authority Map" if authoritative
   - Add to "Specification Dependencies" if dependencies exist
   - Add to "Recent Changes Log"
   - Add to appropriate "By Category" section
   - Add to "By Status" section

### Checklist

- Specification file created following SPEC-BIBLE-GUIDELINES
- Implementation report created (if tracking needed)
- Added to "All Specifications" table with synopsis
- Domain authority declared (if authoritative)
- Dependencies documented
- Recent changes log entry added
- Categorized by domain and status
- Cross-referenced in main INDEX.md

---

## Critical Documents for Development

### Must-Read for Any Changes

1. **SPEC-BIBLE-GUIDELINES.md** - How to write/update specs
2. **LLM-AGENT-FIRST-SPEC.md** - All CLI output requirements
3. **LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md** - ID system rules (NEVER change)

### Implementation References

- **LLM-AGENT-FIRST-IMPLEMENTATION-REPORT.md** - Current compliance status
- **CONFIG-SYSTEM-IMPLEMENTATION-REPORT.md** - Config work tracking
- **FILE-LOCKING-IMPLEMENTATION-REPORT.md** - Locking work tracking

---

## Related Documentation

| Document | Purpose |
|----------|---------|
| [../INDEX.md](../INDEX.md) | Main documentation index |
| [../architecture/ARCHITECTURE.md](../architecture/ARCHITECTURE.md) | System architecture |
| [../QUICK-REFERENCE.md](../QUICK-REFERENCE.md) | Developer reference |

---

*Last validated: 2025-12-19*
