# ✅ Cross-Epic Coordination Complete: T029 ↔ T056

**Date:** 2026-03-20  
**Status:** COORDINATED & LINKED  
**Coordinator:** CLEO Core Team  

---

## 🎯 Coordination Summary

Successfully coordinated **T029 (Schema Review)** and **T056 (Task System Hardening)** epics with clear dependencies, updated acceptance criteria, and informational relations.

---

## 📋 Hard Dependencies Added (Blocking)

| T056 Task | Now Depends On | Reason |
|-----------|---------------|---------|
| **T060** (Pipeline Binding) | **T033** | Requires `pipeline_stage` column |
| **T059** (Session Binding) | **T033** | Requires `session_id` column |
| **T066** (Backfill Tasks) | **T033** | Requires stable schema |

**Impact:** T033 must complete before T060, T059, or T066 can start.

---

## 🔗 Relations Created (Informational)

| From Task | To Task | Type | Reason |
|-----------|---------|------|--------|
| T060 | T033 | related | Schema dependency: requires pipeline_stage column |
| T059 | T033 | related | Schema dependency: requires session_id column |
| T066 | T033 | related | Schema dependency: backfill requires stable schema |
| T061 | T033 | related | Schema coordination: verification schema improvements |

---

## ✏️ Acceptance Criteria Updated

### T033 (Connection Health) - NEW AC ADDED:
- ✅ `tasks.pipeline_stage` column added with FK to `lifecycle_stages`
- ✅ `tasks.session_id` column added with FK to `sessions`
- ✅ Schema changes tested with T056 enforcement layer
- ✅ Coordination handoff document provided to T056 team

### T060 (Pipeline Binding) - NEW AC ADDED:
- ✅ Verified T033 schema changes are deployed
- ✅ `pipeline_stage` column exists and is queryable
- ✅ Integration tests pass with T033 schema

### T059 (Session Binding) - NEW AC ADDED:
- ✅ Verified T033 schema changes are deployed
- ✅ `session_id` column exists with proper FK
- ✅ Integration tests pass with T033 schema

### T066 (Backfill) - NEW AC ADDED:
- ✅ Verified T033 schema is stable (no more changes)
- ✅ Migration scripts compatible with T033 FK constraints
- ✅ Dry-run validates against T033 schema

---

## 📊 Updated Epic Structures

### T029: Schema Architecture Review
```
Wave 0: Foundation
├── T030: Soft FK Audit (No deps)
└── T031: Index Analysis (No deps)

Wave 1: Validation
├── T032: Nexus Validation (→ T030)
└── T033: Connection Health (→ T030, T031) ⚠️ BLOCKS T056

Wave 2: Completion
├── T034: Agent Dimension (→ T032)
└── T035: Intelligence Dimension (→ T032)

Wave 3: Documentation
├── T036: ERD Diagrams (→ T033)
└── T037: Schema Documentation (→ T033, T034, T035)
```

### T056: Task System Hardening
```
Wave 0: Foundation
├── T057: Config Schema (No deps)
├── T058: AC Enforcement (→ T057)
└── T059: Session Binding (→ T057, ⚠️ → T033)

Wave 1: Pipeline
├── T060: Pipeline Binding (→ T058, T059, ⚠️ → T033)
├── T061: Verification Auto-Init (→ T058)
└── T062: Epic Enforcement (→ T060)

Wave 2: Agent Workflow
├── T063: Skills Update (→ T058, T059, T061)
├── T064: Validator Skill (→ T063)
└── T065: Telemetry (→ T063)

Wave 3: Rollout
├── T066: Backfill (→ T058, T061, ⚠️ → T033)
├── T067: Presets (→ T057)
└── T068: Documentation (→ T065, T066)
```

---

## 🚨 Critical Path

### Execution Order:

**Phase 1: Schema Foundation (T029)**
```
T030 → T031 → T033 (COMPLETE THIS FIRST)
                ↓
         SCHEMA READY
                ↓
```

**Phase 2: Enforcement Layer (T056)**
```
         T033 COMPLETE
                ↓
T057 → T058 ────┬──→ T060 (can start)
       T059 ────┘
         ↓
       T061 → T066 (can start)
```

**Phase 3: Parallel Execution**
- T029 continues: T032, T034-T037
- T056 continues: T062-T068 (all unblocked)

---

## 📝 Schema Contract (Agreed)

### Required Columns from T033:

| Column | Type | Nullable | FK To |
|--------|------|----------|-------|
| `pipeline_stage` | TEXT | YES | `lifecycle_stages.id` |
| `session_id` | TEXT | YES | `sessions.id` |

### Constraint Behavior:
- **On Delete:** SET NULL (preserve tasks if stage/session deleted)
- **On Update:** CASCADE (keep references in sync)

---

## ✅ Coordination Checklist

### T029 Team (Schema):
- [ ] T033 adds `pipeline_stage` column with FK
- [ ] T033 adds `session_id` column with FK
- [ ] T033 tests schema with T056 logic
- [ ] T033 provides handoff document

### T056 Team (Enforcement):
- [ ] T059, T060, T066 blocked until T033 complete
- [ ] Verify schema exists before starting
- [ ] Test integration with T033 schema
- [ ] Report any schema issues immediately

---

## 📁 Documentation Created

1. **Epic Document:** `docs/epics/EPIC-TASK-SYSTEM-HARDENING.md`
2. **Coordination Document:** `docs/epics/EPIC-COORDINATION-T029-T056.md`
3. **This Summary:** `docs/epics/COORDINATION-SUMMARY-T029-T056.md`

---

## 🎯 Next Steps

### Immediate Actions:
1. **T029 team:** Start T030 and T031 (Wave 0)
2. **T056 team:** Start T057 (Wave 0, no blockers)
3. **Both teams:** Review coordination document

### Blocked Until T033 Complete:
- T059 (Session Binding)
- T060 (Pipeline Binding)  
- T066 (Backfill)

### Ready to Start Now:
- T030, T031 (T029 Wave 0)
- T057, T058 (T056 Wave 0)

---

**Coordination Status: ✅ COMPLETE**  
**Ready for parallel execution with clear handoff points**