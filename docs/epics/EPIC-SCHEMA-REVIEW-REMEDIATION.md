# Epic: CLEO Schema Architecture Review and Remediation

**Epic ID**: TBD (Session artifact)  
**Created**: 2026-03-19  
**Status**: Planning Phase  
**Priority**: High  
**Scope**: Architecture Review (Large)

---

## Executive Summary

Comprehensive review and remediation of CLEO's three-database architecture (tasks.db, brain.db, nexus.db) including all table relationships, BRAIN dimensions status, connection health checks, and identified gaps. 

### Discovery Context
- **Discovery Date**: 2026-03-19
- **Discovery Session**: Full schema analysis across all databases
- **Critical Findings**: 6 soft FK relationships lacking enforcement, Nexus unvalidated, BRAIN dimensions partially complete

---

## Current State Overview

### Three-Database Architecture

| Database | Location | Tables | Purpose |
|----------|----------|--------|---------|
| **tasks.db** | `.cleo/tasks.db` | 20+ | Work management, lifecycles, ADRs |
| **brain.db** | `.cleo/brain.db` | 10 | Cognitive memory, observations, patterns |
| **nexus.db** | `~/.cleo/nexus.db` | 3 | Cross-project coordination |

### Schema Files
- `packages/core/src/store/tasks-schema.ts`
- `packages/core/src/store/brain-schema.ts`
- `packages/core/src/store/nexus-schema.ts`
- `packages/core/src/store/chain-schema.ts`

---

## Critical Issues Identified

### 🔴 Issue 1: Soft Foreign Keys (6 Relationships)

**Risk Level**: HIGH  
**Impact**: Data integrity on task/session deletion

| Table | Column | Should Reference | Current State |
|-------|--------|------------------|---------------|
| `brain_decisions` | `context_epic_id` | `tasks.id` | Soft reference |
| `brain_decisions` | `context_task_id` | `tasks.id` | Soft reference |
| `brain_memory_links` | `task_id` | `tasks.id` | Soft reference |
| `brain_observations` | `source_session_id` | `sessions.id` | Soft reference |
| `adr_task_links` | `task_id` | `tasks.id` | Soft reference |
| `pipeline_manifest` | `task_id` | `tasks.id` | Soft reference |

### 🟡 Issue 2: Missing Indexes

**Risk Level**: MEDIUM  
**Impact**: Query performance degradation

| Table | Missing Index | Query Pattern |
|-------|--------------|---------------|
| `tasks` | `(status, priority)` | Dashboard filtering |
| `tasks` | `(type, phase)` | Epic/task listing |
| `brain_observations` | `(created_at, type)` | Memory retrieval |
| `sessions` | `(status, started_at)` | Active session queries |

### 🟠 Issue 3: Nexus Unvalidated

**Risk Level**: MEDIUM  
**Impact**: Network dimension contingent on validation

- **Status**: Shipped 8 days ago (as of 2026-03-19)
- **Real-world Usage**: Zero validated usage
- **Risk**: "Network dimension is contingent on Nexus validation passing" - per BRAIN spec

### 🟢 Issue 4: BRAIN Dimensions Partial

**Risk Level**: MEDIUM  
**Impact**: Incomplete cognitive capabilities

| Dimension | Status | Details |
|-----------|--------|---------|
| **B**ase (Memory) | ✅ SHIPPED | 5,122 observations, 3-layer retrieval (FTS5 + vector + graph) |
| **R**easoning | ✅ SHIPPED | Causal inference, similarity detection, temporal decay |
| **A**gent | ⚠️ Partial | Self-healing designed, no learning from execution |
| **I**ntelligence | ⚠️ Partial | Static validation only, no quality prediction |
| **N**etwork | ⚠️ Partial | Nexus shipped but unvalidated (zero usage data) |

---

## Tasks Breakdown

### Wave 0: Audit and Documentation

#### Task 1: Soft FK Audit and Remediation Plan
**ID**: TBD  
**Dependencies**: None  
**Size**: Medium  
**Phase**: Core

**Description**:  
Audit all soft foreign key relationships and create remediation plan for each.

**Acceptance Criteria**:
- [ ] Document all 6 soft FK relationships with current cascade behavior
- [ ] Analyze impact of task/session deletion on each relationship
- [ ] Create migration scripts for each soft FK → hard FK conversion
- [ ] Identify cascading delete vs SET NULL vs RESTRICT behavior for each
- [ ] Write impact assessment report

**Files**:
- `docs/audits/soft-fk-analysis.md`
- `migrations/soft-fk-remediation-plan.sql`

---

