# T9069 — TaskScope Load-Bearing Analysis

**Date**: 2026-05-08
**Task**: R2 — Determine if `--scope` (`TaskScope = 'project' | 'feature' | 'unit'`) is load-bearing or vestigial
**Epic**: T9067 — Taxonomy Rationalization

---

## Section 1: Declaration Site

| Location | Line | Content |
|----------|------|---------|
| `packages/contracts/src/task.ts` | 66 | `export type TaskScope = 'project' \| 'feature' \| 'unit';` |
| `packages/core/src/store/tasks-schema.ts` | 112 | `export const TASK_SCOPES = ['project', 'feature', 'unit'] as const;` |
| `packages/core/src/store/tasks-schema.ts` | 115 | `export type { TaskScope };` |
| `packages/contracts/src/task.ts` | 322 | `scope?: TaskScope;` (on `Task` interface) |
| `packages/contracts/src/task.ts` | 480 | `scope?: TaskScope;` (on `CreateTaskInput`) |
| `packages/contracts/src/task-record.ts` | 75 | `scope?: string \| null;` (widened wire form) |
| `packages/contracts/src/index.ts` | 1158 | `TaskScope,` (re-exported) |

The type was introduced by T944 as part of the "fractal ontology" trilogy (role + scope + severity).

---

## Section 2: Consumers Table

### Consumers of `TaskScope` type (import of the type name)

| File | Line(s) | Classification |
|------|---------|---------------|
| `packages/contracts/src/task.ts` | 66, 322, 480 | DECLARATION |
| `packages/contracts/src/index.ts` | 1158 | RE-EXPORT |
| `packages/contracts/src/task-record.ts` | 71, 75 | DECLARATION (wire form, string-widened) |
| `packages/core/src/store/tasks-schema.ts` | 13, 112, 115, 259 | DECLARATION + DB SCHEMA |
| `packages/core/src/store/converters.ts` | 15, 66, 122 | REDUNDANT — pass-through (DB row → Task, Task → row), never inspects value |
| `packages/core/src/tasks/add.ts` | 14, 74, 1133, 1230 | REDUNDANT — stores verbatim if provided, no branching on value |
| `packages/core/src/tasks/update.ts` | 12, 106, 329–331, 542 | REDUNDANT — stores verbatim if provided, no branching on value |
| `packages/core/src/tasks/ops.ts` | 26, 169, 195, 235, 260 | REDUNDANT — pass-through to add/update params |
| `packages/core/src/tasks/session-scope.ts` | 20, 169 | REDUNDANT — forwards to add params, no value inspection |
| `packages/core/src/tasks/engine-converters.ts` | 112 | REDUNDANT — `scope: task.scope ?? null` (serialization only) |
| `packages/cleo/src/cli/commands/add.ts` | 160–163, 239 | REDUNDANT — CLI flag that forwards value verbatim |
| `packages/cleo/src/cli/commands/update.ts` | 154–159, 231 | REDUNDANT — CLI flag that forwards value verbatim |
| `packages/cleo/src/dispatch/domains/tasks.ts` | 311 | REDUNDANT — forwards to core `addTask`, no inspection |

### Consumers that WRITE a hardcoded TaskScope value

| File | Line | Value | Context |
|------|------|-------|---------|
| `packages/core/src/sentient/propose-tick.ts` | 429 | `'feature'` | Tier-2 proposals default to feature scope |
| `packages/core/src/sentient/stage-drift-tick.ts` | 268 | `'feature'` | Stage-drift proposals default to feature scope |
| `packages/core/src/hooks/registry.ts` | 158 | `'feature'` | JSDoc example only — not runtime code |

Both sentient ticks hardcode `scope: 'feature'` on new proposal rows. They never inspect the scope value — they simply set it. This is REDUNDANT (defaults that mirror what the DB default would supply anyway).

### Consumers of `task.scope` as a READ value (non-pass-through)

