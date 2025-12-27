# Layer Reorganization Plan

**Purpose**: Document planned library layer reorganization to resolve same-layer dependencies
**Authority**: Derived from [LIBRARY-ARCHITECTURE-SPEC.md](LIBRARY-ARCHITECTURE-SPEC.md)
**Status**: IN PROGRESS
**Related**: [LIBRARY-ARCHITECTURE-IMPLEMENTATION-REPORT.md](LIBRARY-ARCHITECTURE-IMPLEMENTATION-REPORT.md)
**Last Updated**: 2025-12-24

---

## Executive Summary

The current Layer 2 violates the architecture specification by containing same-layer dependencies:
- `backup.sh` → `file-ops.sh`, `validation.sh`, `logging.sh` (all L2)
- `logging.sh` → `file-ops.sh` (L2→L2)
- `migrate.sh` → `logging.sh` (L2→L2)
- `validation.sh` → `hierarchy.sh` (L2→L2)

**Solution**: Promote three libraries from Layer 2 to Layer 1:
1. `file-ops.sh` → Layer 1 (already sources atomic-write.sh L1)
2. `logging.sh` → Layer 1 (will use atomic-write.sh)
3. `hierarchy.sh` → Layer 1 (only needs exit-codes, config)

This eliminates all L2→L2 dependencies while maintaining downward-flow architecture.

---

## Problem Statement

### Current Layer 2 Same-Layer Violations

| From | To | Type | Issue |
|------|-----|------|-------|
| `backup.sh` | `file-ops.sh` | L2→L2 | Direct dependency on operations layer |
| `backup.sh` | `validation.sh` | L2→L2 | Validation sourced by backup |
| `backup.sh` | `logging.sh` | L2→L2 | Logging sourced by backup |
| `logging.sh` | `file-ops.sh` | L2→L2 | Circular via backup → logging → file-ops |
| `migrate.sh` | `logging.sh` | L2→L2 | Same-layer logging dependency |
| `validation.sh` | `hierarchy.sh` | L2→L2 | Same-layer hierarchy dependency |

### Architecture Spec Violation

From [LIBRARY-ARCHITECTURE-SPEC.md](LIBRARY-ARCHITECTURE-SPEC.md):

> Layer 2 (Operations): MAY source Layers 0, 1 only

Current reality: Layer 2 sources Layer 2 (violation).

### Impact Assessment

- **Complexity**: Same-layer dependencies create coupling within what should be independent operations
- **Testability**: L2→L2 dependencies make unit testing individual operations difficult
- **Maintenance**: Refactoring one L2 library risks breaking others
- **Architecture Clarity**: Layer boundaries become meaningless when not enforced

---

## Proposed Solution

### Libraries to Promote

| Library | Current | Target | Rationale | Dependencies |
|---------|---------|--------|-----------|--------------|
| `file-ops.sh` | L2 | L1 | Uses `atomic-write.sh` (L1), provides core file primitives needed by all layers | `atomic-write.sh` (L1), `config.sh` (L1), `exit-codes.sh` (L0) |
| `logging.sh` | L2 | L1 | Provides audit logging used by all layers, will use `atomic-write.sh` (L1) | `atomic-write.sh` (L1), `config.sh` (L1), `exit-codes.sh` (L0) |
| `hierarchy.sh` | L2 | L1 | Only needs Layer 0 (`exit-codes.sh`) and Layer 1 (`config.sh`), used by validation layer | `config.sh` (L1), `exit-codes.sh` (L0) |

### Resulting Architecture

#### Layer 0 (Foundation) - 3 files
No changes
- `exit-codes.sh` - Exit codes and constants
- `platform-compat.sh` - Platform detection
- `version.sh` - Version constants

#### Layer 1 (Core Infrastructure) - 9 files
**PROMOTED**: file-ops.sh, hierarchy.sh, logging.sh
- `atomic-write.sh` - Primitive file write operations (L1)
- `config.sh` - Configuration management
- `dependency-check.sh` - Dependency validation
- `error-json.sh` - JSON error formatting
- **`file-ops.sh`** [PROMOTED from L2]
- **`hierarchy.sh`** [PROMOTED from L2]
- `jq-helpers.sh` - jq utility functions
- **`logging.sh`** [PROMOTED from L2]
- `output-format.sh` - Output formatting

#### Layer 2 (Core Operations) - 4 files
**PURGED L2→L2**: backup.sh, cache.sh, migrate.sh, validation.sh
- `backup.sh` - Backup management (only sources L0, L1)
- `cache.sh` - Caching layer
- `migrate.sh` - Schema migrations (only sources L0, L1)
- `validation.sh` - JSON validation (only sources L0, L1)