#### Task 2: Missing Index Analysis
**ID**: TBD  
**Dependencies**: None  
**Size**: Medium  
**Phase**: Core

**Description**:  
Analyze query patterns and create missing composite/partial indexes.

**Acceptance Criteria**:
- [ ] Identify top 10 most frequent query patterns from audit_log
- [ ] Analyze query execution plans for slow queries
- [ ] Design composite indexes for dashboard filtering
- [ ] Design partial indexes for active vs archived data
- [ ] Benchmark before/after performance

**Files**:
- `docs/audits/index-analysis.md`
- `migrations/index-optimizations.sql`

---

### Wave 1: Validation and Testing

#### Task 3: Nexus Component Validation
**ID**: TBD  
**Dependencies**: Task 1  
**Size**: Large  
**Phase**: Core

**Description**:  
Validate Nexus cross-project coordination with real-world usage scenarios.

**Acceptance Criteria**:
- [ ] Create test suite for all 17 Nexus query operations
- [ ] Create test suite for all 14 Nexus mutate operations
- [ ] Test project registration across 3+ test projects
- [ ] Test cross-project dependency graph construction
- [ ] Test orphan detection for broken references
- [ ] Validate reconciliation scenarios (ok, path_updated, auto_registered, identity_conflict)
- [ ] Document Nexus stability and mark dimension complete

**Files**:
- `docs/validation/nexus-test-results.md`
- `tests/nexus/validation-suite.test.ts`

---

#### Task 4: Connection Health Remediation
**ID**: TBD  
**Dependencies**: Task 1, Task 2  
**Size**: Large  
**Phase**: Core

**Description**:  
Implement hard foreign keys and proper cascade behaviors.

**Acceptance Criteria**:
- [ ] Convert `brain_decisions.context_epic_id` → tasks.id (ON DELETE SET NULL)
- [ ] Convert `brain_decisions.context_task_id` → tasks.id (ON DELETE SET NULL)
- [ ] Convert `brain_memory_links.task_id` → tasks.id (ON DELETE CASCADE)
- [ ] Convert `brain_observations.source_session_id` → sessions.id (ON DELETE SET NULL)
- [ ] Convert `adr_task_links.task_id` → tasks.id (ON DELETE CASCADE)
- [ ] Convert `pipeline_manifest.task_id` → tasks.id (ON DELETE CASCADE)
- [ ] Run full regression test suite
- [ ] Verify no orphaned records after cascade tests

**Files**:
- `migrations/001_soft_fk_to_hard_fk.sql`
- `tests/regression/cascade-behavior.test.ts`

---

### Wave 2: BRAIN Dimension Completion

#### Task 5: Agent Dimension Implementation
**ID**: TBD  
**Dependencies**: Task 3  
**Size**: Large  
**Phase**: Core

**Description**:  
Complete the Agent (A) dimension with self-healing and execution learning.

**Acceptance Criteria**:
- [ ] Design self-healing mechanism for failed tasks
- [ ] Implement learning from task execution patterns
- [ ] Create agent feedback loop for pattern recognition
- [ ] Add agent decision logging to brain_decisions
- [ ] Write agent dimension specification

**Files**:
- `docs/specs/BRAIN-AGENT-DIMENSION.md`
- `packages/core/src/agent/self-healing.ts`

---

#### Task 6: Intelligence Dimension Implementation
**ID**: TBD  
**Dependencies**: Task 3  
**Size**: Large  
**Phase**: Core

**Description**:  
Complete the Intelligence (I) dimension with adaptive validation and quality prediction.

**Acceptance Criteria**:
- [ ] Design adaptive validation framework
- [ ] Implement quality prediction model for tasks
- [ ] Create success rate prediction based on task metadata
- [ ] Add confidence scoring to validation gates
- [ ] Write intelligence dimension specification

**Files**:
- `docs/specs/BRAIN-INTELLIGENCE-DIMENSION.md`
- `packages/core/src/intelligence/quality-prediction.ts`

---

### Wave 3: Documentation and Visualization

#### Task 7: Generate ERD Diagrams
**ID**: TBD  
**Dependencies**: Task 4  
**Size**: Medium  
**Phase**: Polish

**Description**:  
Generate visual ERD diagrams for all three databases.

**Acceptance Criteria**:
- [ ] Generate ERD for tasks.db (all 20+ tables)
- [ ] Generate ERD for brain.db (all 10 tables)
- [ ] Generate ERD for nexus.db (all 3 tables)
- [ ] Create combined architecture diagram
- [ ] Document relationship cardinality
- [ ] Export to PNG, SVG, and interactive HTML formats