| File | Line | What it does | Classification |
|------|------|--------------|---------------|
| `packages/core/src/docs/export-document.ts` | 307 | Renders `scope: <value>` in YAML frontmatter if set | REDUNDANT — display-only serialization |

**That is the complete list.** No consumer reads `task.scope` and branches on its value ('project' vs 'feature' vs 'unit') to produce different behavior. The field is written at creation/update time and serialized at read time but never inspected for decision-making.

### Notable non-consumers

The following subsystems do NOT use `TaskScope` at all:

- **`findTasks` / `TaskQueryFilters`** — no scope filter field; `idx_tasks_scope` index is unused
- **`classify.ts`** — no scope reference
- **`orchestration/`** — no scope reference
- **`lifecycle/`** — no scope reference (lifecycle uses session scope which is a different type)
- **`briefing.ts`** — no scope reference (uses session scope for epic filtering)
- **`validation/operation-gate-validators.ts`** — no scope reference
- **BRAIN typed-promotion pipeline** — no scope reference
- **Studio search** — no TaskScope reference (uses project-level scope: all|current)

---

## Section 3: DB Schema Usage

### Column definition

```sql
-- packages/core/migrations/drizzle-tasks/20260418174314_t944-role-scope-severity/migration.sql
ALTER TABLE `tasks` ADD COLUMN `scope` TEXT NOT NULL DEFAULT 'feature'
  CHECK (scope IN ('project','feature','unit'));

CREATE INDEX IF NOT EXISTS `idx_tasks_scope` ON `tasks` (`scope`);
```

Drizzle schema (`packages/core/src/store/tasks-schema.ts:259`):
```ts
scope: text('scope', { enum: TASK_SCOPES }).notNull().default('feature'),
```

### Index usage

`idx_tasks_scope` is defined but **never used in any query** across the codebase. A search for `idx_tasks_scope`, `eq(.*scope`, `scope.*eq(`, and `TaskQueryFilters` confirms:

- `TaskQueryFilters` (the primary query filter bag, `packages/contracts/src/data-accessor.ts:58`) does not include a `scope` field
- No `sqlite-data-accessor.ts` or `tasks-sqlite.ts` code filters by scope
- The index is orphaned: created in T944 migration but never leveraged by any query planner path

### DB default behavior

The `DEFAULT 'feature'` on the column means every row inserted without an explicit scope value gets `'feature'`. This is consistent with the T944 backfill mapping and the sentient hardcoded writes.

---

## Section 4: T944 Backfill — 1:1 Mapping Evidence

The migration SQL (`20260418174314_t944-role-scope-severity/migration.sql`) confirms the 1:1 mapping documented in both the contracts and schema comments:

```sql
UPDATE `tasks` SET `scope` = 'project' WHERE `type` = 'epic';
UPDATE `tasks` SET `scope` = 'feature' WHERE `type` = 'task' OR `type` IS NULL;
UPDATE `tasks` SET `scope` = 'unit'    WHERE `type` = 'subtask';
```

This maps bijectively:

| type value | scope value |
|------------|-------------|
| `'epic'` | `'project'` |
| `'task'` (or NULL) | `'feature'` |
| `'subtask'` | `'unit'` |

The comments in both `packages/contracts/src/task.ts:56–62` and `packages/core/src/store/tasks-schema.ts:106–108` document this mapping. No path in the codebase breaks this 1:1 correspondence: there is no place where a task of type `'epic'` has scope `'feature'` or a task of type `'task'` has scope `'project'`. The scope value is ALWAYS derivable from the type value by this mapping.

**Conclusion**: scope is 100% redundant with type at the data level. It conveys no information that type does not already carry.

---

## Section 5: Verdict

**VERDICT: DELETE**

Rationale:

1. **Zero distinct consumers.** No consumer reads scope and branches on its value ('project' vs 'feature' vs 'unit') to produce behavior different from what it would produce based on type alone. Every consumer is either a pass-through (write/serialize) or a display serializer.

