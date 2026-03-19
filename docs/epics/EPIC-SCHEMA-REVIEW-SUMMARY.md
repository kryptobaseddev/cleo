# Epic Created: CLEO Schema Architecture Review

## 📋 Epic Summary

**Location**: `docs/epics/EPIC-SCHEMA-REVIEW-REMEDIATION.md`

**Scope**: Complete review of CLEO's three-database architecture with remediation plan

---

## 🎯 What's Covered

### Databases (33+ Tables Total)
- **tasks.db**: 20+ tables (work management, lifecycles, ADRs)
- **brain.db**: 10 tables (cognitive memory, 5,122+ observations)
- **nexus.db**: 3 tables (cross-project registry)

### Critical Issues Found
1. **6 Soft Foreign Keys** - No DB enforcement (orphaned record risk)
2. **Missing Indexes** - Performance degradation on common queries
3. **Nexus Unvalidated** - Zero real-world usage since launch
4. **BRAIN Partial** - 2 of 5 dimensions incomplete

---

## 📊 Task Breakdown (8 Tasks, 4 Waves)

```
Wave 0: Foundation
├── Task 1: Soft FK Audit & Remediation Plan
└── Task 2: Missing Index Analysis

Wave 1: Validation
├── Task 3: Nexus Component Validation
└── Task 4: Connection Health Remediation

Wave 2: Completion
├── Task 5: Agent Dimension (BRAIN-A)
└── Task 6: Intelligence Dimension (BRAIN-I)

Wave 3: Documentation
├── Task 7: ERD Diagram Generation
└── Task 8: Schema Documentation
```

---

## 🔴 Critical Issues Detail

### Soft Foreign Keys (HIGH RISK)
| Table | Column | Impact on Delete |
|-------|--------|------------------|
| `brain_decisions` | `context_epic_id`, `context_task_id` | Orphaned decisions |
| `brain_memory_links` | `task_id` | Broken memory links |
| `brain_observations` | `source_session_id` | Orphaned observations |
| `adr_task_links` | `task_id` | Broken ADR links |
| `pipeline_manifest` | `task_id` | Orphaned manifest entries |

### BRAIN Dimensions Status
- ✅ **B**ase: 5,122 observations, full-text + vector search
- ✅ **R**easoning: Causal inference, similarity detection
- ⚠️ **A**gent: Self-healing designed, no learning
- ⚠️ **I**ntelligence: Static validation only
- ⚠️ **N**etwork: Nexus shipped but unvalidated

---

## 📁 Files Created

1. **Epic Document** (`docs/epics/EPIC-SCHEMA-REVIEW-REMEDIATION.md`)
   - Full task breakdown with acceptance criteria
   - Dependency graph
   - Resource references
   - Risk mitigations

2. **Schema Source Files** (existing, referenced in epic)
   - `packages/core/src/store/tasks-schema.ts`
   - `packages/core/src/store/brain-schema.ts`
   - `packages/core/src/store/nexus-schema.ts`

---

## 🚀 Next Steps for Future Session

1. **Review the epic document** - Ensure scope aligns with priorities
2. **Start Wave 0** - Begin with Task 1 (Soft FK Audit) or Task 2 (Index Analysis)
3. **Set up test environment** - For Nexus validation and migration testing
4. **Schedule BRAIN dimension work** - Agent and Intelligence implementations

---

## 📊 Visual Architecture (Summary)

```
┌─────────────────────────────────────────────────────────────┐
│                      CLEO SYSTEM                            │
├─────────────────────────────────────────────────────────────┤
│  tasks.db (20+ tables)      brain.db (10 tables)            │
│  ┌─────────────────┐        ┌─────────────────┐             │
│  │ tasks           │◄──────►│ brain_decisions │             │
│  │ sessions        │   SOFT │ brain_patterns  │             │
│  │ dependencies    │   FKs  │ brain_learnings │             │
│  │ lifecycle_*     │        │ brain_observations│           │
│  │ architecture_*  │        │ brain_memory_links│           │
│  │ manifest_*      │        └─────────────────┘             │
│  │ audit_log       │                                         │
│  └─────────────────┘                                         │
│           │                                                  │
│           ▼ (cross-project)                                  │
│  ┌─────────────────┐                                         │
│  │  nexus.db       │ ⚠️ UNVALIDATED                          │
│  │  (3 tables)     │    Zero usage                           │
│  │  project_registry│                                        │
│  └─────────────────┘                                         │
└─────────────────────────────────────────────────────────────┘
```

---

**Ready for next session when you are!** The epic is fully documented and can be worked on incrementally across multiple sessions.