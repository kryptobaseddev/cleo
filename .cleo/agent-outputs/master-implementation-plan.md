# Master Implementation Plan: Completion Sweep

**Generated**: 2026-03-02
**Source**: 5 Phase 1 audit reports + registry/schema analysis
**Objective**: Zero remaining action markers (actionable), all stubs completed, all referenced docs created, AGENTS.md 100% accurate, all code compiles, all tests pass. Nothing removed -- only added/completed.

---

## Summary Table

| Wave | ID | Task | Scope | Dependencies | Parallel? |
|------|----|------|-------|--------------|-----------|
| 1 | 1A | Fix AGENTS.md inaccuracies | small | none | yes |
| 1 | 1B | Implement compliance sync function | small | none | yes |
| 1 | 1C | Implement config-driven allowlist in git-checkpoint.ts | small | none | yes |
| 1 | 1D | Resolve action-marker comments in pipeline.ts and resume.ts | small | 2A-2C | partial |
| 2 | 2A | DB migration: `updated_at` on lifecycle_pipelines | small | none | yes |
| 2 | 2B | DB migration: `transitioned_by` on lifecycle_transitions | small | none | yes |
| 2 | 2C | DB migration: `version` on lifecycle_pipelines | small | none | yes |
| 3 | 3A | Author PROJECT-LIFECYCLE-SPEC.md (full spec) | medium | none | yes |
| 3 | 3B | Create docs/MIGRATION-SYSTEM.md | small | none | yes |
| 3 | 3C | Migrate guides from mintlify to docs/guides/ | small | none | yes |
| 3 | 3D | Create docs/CLEO-DOCUMENTATION-SOP.md | small | none | yes |
| 4 | 4A | Migrate archive-stats.ts to dispatch | small | none | yes |
| 4 | 4B | Migrate labels.ts to dispatch | small | none | yes |
| 4 | 4C | Migrate grade.ts to dispatch | small | none | yes |
| 5 | 5A | TypeScript compilation check | small | 1A-4C | no |
| 5 | 5B | Full test suite pass | small | 5A | no |
| 5 | 5C | Final action-marker/FIXME/HACK grep + justification | small | 5B | no |
| 5 | 5D | Verify all referenced docs exist | small | 3A-3D | yes |
| 5 | 5E | Verify AGENTS.md counts match reality | small | 1A, 4A-4C | no |

---

## Wave 1: Quick Code Fixes (all parallel, small scope)

### Task 1A: Fix AGENTS.md Inaccuracies

**Files to read first:**
- `/mnt/projects/claude-todo/AGENTS.md` (current state)
- `/mnt/projects/claude-todo/src/dispatch/registry.ts` (actual operation counts)

**Files to modify:**
- `/mnt/projects/claude-todo/AGENTS.md`

**Specific changes:**

1. **Mutate operation count**: Line 87 says `cleo_mutate (83 ops)` -- actual registry count is **83** (grep confirms 83 `gateway: 'mutate'` entries). However, `docs/specs/CLEO-OPERATIONS-REFERENCE.md` says 82. The registry.ts is the source of truth at runtime. Verify the OPERATIONS-REFERENCE and update whichever is wrong to match the registry. The registry currently has 102 query + 83 mutate = **185 total**.
   - If registry has 83 mutate: update CLEO-OPERATIONS-REFERENCE.md from "82" to "83"
   - If the ops-ref is canonical and one registry entry is an alias: update AGENTS.md -- verify carefully

2. **CLI command handler count**: Line 103 says `75 command handlers` -- actual `ls src/cli/commands/*.ts | wc -l` = **86 files**. Update to `86 command handlers`.

3. **Line 86 ASCII diagram**: Says `(80+ commands)` -- update to `(86 commands)`.

4. **Line 90**: Says `185 operations` -- verify against registry (102 + 83 = 185). If correct, leave as-is.

5. **Line 323**: Says `83 mutate operations` in the Key Files section -- match to the corrected number.

**Acceptance criteria:**
- [ ] All operation counts in AGENTS.md match `src/dispatch/registry.ts` exactly
- [ ] CLI command handler count matches actual file count in `src/cli/commands/`
- [ ] CLEO-OPERATIONS-REFERENCE.md and AGENTS.md are consistent
- [ ] No other stale numbers remain