**Files**:
- `docs/diagrams/erd-tasks.svg`
- `docs/diagrams/erd-brain.svg`
- `docs/diagrams/erd-nexus.svg`
- `docs/diagrams/architecture-overview.html`

---

#### Task 8: Schema Documentation Consolidation
**ID**: TBD  
**Dependencies**: Task 4, Task 7  
**Size**: Medium  
**Phase**: Polish

**Description**:  
Consolidate all schema documentation into comprehensive reference.

**Acceptance Criteria**:
- [ ] Document all tasks.db tables with column descriptions
- [ ] Document all brain.db tables with column descriptions
- [ ] Document all nexus.db tables with column descriptions
- [ ] Create relationship mapping reference
- [ ] Document status registry values
- [ ] Update CLEO-BRAIN-SPECIFICATION.md
- [ ] Update CLEO-NEXUS-ARCHITECTURE.md

**Files**:
- `docs/reference/schema-tasks-reference.md`
- `docs/reference/schema-brain-reference.md`
- `docs/reference/schema-nexus-reference.md`
- `docs/reference/relationship-mapping.md`

---

## Dependency Graph

```
Wave 0:
├── Task 1: Soft FK Audit
└── Task 2: Index Analysis

Wave 1:
├── Task 3: Nexus Validation ←── depends Task 1
└── Task 4: Connection Health ←── depends Task 1, Task 2

Wave 2:
├── Task 5: Agent Dimension ←── depends Task 3
└── Task 6: Intelligence Dim ←── depends Task 3

Wave 3:
├── Task 7: ERD Generation ←── depends Task 4
└── Task 8: Documentation ←── depends Task 4, Task 7
```

---

## Success Criteria

### Epic Completion Criteria

- [ ] All soft foreign key relationships have documented remediation plans
- [ ] Missing composite indexes identified and created for top query patterns
- [ ] Nexus component validated with real-world usage data and test suite
- [ ] BRAIN dimension status (B,R,A,I,N) fully assessed with gap documentation
- [ ] Connection health check remediation plan implemented and tested
- [ ] Visual ERD diagrams generated for all three databases in multiple formats
- [ ] Schema documentation updated and consolidated in reference docs

### Quality Gates

1. **No orphaned records** - All cascade behaviors tested
2. **Performance improvement** - Query times reduced by 50% for indexed patterns
3. **Nexus stability** - 100% pass rate on validation suite
4. **BRAIN completeness** - All 5 dimensions documented and implemented
5. **Documentation coverage** - 100% table/column documentation

---

## Resources

### Reference Documentation
- `/mnt/projects/cleocode/packages/core/src/store/tasks-schema.ts`
- `/mnt/projects/cleocode/packages/core/src/store/brain-schema.ts`
- `/mnt/projects/cleocode/packages/core/src/store/nexus-schema.ts`
- `/mnt/projects/cleocode/docs/specs/CLEO-BRAIN-SPECIFICATION.md`
- `/mnt/projects/cleocode/docs/specs/CLEO-NEXUS-ARCHITECTURE.md`

### Migration History
- `/mnt/projects/cleocode/migrations/drizzle-tasks/`
- `/mnt/projects/cleocode/migrations/drizzle-brain/`
- `/mnt/projects/cleocode/migrations/drizzle-nexus/`

### Configuration
- `/mnt/projects/cleocode/drizzle-tasks.config.ts`
- `/mnt/projects/cleocode/drizzle-brain.config.ts`
- `/mnt/projects/cleocode/drizzle-nexus.config.ts`

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| FK conversion breaks existing data | High | Full backup before migration, rollback plan |
| Index creation locks tables | Medium | Online index creation, off-peak deployment |
| Nexus validation reveals design flaws | Medium | Phased rollout, feature flags |
| BRAIN dimension scope creep | Medium | Strict acceptance criteria, time-boxing |

---

## Session Notes

### Discovery Session Details

**Date**: 2026-03-19  
**Context**: User requested full schema review across all CLEO databases  
**Method**: Direct schema file analysis + MCP query operations  
**Findings**: Comprehensive map of 33+ tables, 6 soft FK issues, BRAIN dimension gaps

### Key Decisions

1. **Epic scope limited to review and remediation** - Not adding new features
2. **Three-database architecture preserved** - No consolidation planned
3. **Soft FKs converted to hard FKs** - Data integrity priority
4. **Nexus validation required before marking Network dimension complete**

### Follow-up Actions

1. Create this epic in CLEO task system
2. Schedule Wave 0 tasks for next session
3. Set up test environment for Nexus validation
4. Prepare migration scripts for soft FK remediation

---

*Document generated during schema analysis session 2026-03-19*  
*Next review: After Wave 0 completion*