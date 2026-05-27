# Migration Epic Example: Database Schema Migration with Rollback

This example demonstrates a multi-phase migration epic with safety checkpoints and rollback capability.

---

## Scenario

Application needs to migrate from single-tenant to multi-tenant schema:
- Add `tenant_id` to all relevant tables
- Update all queries to include tenant context
- Maintain backwards compatibility during rollout
- Enable rollback at each phase

**Risk Level**: High (production data, requires rollback plan)

---

## Step 1: Create the Migration Epic

```bash
{{TASK_ADD_CMD}} "EPIC: Multi-Tenant Schema Migration" \
  --type epic \
  --size large \
  --priority high \
  --phase core \
  --labels "migration,database,multi-tenant,v2.0" \
  --description "Migrate from single-tenant to multi-tenant schema. Phases: (1) Schema changes with dual-write, (2) Data backfill, (3) Query migration, (4) Cleanup. Each phase has rollback capability. Zero downtime required." \
  --acceptance "All tables have tenant_id" \
  --acceptance "All queries tenant-aware" \
  --acceptance "Rollback tested at each phase" \
  --acceptance "Zero data loss" \
  --acceptance "Zero downtime" \
  --notes "Migration plan approved by DBA. Target: Q1 2026."
```

**Annotation**: Migration epics are `large` due to multi-phase nature. Labels include `migration` for filtering. Acceptance criteria emphasize safety (rollback, zero data loss).

---

## Step 2: Create Tasks by Phase

### Phase A: Schema Preparation (Wave 0)

```bash
# T1: Add nullable tenant_id columns (Wave 0)
{{TASK_ADD_CMD}} "Add nullable tenant_id columns to tables" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase setup \
  --labels "migration,schema,phase-a" \
  --description "Add tenant_id column as NULLABLE to users, projects, tasks tables. Create index. No application changes yet." \
  --acceptance "Columns added to all tables" \
  --acceptance "Indexes created" \
  --acceptance "Existing queries still work" \
  --files "migrations/001_add_tenant_id.sql"
```

**Annotation**: First migration task is ADDITIVE ONLY. Never modify existing columns in Wave 0.

### Phase B: Dual-Write Implementation (Wave 1)

```bash
# T2: Implement dual-write logic (Wave 1 - depends on T1)
{{TASK_ADD_CMD}} "Implement dual-write for tenant_id" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T1_ID}} \
  --labels "migration,dual-write,phase-b" \
  --description "Update write operations to populate tenant_id from context. Existing data unchanged. New records get tenant_id." \
  --acceptance "New records have tenant_id populated" \
  --acceptance "Existing records unchanged" \
  --acceptance "Feature flag controls dual-write" \
  --files "src/lib/db/tenant-context.ts,src/lib/db/models/*.ts"

# T3: Create rollback procedure for Phase B (Wave 1 - parallel with T2)
{{TASK_ADD_CMD}} "Create Phase B rollback procedure" \
  --type task \
  --size small \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T1_ID}} \
  --labels "migration,rollback,phase-b" \
  --description "Document and test rollback: disable dual-write flag, verify system functions without tenant_id writes." \
  --acceptance "Rollback procedure documented" \
  --acceptance "Rollback tested in staging" \
  --files "docs/migration/phase-b-rollback.md"
```

### Phase C: Data Backfill (Wave 2)

```bash
# T4: Backfill existing data (Wave 2 - depends on T2, T3)
{{TASK_ADD_CMD}} "Backfill tenant_id for existing records" \
  --type task \
  --size large \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T2_ID}},{{T3_ID}} \
  --labels "migration,backfill,phase-c" \
  --description "Batch update existing records to populate tenant_id based on ownership rules. Use batched updates to avoid locks. Verify completeness." \
  --acceptance "All records have tenant_id" \
  --acceptance "No NULL tenant_id remaining" \
  --acceptance "Backfill script idempotent" \
  --files "scripts/backfill-tenant-id.ts,migrations/002_backfill_tenant.sql"

# T5: Validate backfill completeness (Wave 2 - depends on T4)
{{TASK_ADD_CMD}} "Validate backfill completeness" \
  --type task \
  --size small \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase testing \
  --depends {{T4_ID}} \
  --labels "migration,validation,phase-c" \
  --description "Run validation queries to ensure no NULL tenant_id remains. Compare record counts pre/post migration." \
  --acceptance "Zero NULL tenant_id records" \
  --acceptance "Record counts match" \
  --files "scripts/validate-migration.ts"
```