**Dependencies:** None

---

### Task 1B: Implement Compliance Sync Function

**Files to read first:**
- `/mnt/projects/claude-todo/src/core/compliance/index.ts` (current stub at line 165-170)
- `/mnt/projects/claude-todo/src/core/compliance/store.ts` (readComplianceJsonl helper)
- `/mnt/projects/claude-todo/src/core/compliance/` (other functions for patterns)

**Files to modify:**
- `/mnt/projects/claude-todo/src/core/compliance/index.ts`

**Specific change:**
Replace the stub at lines 165-170 with a real implementation that:
1. Reads compliance entries from `.cleo/metrics/COMPLIANCE.jsonl` (use existing `readComplianceJsonl()`)
2. Computes aggregate statistics: total entries, average pass rate, average adherence, total violations
3. Writes/updates a summary record (e.g., `.cleo/metrics/compliance-summary.json`)
4. Returns `{ synced: N, skipped: M, message: 'Synced N compliance entries', timestamp, globalStats }`
5. If `force: false` (default), skip entries already synced (check summary timestamp)
6. If `force: true`, recompute from all entries

Pattern to follow: Look at `getComplianceSummary()` (lines 13-45) for aggregation logic -- the sync function should produce a similar aggregate but persist it.

**Acceptance criteria:**
- [ ] `syncComplianceMetrics()` reads real JSONL entries and computes stats
- [ ] Returns meaningful `synced`/`skipped` counts
- [ ] The advisory stub message `'Sync not yet implemented in V2'` is removed
- [ ] Existing tests still pass (no breaking changes to return shape)
- [ ] New unit test verifies sync behavior with fixture data

**Dependencies:** None

---

### Task 1C: Implement Config-Driven Allowlist in git-checkpoint.ts

**Files to read first:**
- `/mnt/projects/claude-todo/src/store/git-checkpoint.ts` (lines 64-85, STATE_FILES array + action-marker comment)
- `/mnt/projects/claude-todo/src/core/paths.ts` (getConfigPath for config.json location)
- `/mnt/projects/claude-todo/src/store/json.ts` (readJson for config loading)

**Files to modify:**
- `/mnt/projects/claude-todo/src/store/git-checkpoint.ts`

**Specific change:**
1. Remove the action-marker comment at lines 74-75
2. Add a function `loadStateFileAllowlist(cwd?: string): string[]` that:
   - Reads `config.json` via `readJson(getConfigPath(cwd))`
   - Extracts `.checkpoint.stateFileAllowlist` array (if present)
   - Returns the array, or `[]` if config missing or key absent
3. Modify the checkpoint functions that reference `STATE_FILES` to merge core files with config allowlist:
   ```typescript
   const allStateFiles = [...STATE_FILES, ...loadStateFileAllowlist(cwd)];
   ```
4. Core STATE_FILES array stays hardcoded (always tracked). Config allowlist is additive only.

**Acceptance criteria:**
- [ ] Action-marker comment removed from git-checkpoint.ts
- [ ] Config key `checkpoint.stateFileAllowlist` is read from config.json
- [ ] Core STATE_FILES are always included (not overridable)
- [ ] Custom files from config are merged into the checkpoint list
- [ ] Works with no config (empty allowlist, defaults only)
- [ ] Unit test verifies core + custom merge behavior

**Dependencies:** None

---

### Task 1D: Resolve Action-Marker Comments in pipeline.ts and resume.ts

**Files to read first:**
- `/mnt/projects/claude-todo/src/core/lifecycle/pipeline.ts` (lines 370, 375)
- `/mnt/projects/claude-todo/src/core/lifecycle/resume.ts` (line 649)
- `/mnt/projects/claude-todo/src/store/schema.ts` (lifecycle table definitions)

**Files to modify:**
- `/mnt/projects/claude-todo/src/core/lifecycle/pipeline.ts`
- `/mnt/projects/claude-todo/src/core/lifecycle/resume.ts`

**Specific changes:**