2. **1:1 mapping with type is baked into the schema.** The T944 migration backfill, the DB default, and all write paths produce a scope value that is fully determined by type. There is no legitimate case where scope carries orthogonal information.

3. **Orphaned index.** `idx_tasks_scope` was created with the intent of filtering by scope, but `TaskQueryFilters` was never extended to include scope. The index costs write overhead but provides zero read benefit.

4. **`findTasks` has no scope filter.** No user-facing query path allows filtering by scope. The CLI `cleo find` has `--role` but no `--scope`. The field is invisible to consumers and tooling.

5. **The intended orthogonality was never implemented.** The T944 design stated scope is "orthogonal to type" (a task of type 'task' could have scope 'project'). But no code path enforces or leverages this orthogonality, and the backfill hardwires type→scope 1:1.

6. **Owner directive**: "don't keep deprecated/unneeded fields". Scope is unneeded.

---

## Section 6: DELETE — Consumer Update List for W7 (T9074)

W7 must update the following files. All changes are mechanical (remove the field everywhere it appears).

### packages/contracts/src/task.ts
- Line 56–66: Remove `TaskScope` JSDoc + type declaration
- Line 318–322: Remove `scope?: TaskScope;` from `Task` interface
- Line 476–480: Remove `scope?: TaskScope;` from `CreateTaskInput` interface

### packages/contracts/src/task-record.ts
- Line 71–75: Remove `scope` field from `TaskRecord` type

### packages/contracts/src/index.ts
- Line 1158: Remove `TaskScope` from re-exports

### packages/core/src/store/tasks-schema.ts
- Line 13: Remove `TaskScope` from import
- Line 102–112: Remove `TASK_SCOPES` constant and comment block
- Line 114–115: Remove `export type { TaskScope }`
- Line 256–259: Remove `scope` column from `tasksTable` Drizzle schema
- Line 347, 349: Remove `index('idx_tasks_scope').on(table.scope)` from table indexes

### packages/core/src/store/converters.ts
- Line 15: Remove `TaskScope` from import
- Line 66: Remove `scope: (row.scope as TaskScope) ?? undefined,` from `rowToTask`
- Line 122: Remove `scope: task.scope ?? undefined,` from `taskToRow`

### packages/core/src/tasks/add.ts
- Line 14: Remove `TaskScope` from import
- Line 74: Remove `scope?: TaskScope;` from `AddTaskOptions`
- Line 1133: Remove `if (options.scope !== undefined) previewTask.scope = options.scope;`
- Line 1230: Remove `if (options.scope !== undefined) task.scope = options.scope;`

### packages/core/src/tasks/update.ts
- Line 12: Remove `TaskScope` from import
- Line 66: Remove `'scope'` from allowed update fields array
- Line 106: Remove `scope?: TaskScope;` from `UpdateTaskOptions`
- Line 329–331: Remove scope update block
- Line 542: Remove `scope: updates.scope as TaskScope | undefined,`

### packages/core/src/tasks/ops.ts
- Line 26: Remove `TaskScope` from import
- Line 169: Remove `scope?: TaskScope;` from params type
- Line 195: Remove `scope: params.scope,`
- Line 235: Remove `scope?: TaskScope;` from params type
- Line 260: Remove `scope: params.scope,`

### packages/core/src/tasks/session-scope.ts
- Line 20: Remove `TaskScope` from import
- Line 169: Remove `scope: params.scope as TaskScope | undefined,`

### packages/core/src/tasks/engine-converters.ts
- Line 112: Remove `scope: task.scope ?? null,`

### packages/core/src/docs/export-document.ts
- Line 307: Remove `...(task.scope ? ['scope: ${task.scope}'] : []),`

### packages/cleo/src/cli/commands/add.ts
- Line 155–163: Remove `scope` CLI arg definition
- Line 239: Remove `if (args.scope !== undefined) params['scope'] = args.scope;`