#### Layer 3 (Domain Logic) - 7 files
No changes
- `analysis.sh` - Task analysis
- `archive-cancel.sh` - Archive operations
- `cancel-ops.sh` - Task cancellation
- `delete-preview.sh` - Deletion preview
- `deletion-strategy.sh` - Deletion logic
- `phase-tracking.sh` - Phase management
- `todowrite-integration.sh` - TodoWrite sync

### Dependency Flow After Reorganization

```
┌─────────────────────────────────────────────────────┐
│ LAYER 3: Domain Logic (7 files)                     │
│  Sources: L0, L1, L2 only                           │
│  ✓ No same-layer dependencies                       │
└─────────────────────────────────────────────────────┘
                      ↓ sources
┌─────────────────────────────────────────────────────┐
│ LAYER 2: Core Operations (4 files)                  │
│  backup.sh, cache.sh, migrate.sh, validation.sh     │
│  Sources: L0, L1 only                               │
│  ✓ PURGED all L2→L2 dependencies                    │
└─────────────────────────────────────────────────────┘
                      ↓ sources
┌─────────────────────────────────────────────────────┐
│ LAYER 1: Core Infrastructure (9 files)              │
│  file-ops.sh [PROMOTED], logging.sh [PROMOTED],     │
│  hierarchy.sh [PROMOTED], + 6 existing files        │
│  Sources: L0 only                                   │
│  ✓ No same-layer dependencies (enforced)            │
└─────────────────────────────────────────────────────┘
                      ↓ sources
┌─────────────────────────────────────────────────────┐
│ LAYER 0: Foundation (3 files)                       │
│  exit-codes.sh, platform-compat.sh, version.sh      │
│  Sources: None (no dependencies)                    │
│  ✓ Zero dependencies (enforced)                     │
└─────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Atomic Write Library (T818-T822) [COMPLETED]

- [x] T818: Create `lib/atomic-write.sh` (Layer 1)
- [x] T819: Update `file-ops.sh` to source `atomic-write.sh`
- [x] T820: Update `validation.sh` to source `atomic-write.sh`
- [x] T821: Update `migrate.sh` to source `atomic-write.sh`
- [x] T822: Verify circular dependencies resolved

### Phase 2: Promote file-ops.sh (T850) [PENDING]

**Task**: Promote `file-ops.sh` from Layer 2 to Layer 1

Steps:
1. Update layer header in `lib/file-ops.sh`: `# LAYER: 1` (was `# LAYER: 2`)
2. Verify dependencies are Layer 0 or Layer 1 only
3. Update LIBRARY-ARCHITECTURE-IMPLEMENTATION-REPORT.md
4. Run: `./tests/run-all-tests.sh`
5. Commit: `chore(layers): Promote file-ops.sh to Layer 1`

### Phase 3: Promote logging.sh (T850) [PENDING]

**Task**: Promote `logging.sh` from Layer 2 to Layer 1

Steps:
1. Update layer header in `lib/logging.sh`: `# LAYER: 1` (was `# LAYER: 2`)
2. Verify dependencies are Layer 0 or Layer 1 only
3. Confirm `logging.sh` uses `atomic-write.sh` (L1) not `file-ops.sh` directly
4. Update LIBRARY-ARCHITECTURE-IMPLEMENTATION-REPORT.md
5. Run: `./tests/run-all-tests.sh`
6. Commit: `chore(layers): Promote logging.sh to Layer 1`

### Phase 4: Promote hierarchy.sh (T850) [PENDING]

**Task**: Promote `hierarchy.sh` from Layer 2 to Layer 1

Steps:
1. Update layer header in `lib/hierarchy.sh`: `# LAYER: 1` (was `# LAYER: 2`)
2. Verify dependencies are Layer 0 or Layer 1 only (should be config.sh, exit-codes.sh)
3. Remove any references to `file-ops.sh`, `logging.sh`, `backup.sh` if present
4. Update LIBRARY-ARCHITECTURE-IMPLEMENTATION-REPORT.md
5. Run: `./tests/run-all-tests.sh`
6. Commit: `chore(layers): Promote hierarchy.sh to Layer 1`

### Phase 5: Fix Remaining L2 Same-Layer Dependencies (T851-T853) [PENDING]

**T851: Fix backup.sh layer violations**
- Currently: `backup.sh` (L2) sources `file-ops.sh` (L2), `validation.sh` (L2), `logging.sh` (L2)
- After promotions: `backup.sh` (L2) sources `file-ops.sh` (L1), `validation.sh` (L2), `logging.sh` (L1)
- Remaining issue: `backup.sh` → `validation.sh` (L2→L2)
- Resolution: Refactor `backup.sh` to not directly source `validation.sh`; move validation logic to L1