After Wave 2 migrations are applied (columns exist in schema):

1. **pipeline.ts:370** -- Replace `updatedAt: new Date(row.startedAt), // Action item: add updated_at column` with:
   ```typescript
   updatedAt: new Date(row.updatedAt ?? row.startedAt),
   ```

2. **pipeline.ts:375** -- Replace `version: 1, // Action item: add version column for optimistic locking` with:
   ```typescript
   version: row.version ?? 1,
   ```

3. **resume.ts:649** -- Replace `transitionedBy: 'system', // Action item: store agent in transitions table` with:
   ```typescript
   transitionedBy: t.transitionedBy ?? 'system',
   ```

All three action-marker comments are removed and replaced with real column reads with fallback defaults for backward compatibility.

**Acceptance criteria:**
- [ ] All 3 action-marker comments removed from pipeline.ts and resume.ts
- [ ] Code reads from real DB columns (added in Wave 2)
- [ ] Null/missing values fall back to previous defaults (`startedAt`, `1`, `'system'`)
- [ ] TypeScript compiles cleanly
- [ ] Existing lifecycle integration tests pass

**Dependencies:** Wave 2 (Tasks 2A, 2B, 2C) must complete first to add the DB columns

---

## Wave 2: DB Migrations (needs care)

**CRITICAL**: All migrations MUST use `npx drizzle-kit generate` or `npx drizzle-kit generate --custom`. NEVER hand-write migration SQL or snapshot.json. See AGENTS.md "Database Schema Changes" section for workflow.

### Task 2A: DB Migration for `updated_at` Column on lifecycle_pipelines

**Files to read first:**
- `/mnt/projects/claude-todo/src/store/schema.ts` (lines 208-220, lifecyclePipelines table)
- `/mnt/projects/claude-todo/drizzle/` (existing migrations for pattern reference)

**Files to modify:**
- `/mnt/projects/claude-todo/src/store/schema.ts`
- Generated: `drizzle/NNNN_*/migration.sql` + `snapshot.json` (via drizzle-kit)

**Specific change:**
1. Add `updatedAt` column to `lifecyclePipelines` table in schema.ts:
   ```typescript
   updatedAt: text('updated_at').default(sql`(datetime('now'))`),
   ```
2. Run `npx drizzle-kit generate`
3. Inspect generated migration SQL -- should be an `ALTER TABLE lifecycle_pipelines ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))`
4. If drizzle-kit cannot detect the change (unlikely for a new column), use `npx drizzle-kit generate --custom --name "add-updated-at-to-pipelines"`
5. Commit migration.sql + snapshot.json together

**Acceptance criteria:**
- [ ] `updated_at` column added to `lifecyclePipelines` in schema.ts
- [ ] Migration SQL generated via drizzle-kit (not hand-written)
- [ ] snapshot.json generated alongside migration.sql
- [ ] Existing data gets default value via SQLite `DEFAULT (datetime('now'))`
- [ ] `npx tsc --noEmit` passes after schema change

**Dependencies:** None

---

### Task 2B: DB Migration for `transitioned_by` Column on lifecycle_transitions

**Files to read first:**
- `/mnt/projects/claude-todo/src/store/schema.ts` (lines 290-301, lifecycleTransitions table)

**Files to modify:**
- `/mnt/projects/claude-todo/src/store/schema.ts`
- Generated: `drizzle/NNNN_*/migration.sql` + `snapshot.json`

**Specific change:**
1. Add `transitionedBy` column to `lifecycleTransitions` table in schema.ts:
   ```typescript
   transitionedBy: text('transitioned_by'),
   ```
   (Nullable -- existing rows will have NULL, code falls back to `'system'`)
2. Run `npx drizzle-kit generate`
3. Inspect generated SQL
4. Commit migration.sql + snapshot.json together

**Acceptance criteria:**
- [ ] `transitioned_by` column added to `lifecycleTransitions` in schema.ts
- [ ] Migration generated via drizzle-kit
- [ ] Column is nullable (no NOT NULL constraint -- backward compatible)
- [ ] snapshot.json present alongside migration.sql

**Dependencies:** None (can run in parallel with 2A and 2C, but each migration should be generated sequentially to avoid snapshot chain conflicts)

