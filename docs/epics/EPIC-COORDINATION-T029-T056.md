# Cross-Epic Coordination: T029 (Schema) ↔ T056 (Task System)

**Date:** 2026-03-20  
**Status:** Active Coordination  
**Owner:** Both Epic Leads  

---

## 🎯 Coordination Mandate

**Rule:** Schema changes happen in T029, behavior changes happen in T056. T056 assumes T029 provides the schema infrastructure.

---

## 📋 Schema Dependency Matrix

| T056 Task | Schema Requirement | Provided By T029 | Coordination Point |
|-----------|-------------------|------------------|-------------------|
| **T060** (Pipeline Binding) | `tasks.pipeline_stage` column | **T033** (Connection Health) | Column must exist before T060 starts |
| **T059** (Session Binding) | `tasks.session_id` column + audit log schema | **T033** (Connection Health) | FK relationship to sessions table |
| **T061** (Verification Init) | `tasks.verification_json` column improvements | **T033** (Connection Health) | Schema must support auto-init |
| **T058** (AC Enforcement) | `tasks.acceptance_json` validation | **T033** (Connection Health) | Hard FK enforcement on schema |
| **T066** (Backfill) | All above + migration scripts | **T033** (Connection Health) | Data integrity during backfill |
| **T060** (Pipeline Binding) | `lifecycle_stages` table updates | **T030** (Soft FK Audit) | Stage reference integrity |

---

## 🔄 Coordination Workflow

### Phase 1: Schema Foundation (T029 Wave 0-1)
**T029 Priority Order:**
1. T030 (Soft FK Audit) - No dependencies
2. T031 (Index Analysis) - No dependencies
3. T033 (Connection Health) - → T030, T031 ⚠️ **BLOCKS T056**

**T033 Schema Deliverables Required by T056:**
```sql
-- Required schema changes from T033
ALTER TABLE tasks ADD COLUMN pipeline_stage TEXT REFERENCES lifecycle_stages(id);
ALTER TABLE tasks ADD COLUMN session_id TEXT REFERENCES sessions(id);
ALTER TABLE tasks ADD CONSTRAINT fk_tasks_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;
-- verification_json already exists, ensure proper defaults
-- acceptance_json already exists, ensure proper validation
```

### Phase 2: Enforcement Layer (T056 Wave 0)
**T056 Priority Order:**
1. T057 (Config Schema) - No dependencies
2. T058 (AC Enforcement) - → T057
3. T059 (Session Binding) - → T057
4. T060 (Pipeline Binding) - → T058, T059 ⚠️ **REQUIRES T033 COMPLETE**

### Phase 3: Parallel Execution
**Both Epics proceed independently after T033 complete:**
- T029: T032 (Nexus), T034-T035 (BRAIN dimensions), T036-T037 (Docs)
- T056: T061-T068 (Pipeline, Skills, Telemetry, Backfill, Presets, Docs)

---

## 🚫 Blocking Dependencies

### Critical Blockers

| Blocked Task (T056) | Blocked By (T029) | Reason |
|--------------------|------------------|---------|
| **T060** (Pipeline Binding) | **T033** (Connection Health) | Needs `pipeline_stage` column |
| **T059** (Session Binding) | **T033** (Connection Health) | Needs `session_id` column + FK |
| **T066** (Backfill) | **T033** (Connection Health) | Needs stable schema to backfill |

### Cross-Epic Dependency Chain

```
T029 Wave 0:
├── T030 (Soft FK Audit) ──────┐
└── T031 (Index Analysis) ──────┤
                                ▼
T029 Wave 1:
└── T033 (Connection Health) ───┬──► SCHEMA READY ───┐
                                │                    │
                                ▼                    ▼
T056 Wave 1:                    │                    │
├── T060 (Pipeline Binding) ◄───┘                    │
├── T059 (Session Binding) ◄─────────────────────────┘
└── T066 (Backfill) ◄────────────────────────────────┘
```

---

## ✅ Coordination Checklist

### For T029 Team