**T852: Fix validation.sh layer violations**
- Currently: `validation.sh` (L2) sources `hierarchy.sh` (L2)
- After promotions: `validation.sh` (L2) sources `hierarchy.sh` (L1)
- Result: ✓ RESOLVED by promotion

**T853: Fix migrate.sh layer violation**
- Currently: `migrate.sh` (L2) sources `logging.sh` (L2)
- After promotions: `migrate.sh` (L2) sources `logging.sh` (L1)
- Result: ✓ RESOLVED by promotion

### Phase 6: Compliance Verification (T854-T855) [PENDING]

**T854: Create LAYER-MAP.md**
- Document final layer structure with all libraries listed
- Include dependency matrix
- Verify all constraints met

**T855: Final compliance verification**
- Run comprehensive layer check
- Verify no L2→L2, L1→L1 dependencies
- Update LIBRARY-ARCHITECTURE-IMPLEMENTATION-REPORT.md with final status

---

## Validation Criteria

After all phases complete, the following MUST be true:

### Metric Targets

| Metric | Target | Validation |
|--------|--------|-----------|
| L2→L2 dependencies | 0 | Dependency scan shows zero L2→L2 links |
| L1→L1 dependencies | 0 | Dependency scan shows zero L1→L1 links |
| Max deps per library | ≤3 | All libraries have ≤3 direct dependencies |
| Layer 0 files with deps | 0 | exit-codes.sh, platform-compat.sh, version.sh have zero deps |
| Circular dependency chains | 0 | No cycles in dependency graph |

### Test Requirements

- All unit tests pass: `./tests/run-all-tests.sh`
- New layer structure documented in CLAUDE.md
- Implementation report updated with completion dates
- Layer map created showing final structure

---

## Benefits

### Architecture Clarity
- Layer boundaries enforced: L3→L2→L1→L0 only
- Same-layer coupling eliminated
- Clear separation of concerns

### Maintainability
- Layer 2 becomes pure operations (backup, validation, migration, cache)
- No internal L2 dependencies to manage
- Layer 1 becomes stable infrastructure layer
- Changes to one L2 library don't risk breaking others

### Testability
- Layer 1 libraries unit-testable in isolation
- L2 operations can be tested independently
- L3 domain logic tests clear dependencies

### Agent Friendliness
- Clear layer assignments make refactoring decisions obvious
- No ambiguity about where new operations belong
- Source guard + layer header comments guide AI agents

---

## Risk Assessment

### Low Risk
- **Promotions only**: file-ops.sh, logging.sh, hierarchy.sh already exist, no code changes
- **No L3 changes**: Domain logic layer unaffected
- **Tests validate**: All existing tests continue to pass

### Mitigation
- Update layer headers only (no functional changes)
- Run full test suite after each promotion
- Document changes clearly in commit messages
- Update reports to reflect new structure

---

## Related Documents

- [LIBRARY-ARCHITECTURE-SPEC.md](LIBRARY-ARCHITECTURE-SPEC.md) - Authoritative architecture spec
- [LIBRARY-ARCHITECTURE-IMPLEMENTATION-REPORT.md](LIBRARY-ARCHITECTURE-IMPLEMENTATION-REPORT.md) - Progress tracking
- [LAYER-MAP.md](LAYER-MAP.md) - Final layer structure (to be created by T854)

---

## Timeline & Milestones

| Phase | Task(s) | Status | Target |
|-------|---------|--------|--------|
| Atomic Write | T818-T822 | COMPLETE | 2025-12-24 |
| File-ops Promotion | T850 | PENDING | 2025-12-24 |
| Logging Promotion | T850 | PENDING | 2025-12-24 |
| Hierarchy Promotion | T850 | PENDING | 2025-12-24 |
| Backup Fix | T851 | PENDING | 2025-12-25 |
| Validation Fix | T852 | PENDING | 2025-12-25 |
| Migrate Fix | T853 | PENDING | 2025-12-25 |
| Documentation | T854 | PENDING | 2025-12-25 |
| Verification | T855 | PENDING | 2025-12-26 |

---

## Approval & Sign-Off

**Specification Authority**: Keaton Hoskins (cleo maintainer)
**Created**: 2025-12-24
**Status**: Ready for implementation

---

## Version History

| Date | Version | Changes |
|------|---------|---------|
| 2025-12-24 | 1.0 | Initial plan created based on architecture violations analysis |