**Note on ordering**: Run 2A, then 2B, then 2C sequentially because each `drizzle-kit generate` builds on the previous snapshot. Running them in parallel would break the snapshot chain.

---

### Task 2C: DB Migration for `version` Column on lifecycle_pipelines (Optimistic Locking)

**Files to read first:**
- `/mnt/projects/claude-todo/src/store/schema.ts` (lines 208-220)

**Files to modify:**
- `/mnt/projects/claude-todo/src/store/schema.ts`
- Generated: `drizzle/NNNN_*/migration.sql` + `snapshot.json`

**Specific change:**
1. Add `version` column to `lifecyclePipelines` table in schema.ts:
   ```typescript
   version: integer('version').notNull().default(1),
   ```
2. Run `npx drizzle-kit generate`
3. Inspect generated SQL -- should be `ALTER TABLE lifecycle_pipelines ADD COLUMN version INTEGER NOT NULL DEFAULT 1`
4. Commit migration.sql + snapshot.json together

**Acceptance criteria:**
- [ ] `version` integer column added to `lifecyclePipelines` in schema.ts
- [ ] Default value is 1 (so existing pipelines start at version 1)
- [ ] Migration generated via drizzle-kit
- [ ] snapshot.json generated alongside
- [ ] `npx tsc --noEmit` passes

**Dependencies:** Must run AFTER 2A (snapshot chain ordering)

---

## Wave 3: Documentation (all parallel)

### Task 3A: Author PROJECT-LIFECYCLE-SPEC.md (Full Spec)

**Files to read first:**
- `/mnt/projects/claude-todo/docs/specs/PROJECT-LIFECYCLE-SPEC.md` (current stub)
- `/mnt/projects/claude-todo/src/core/lifecycle/index.ts` (main lifecycle API)
- `/mnt/projects/claude-todo/src/core/lifecycle/stages.ts` (stage definitions)
- `/mnt/projects/claude-todo/src/core/lifecycle/pipeline.ts` (pipeline state machine)
- `/mnt/projects/claude-todo/src/core/lifecycle/resume.ts` (cross-session resume)
- `/mnt/projects/claude-todo/src/store/schema.ts` (lines 208-301, lifecycle tables)
- `/mnt/projects/claude-todo/docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` (RCASD model context)
- `/mnt/projects/claude-todo/docs/specs/PROTOCOL-ENFORCEMENT-SPEC.md` (gate enforcement patterns)

**Files to modify:**
- `/mnt/projects/claude-todo/docs/specs/PROJECT-LIFECYCLE-SPEC.md`

**Specific change:**
Replace the stub with a full specification covering:

1. **RCASD-IVTR Lifecycle Model**: Define all stages (Research, Consensus, Architecture, Specification, Decomposition, Implementation, Validation, Testing, Release). Document prerequisites, transitions, and completion criteria for each.

2. **Greenfield/Brownfield/Grayfield Patterns**: How lifecycle pipelines are initialized for new projects, existing projects being adopted, and hybrid cases.

3. **Two-Dimensional Work Model (Epics x Phases)**: How epics map to lifecycle phases, cross-phase dependencies, parallel coordination.

4. **Pipeline Gates & HITL Integration**: Gate definitions, pre/post-completion checks, human-in-the-loop gates, failure handling.

5. **SQLite Schema**: Document `lifecycle_pipelines`, `lifecycle_stages`, `lifecycle_gate_results`, `lifecycle_transitions`, `lifecycle_evidence`, and `manifest_entries` tables.

6. **API & CLI Integration**: MCP operations (`pipeline.stage.*`, `pipeline.show`, etc.), CLI commands, session resume across lifecycle boundaries.

7. **Exit Codes 80-84**: Lifecycle enforcement errors.

**Acceptance criteria:**
- [ ] Spec is 200+ lines with substantive content (not boilerplate)
- [ ] All sections above are covered
- [ ] Schema documentation matches actual `src/store/schema.ts` tables
- [ ] Stage names match `LIFECYCLE_STAGE_NAMES` constant in schema
- [ ] References to other specs are correct and bidirectional
- [ ] Status updated from "STUB" to "DRAFT" with version 1.0.0