**Before T033 is marked complete:**
- [ ] `tasks.pipeline_stage` column added with FK to `lifecycle_stages`
- [ ] `tasks.session_id` column added with FK to `sessions`
- [ ] `tasks.verification_json` has proper defaults/constraints
- [ ] `tasks.acceptance_json` has proper validation
- [ ] Migration scripts tested for zero-downtime deploy
- [ ] Schema documented in ERD diagrams (T036)

### For T056 Team

**Before starting T060, T059, T066:**
- [ ] Verify T033 is marked complete
- [ ] Confirm schema columns exist via `cleo check schema`
- [ ] Test enforcement logic against real schema
- [ ] Coordinate column naming with T029 (avoid renames)

---

## 📞 Coordination Protocol

### When Schema Changes Needed

1. **T056 team identifies schema need** → Create T029 child task
2. **T029 team implements schema** → Update this coordination doc
3. **Schema ready** → T029 marks task complete, notifies T056
4. **T056 proceeds** → Uses schema, reports issues

### Communication Channels

- **Daily standups:** Mention cross-epic blockers
- **Schema review:** Joint review of T033 output
- **Integration testing:** Test T056 enforcement against T033 schema

---

## 🔄 Task Relations to Create

### Hard Dependencies (Must Complete First)

```bash
# T033 (T029) must complete before T060, T059, T066
cleo update T060 --depends T033
cleo update T059 --depends T033  
cleo update T066 --depends T033
```

### Soft Relations (Coordination Only)

```bash
# Add relations (not blocking, but informational)
cleo relate T060 relates-to T033 --reason "Schema dependency: pipeline_stage column"
cleo relate T059 relates-to T033 --reason "Schema dependency: session_id column"
cleo relate T066 relates-to T033 --reason "Backfill requires stable schema"
```

---

## 🎯 Updated Acceptance Criteria

### T033 (Connection Health) - ADD to AC

**Add to existing AC:**
- [ ] `tasks.pipeline_stage` column added with proper FK constraint
- [ ] `tasks.session_id` column added with proper FK constraint  
- [ ] Schema changes tested with T056 enforcement layer
- [ ] Migration is zero-downtime compatible
- [ ] Coordination handoff document provided to T056 team

### T060 (Pipeline Binding) - ADD to AC

**Add to existing AC:**
- [ ] Verified T033 schema changes are deployed
- [ ] `pipeline_stage` column exists and is queryable
- [ ] FK constraints work with auto-assignment logic
- [ ] Integration tests pass with T033 schema

### T059 (Session Binding) - ADD to AC

**Add to existing AC:**
- [ ] Verified T033 schema changes are deployed
- [ ] `session_id` column exists with proper FK
- [ ] Audit log captures session context correctly
- [ ] Integration tests pass with T033 schema

### T066 (Backfill) - ADD to AC

**Add to existing AC:**
- [ ] Verified T033 schema is stable (no more changes)
- [ ] Migration scripts compatible with T033 FK constraints
- [ ] Dry-run validates against T033 schema
- [ ] Rollback plan accounts for T033 schema state

---

## 📝 Schema Contract

### Column Specifications (Agreed)

| Column | Type | Nullable | Default | FK To |
|--------|------|----------|---------|-------|
| `pipeline_stage` | TEXT | YES | NULL | `lifecycle_stages.id` |
| `session_id` | TEXT | YES | NULL | `sessions.id` |

### Constraint Behavior

| Column | On Delete | On Update |
|--------|-----------|-----------|
| `pipeline_stage` | SET NULL | CASCADE |
| `session_id` | SET NULL | CASCADE |

---

## 🚨 Escalation Triggers

**Escalate immediately if:**
1. T033 schema changes break T056 enforcement logic
2. Column naming conflicts between epics
3. T033 delays threaten T056 timeline
4. Schema migration requires downtime (not zero-downtime)

---

**Next Coordination Review:** After T033 complete  
**Coordination Owner:** Shared between T029 and T056 epic leads