### packages/cleo/src/cli/commands/update.ts
- Line 150–159: Remove `scope` CLI arg definition
- Line 231: Remove `if (args.scope !== undefined) params['scope'] = args.scope;`

### packages/cleo/src/dispatch/domains/tasks.ts
- Line 311: Remove `scope: params.scope,`

### packages/core/src/sentient/propose-tick.ts
- Line 409–414 (SQL INSERT): Remove `role, scope` from column list and `:role, :scope` from values
- Line 429: Remove `scope: 'feature',` from params object

### packages/core/src/sentient/stage-drift-tick.ts
- Line 246–251 (SQL INSERT): Remove `role, scope` from column list and `:role, :scope` from values
- Line 268: Remove `scope: 'feature',` from params object

### packages/core/src/store/tasks-schema.ts (TaskFieldUpdates if present)
- Remove any `scope` field from `TaskFieldUpdates` interface

### DB Migration Required

W7 MUST add a new migration to:
1. `ALTER TABLE tasks DROP COLUMN scope;` (or recreate table without the column if SQLite < 3.35)
2. `DROP INDEX IF EXISTS idx_tasks_scope;`

Note: SQLite >= 3.35 supports `DROP COLUMN`. Check the minimum SQLite version in use. If `better-sqlite3` ships a sufficiently new SQLite, a simple `ALTER TABLE tasks DROP COLUMN scope` works. Otherwise, use the rename-recreate pattern already used in T033 migration.

### Tests to update

- `packages/core/src/tasks/__tests__/t944-role-scope-wiring.test.ts` — the entire describe block tests role+scope together. The scope-specific assertions (`expect(loaded!.scope).toBe(...)`) should be removed. Role assertions should be preserved and moved to a role-only test if not already covered by T9068's R1 output.

---

## Section 7: Cross-Reference with T9068 R1 (Role Analysis)

T9068 (R1) has not yet produced output at time of writing. However, based on code inspection:

- `TaskRole` shares the same T944 origin as `TaskScope`
- Unlike scope, `TaskRole` IS used as a distinct filter: `findTasks` accepts `--role` filter, `TaskQueryFilters` has no `role` field but `find.ts:254` applies `allTasks.filter((t) => t.role === options.role)` post-query
- The `idx_tasks_role` and `idx_tasks_role_status` indexes from the T944 migration are partially active (role filter exists in findTasks even though it's post-query rather than SQL-level)
- `TaskRole` values are inspected for behavior: severity is validated against `role='bug'` (DB CHECK constraint), sentient ticks hardcode `role: 'work'`, the orchestrate spawn prompt references role
- **Preliminary cross-ref assessment**: scope and role are NOT symmetric. Role appears load-bearing (filter surface exists, behavior branches on bug role for severity). Scope appears vestigial (no filter surface, no behavior branching).

The scope→type 1:1 mapping confirmed in Section 4 is NOT true for role→type. Role is orthogonal to type in practice (a task of type 'task' can have role 'bug', 'research', 'spike', etc.). T9068 R1 should confirm this.

---

## Summary

| Dimension | Finding |
|-----------|---------|
| Declaration sites | 7 (contracts + schema + re-export) |
| Total consumers | 15 files |
| DISTINCT-from-type consumers | 0 |
| REDUNDANT consumers | 15 (all pass-through or display) |
| DB column | EXISTS, `NOT NULL DEFAULT 'feature'`, constrained enum |
| DB index | EXISTS (`idx_tasks_scope`), NEVER QUERIED |
| Query filter surface | NONE (`TaskQueryFilters` has no scope field) |
| Backfill mapping | 1:1 with type (confirmed in migration SQL) |
| Sentinel behavior | NONE (no branch on 'project' vs 'feature' vs 'unit') |
| **Verdict** | **DELETE** |
| W7 files to update | 16 source files + 1 test file + 1 new DB migration |