**Dependencies:** None

---

### Task 3B: Create docs/MIGRATION-SYSTEM.md

**Files to read first:**
- `/mnt/projects/claude-todo/src/core/migration/` (all files in migration module)
- `/mnt/projects/claude-todo/AGENTS.md` (line 563 references this doc)
- `/mnt/projects/claude-todo/drizzle/` (migration directory structure)
- `/mnt/projects/claude-todo/drizzle.config.ts` (drizzle-kit configuration)

**Files to create:**
- `/mnt/projects/claude-todo/docs/MIGRATION-SYSTEM.md`

**Specific change:**
Create documentation covering:

1. **Overview**: CLEO uses Drizzle ORM with SQLite. Migrations are generated by drizzle-kit and applied automatically on startup.

2. **Migration Architecture**: Drizzle-kit generates SQL from schema.ts diffs. Snapshot chain tracks incremental changes. TypeScript migration functions in `src/core/migration/` handle data transformations.

3. **Schema Source of Truth**: `src/store/schema.ts` is the canonical schema definition. `drizzle/` directory contains generated migration history.

4. **Creating Migrations**: Standard workflow (`drizzle-kit generate`) and custom workflow (`drizzle-kit generate --custom`) for CHECK constraint changes.

5. **Migration Execution**: How migrations are applied on database open, checksum validation, error handling.

6. **Version Discovery**: How `discover_migration_versions()` works, `get_schema_version_from_file()` pattern.

7. **Legacy**: Bash migrations in `lib/migrate.sh` (deprecated, backward compat only).

**Acceptance criteria:**
- [ ] File exists at `docs/MIGRATION-SYSTEM.md`
- [ ] Documents both standard and custom drizzle-kit workflows
- [ ] References `src/core/migration/` and `src/store/schema.ts` correctly
- [ ] AGENTS.md link at line 563 resolves correctly
- [ ] 100+ lines of substantive content

**Dependencies:** None

---

### Task 3C: Migrate Guides from docs/mintlify/ to docs/guides/

**Files to read first:**
- `/mnt/projects/claude-todo/docs/mintlify/guides/protocol-enforcement.md`
- `/mnt/projects/claude-todo/docs/mintlify/guides/troubleshooting.md`
- `/mnt/projects/claude-todo/docs/guides/` (existing: migration-safety.md, task-fields.md)

**Files to create:**
- `/mnt/projects/claude-todo/docs/guides/protocol-enforcement.md` (copy from mintlify)
- `/mnt/projects/claude-todo/docs/guides/troubleshooting.md` (copy from mintlify)

**Specific change:**
1. Copy `docs/mintlify/guides/protocol-enforcement.md` to `docs/guides/protocol-enforcement.md`
2. Copy `docs/mintlify/guides/troubleshooting.md` to `docs/guides/troubleshooting.md`
3. Update any internal links in the copied files to reflect new location
4. Do NOT delete the mintlify originals (requirement: nothing removed)

**Acceptance criteria:**
- [ ] `docs/guides/protocol-enforcement.md` exists with real content
- [ ] `docs/guides/troubleshooting.md` exists with real content
- [ ] AGENTS.md references at lines 459-460 resolve correctly
- [ ] Original mintlify files still exist (not deleted)
- [ ] Internal links updated if needed

**Dependencies:** None

---

### Task 3D: Create docs/CLEO-DOCUMENTATION-SOP.md

**Files to read first:**
- `/mnt/projects/claude-todo/AGENTS.md` (line 78 references `@docs/CLEO-DOCUMENTATION-SOP.md`)
- `/mnt/projects/claude-todo/docs/specs/` (existing specs for style reference)
- `/mnt/projects/claude-todo/docs/mintlify/guides/DOCUMENTATION-MAINTENANCE.md` (if exists, for content ideas)

**Files to create:**
- `/mnt/projects/claude-todo/docs/CLEO-DOCUMENTATION-SOP.md`

**Specific change:**
Create a documentation SOP covering:

1. **File Organization**: specs/ for canonical specifications, guides/ for user guides, adrs/ for architecture decisions, concepts/ for foundational material
2. **Naming Conventions**: UPPER-KEBAB-CASE for specs (e.g., `PROJECT-LIFECYCLE-SPEC.md`), lower-kebab-case for guides
3. **Spec Template**: Required sections (Status, Version, Overview, References)
4. **Review Process**: When specs need review, versioning policy
5. **Cross-References**: How to link between docs, maintaining bidirectional references
6. **Deprecation**: How to mark docs as superseded without deleting them

**Acceptance criteria:**
- [ ] File exists at `docs/CLEO-DOCUMENTATION-SOP.md`
- [ ] AGENTS.md `@docs/CLEO-DOCUMENTATION-SOP.md` reference resolves
- [ ] Covers file organization, naming, templates, and cross-references
- [ ] 100+ lines of substantive content
- [ ] Consistent with existing spec format

**Dependencies:** None

---

## Wave 4: CLI Dispatch Easy Migrations (parallel)

Based on the cli-dispatch-audit-report, these are the 3 easiest CLI commands to migrate to dispatch. Each has minimal core imports and straightforward mapping to dispatch operations.

### Task 4A: Migrate archive-stats.ts to Dispatch

**Files to read first:**
- `/mnt/projects/claude-todo/src/cli/commands/archive-stats.ts` (full file)
- `/mnt/projects/claude-todo/src/dispatch/registry.ts` (check if `admin.archive.stats` exists)
- `/mnt/projects/claude-todo/src/dispatch/engines/admin-engine.ts` (admin engine for pattern)
- `/mnt/projects/claude-todo/src/cli/lib/dispatch-cli.ts` (dispatchFromCli helper)

**Files to modify:**
- `/mnt/projects/claude-todo/src/dispatch/registry.ts` -- add `admin.archive.stats` operation
- `/mnt/projects/claude-todo/src/dispatch/engines/admin-engine.ts` -- add handler
- `/mnt/projects/claude-todo/src/cli/commands/archive-stats.ts` -- rewire to use `dispatchFromCli()`

**Specific changes:**

1. **Registry** -- Add operation definition:
   ```typescript
   {
     gateway: 'query',
     domain: 'admin',
     operation: 'archive.stats',
     description: 'admin.archive.stats (query) -- archive statistics and analytics',
     tier: 1,
     idempotent: true,
     sessionRequired: false,
     requiredParams: [],
     params: [
       { name: 'report', type: 'string', required: false, description: 'Report type: summary, by-phase, by-label, by-priority, cycle-times, trends' },
       { name: 'limit', type: 'number', required: false, description: 'Max results' },
     ],
   }
   ```

2. **Admin engine** -- Add handler that calls existing archive-stats core logic (move business logic from CLI to core or engine if not already separated).

3. **CLI command** -- Replace direct core imports with `dispatchFromCli('query', 'admin', 'archive.stats', params)`.

**Acceptance criteria:**
- [ ] `admin.archive.stats` operation exists in registry
- [ ] Dispatch engine handles the operation
- [ ] CLI command routes through dispatch
- [ ] Output is identical to previous behavior
- [ ] MCP agents can now access archive stats

**Dependencies:** None

---

### Task 4B: Migrate labels.ts to Dispatch

**Files to read first:**
- `/mnt/projects/claude-todo/src/cli/commands/labels.ts` (full file)
- `/mnt/projects/claude-todo/src/core/tasks/labels.ts` (core label functions)
- `/mnt/projects/claude-todo/src/dispatch/registry.ts`
- `/mnt/projects/claude-todo/src/dispatch/engines/task-engine.ts` (task engine, since labels are task metadata)

**Files to modify:**
- `/mnt/projects/claude-todo/src/dispatch/registry.ts` -- add `tasks.label.list` and `tasks.label.show` operations
- `/mnt/projects/claude-todo/src/dispatch/engines/task-engine.ts` -- add handlers
- `/mnt/projects/claude-todo/src/cli/commands/labels.ts` -- rewire to dispatch

**Specific changes:**

1. **Registry** -- Add two operations:
   - `tasks.label.list` (query) -- list all labels with counts
   - `tasks.label.show` (query) -- show tasks with a specific label