### Phase D: Query Migration (Wave 3)

```bash
# T6: Update read queries to use tenant context (Wave 3 - depends on T5)
{{TASK_ADD_CMD}} "Update queries to include tenant context" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T5_ID}} \
  --labels "migration,queries,phase-d" \
  --description "Update all database queries to filter by tenant_id from context. Use repository pattern for consistency." \
  --acceptance "All queries filter by tenant" \
  --acceptance "No cross-tenant data leakage" \
  --acceptance "Query performance acceptable" \
  --files "src/lib/db/repositories/*.ts"

# T7: Security audit for tenant isolation (Wave 3 - parallel with T6)
{{TASK_ADD_CMD}} "Audit tenant isolation" \
  --type task \
  --size medium \
  --priority critical \
  --parent {{EPIC_ID}} \
  --phase testing \
  --depends {{T5_ID}} \
  --labels "migration,security,audit,phase-d" \
  --description "Security audit: verify no query paths can access cross-tenant data. Test with multiple tenant contexts." \
  --acceptance "No cross-tenant data access possible" \
  --acceptance "Security review documented" \
  --files "docs/security/tenant-isolation-audit.md"
```

### Phase E: Cleanup (Wave 4 - Final)

```bash
# T8: Make tenant_id NOT NULL (Wave 4 - depends on T6, T7)
{{TASK_ADD_CMD}} "Enforce NOT NULL constraint on tenant_id" \
  --type task \
  --size small \
  --priority medium \
  --parent {{EPIC_ID}} \
  --phase polish \
  --depends {{T6_ID}},{{T7_ID}} \
  --labels "migration,schema,cleanup,phase-e" \
  --description "After validation, add NOT NULL constraint to tenant_id columns. Point of no easy rollback." \
  --acceptance "NOT NULL constraint added" \
  --acceptance "No constraint violations" \
  --files "migrations/003_enforce_tenant_not_null.sql"

# T9: Remove feature flags and legacy code (Wave 4 - depends on T8)
{{TASK_ADD_CMD}} "Remove migration feature flags" \
  --type task \
  --size small \
  --priority low \
  --parent {{EPIC_ID}} \
  --phase polish \
  --depends {{T8_ID}} \
  --labels "migration,cleanup,phase-e" \
  --description "Remove dual-write feature flags, legacy single-tenant code paths. Document migration completion." \
  --acceptance "Feature flags removed" \
  --acceptance "Legacy code removed" \
  --acceptance "Migration documented as complete" \
  --files "src/lib/db/models/*.ts,docs/migration/completion.md"
```

---

## Step 3: Start Session

```bash
{{TASK_SESSION_START_CMD}} \
  --scope epic:{{EPIC_ID}} \
  --name "Multi-Tenant Migration" \
  --agent ct-epic-architect \
  --auto-start
```

---

## Dependency Graph

```
T1 (Add Columns)
├──> T2 (Dual-Write)
│    └──> T4 (Backfill)
│         └──> T5 (Validate)
│              ├──> T6 (Update Queries)
│              │    └──> T8 (NOT NULL)
│              │         └──> T9 (Cleanup)
│              └──> T7 (Security Audit)
│                   └──> T8 (NOT NULL)
└──> T3 (Rollback Procedure)
     └──> T4 (Backfill)
```

---

## Migration Phases Summary

| Phase | Tasks | Rollback | Risk |
|-------|-------|----------|------|
| A: Schema | T1 | Drop columns | Low |
| B: Dual-Write | T2, T3 | Disable flag | Low |
| C: Backfill | T4, T5 | Restore backup | Medium |
| D: Queries | T6, T7 | Revert code | Medium |
| E: Cleanup | T8, T9 | Complex restore | High |

---

## Critical Safety Notes

1. **Each phase has checkpoint**: Don't proceed until validation passes
2. **Rollback tested before proceeding**: T3 creates rollback before T4 executes
3. **Security audit before cleanup**: T7 must pass before T8 (NOT NULL)
4. **Point of no return**: T8 (NOT NULL) is difficult to rollback - ensure confidence