2. **Task engine** -- Add handlers calling `labelsCore.listLabels()` and `labelsCore.showLabel()`.

3. **CLI** -- Replace direct core imports with `dispatchFromCli()`.

**Acceptance criteria:**
- [ ] `tasks.label.list` and `tasks.label.show` operations in registry
- [ ] Dispatch engine handles both operations
- [ ] CLI routes through dispatch
- [ ] MCP agents can access label operations

**Dependencies:** None

---

### Task 4C: Migrate grade.ts to Dispatch

**Files to read first:**
- `/mnt/projects/claude-todo/src/cli/commands/grade.ts` (full file)
- `/mnt/projects/claude-todo/src/core/sessions/session-grade.ts` (core grade functions)
- `/mnt/projects/claude-todo/src/dispatch/registry.ts`
- `/mnt/projects/claude-todo/src/dispatch/engines/session-engine.ts` (session engine)

**Files to modify:**
- `/mnt/projects/claude-todo/src/dispatch/registry.ts` -- add `session.grade` and `session.grade.list` operations
- `/mnt/projects/claude-todo/src/dispatch/engines/session-engine.ts` -- add handlers
- `/mnt/projects/claude-todo/src/cli/commands/grade.ts` -- rewire to dispatch

**Specific changes:**

1. **Registry** -- Add:
   - `session.grade` (query) -- grade a specific session
   - `session.grade.list` (query) -- list all past grade results

2. **Session engine** -- Add handlers calling `gradeSession()` and `readGrades()`.

3. **CLI** -- Replace direct core imports with `dispatchFromCli()`.

**Acceptance criteria:**
- [ ] `session.grade` and `session.grade.list` operations in registry
- [ ] Dispatch engine handles both operations
- [ ] CLI routes through dispatch
- [ ] MCP agents can access grading

**Dependencies:** None

---

## Wave 5: Validation & Final Sweep

### Task 5A: TypeScript Compilation Check

**Command:**
```bash
npx tsc --noEmit
```

**Acceptance criteria:**
- [ ] Zero errors from `npx tsc --noEmit`
- [ ] All new schema columns are typed correctly
- [ ] All modified files compile without issues

**Dependencies:** All Wave 1-4 tasks must complete first

---

### Task 5B: Full Test Suite Pass

**Command:**
```bash
npm test
```

**Acceptance criteria:**
- [ ] All existing tests pass
- [ ] No regressions from schema changes
- [ ] New tests (from 1B, 1C) pass

**Dependencies:** 5A (must compile first)

---

### Task 5C: Final Action-Marker/FIXME/HACK Grep + Justification

**Command:**
```bash
grep -rn "ACTION-ITEM\|FIXME\|HACK" src/ --include="*.ts" | grep -v "node_modules" | grep -v "dist/"
```

**Files to create (if needed):**
- Update this plan with any remaining items and justification

**Acceptance criteria:**
- [ ] Every remaining action-marker/FIXME/HACK entry is documented with justification
- [ ] Intentional items are annotated:
  - Nexus domain stub (INTENTIONAL -- gated on nexus.db, T4820)
  - Dynamic CLI registration stub (INTENTIONAL -- T4894/T4897/T4900)
  - Skill creator template action markers (INTENTIONAL -- template placeholders for generated code)
  - Pipeline stub test comment (INTENTIONAL -- T4800 test documentation)
- [ ] Zero actionable action markers remain unexplained

**Dependencies:** 5B (all changes landed and tested)

---

### Task 5D: Verify All Referenced Docs Exist

**Specific checks:**

| Referenced Path | Source | Expected After Completion |
|----------------|--------|--------------------------|
| `docs/MIGRATION-SYSTEM.md` | AGENTS.md:563 | Created in 3B |
| `docs/guides/protocol-enforcement.md` | AGENTS.md:459 | Created in 3C |
| `docs/guides/troubleshooting.md` | AGENTS.md:460 | Created in 3C |
| `docs/CLEO-DOCUMENTATION-SOP.md` | AGENTS.md:78 | Created in 3D |
| `docs/specs/PROJECT-LIFECYCLE-SPEC.md` | Multiple specs | Completed in 3A |
| `docs/specs/CLEO-OPERATIONS-REFERENCE.md` | AGENTS.md | Already exists |
| `docs/specs/VERB-STANDARDS.md` | AGENTS.md | Already exists |
| `docs/specs/MCP-SERVER-SPECIFICATION.md` | AGENTS.md | Already exists |

**Command:**
```bash
# Verify all doc references in AGENTS.md resolve
grep -oP '(?<=\[)[^\]]*\.md(?=\])' AGENTS.md | while read f; do
  [ -f "$f" ] || echo "MISSING: $f"
done
```

**Acceptance criteria:**
- [ ] Every document referenced in AGENTS.md exists on disk
- [ ] Every document referenced in code comments exists
- [ ] No broken cross-references between specs

**Dependencies:** Wave 3 must complete

---

### Task 5E: Verify AGENTS.md Counts Match Reality

**Specific checks after all changes:**
1. Count query ops in registry: `grep -c "gateway: 'query'" src/dispatch/registry.ts`
2. Count mutate ops in registry: `grep -c "gateway: 'mutate'" src/dispatch/registry.ts`
3. Count CLI commands: `ls src/cli/commands/*.ts | wc -l`
4. Verify total = query + mutate
5. Compare all numbers with AGENTS.md claims

Note: Wave 4 adds new registry operations, so counts will increase from baseline:
- +1 query op from 4A (archive.stats)
- +2 query ops from 4B (label.list, label.show)
- +2 query ops from 4C (grade, grade.list)
- New total: 102 + 5 = 107 query ops (verify)
- Mutate stays at 83

**Acceptance criteria:**
- [ ] AGENTS.md operation counts match registry after Wave 4 additions
- [ ] CLI command count is accurate
- [ ] Total operations = query + mutate
- [ ] No stale numbers remain in AGENTS.md

**Dependencies:** Tasks 1A and 4A-4C must complete

---

## Exclusions (Intentional -- Do Not Change)

The following items were identified by audits but are **intentionally excluded** from this plan:

1. **Nexus domain stub** (`src/dispatch/domains/nexus.ts`) -- Intentional forward-compatible placeholder for BRAIN Network (T4820). Returns `E_NOT_IMPLEMENTED`. Will be implemented when nexus.db is available.

2. **Dynamic CLI registration stub** (`src/cli/commands/dynamic.ts`) -- Intentional no-op stub linked to T4894/T4897/T4900 for auto-generated Commander commands.

3. **Skill creator template action markers** (`packages/ct-skills/skills/ct-skill-creator/`) -- Intentional template placeholders in generated skeleton code. Users are expected to fill these in.

4. **Archived dev tools** (`dev/archived/schema-diff-analyzer.sh`) -- Deprecated code in archive directory. Contains template action markers that are part of the archived tool.

5. **Dev hooks README action markers** (`dev/hooks/README.md`) -- Documentation examples showing developers how to write migration hooks.

6. **Pipeline stub test comment** (`src/core/lifecycle/__tests__/pipeline.integration.test.ts:862`) -- T4800 test documentation naming convention, tests are real and functional.

7. **Import audit findings** -- Zero action needed. All imports are clean, all underscore-prefixed variables are intentional and used.

8. **Mintlify-to-specs full migration** (80 files) -- Out of scope for this sweep. Only critical missing docs (referenced in AGENTS.md) are addressed.

---

## Execution Order Summary

```
Wave 1 (parallel):  1A + 1B + 1C           (no deps)
Wave 2 (sequential): 2A → 2B → 2C          (snapshot chain)
Wave 1 (deferred):  1D                       (depends on 2A-2C)
Wave 3 (parallel):  3A + 3B + 3C + 3D      (no deps)
Wave 4 (parallel):  4A + 4B + 4C           (no deps)
Wave 5 (sequential): 5A → 5B → 5C → 5D+5E (validation chain)
```

**Critical path**: Wave 2 (sequential migrations) + Task 1D (depends on Wave 2) + Wave 5 (validation)

All other waves can execute in parallel with each other.
