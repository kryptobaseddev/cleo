# T9068 — TaskRole Consumer Audit

**Date**: 2026-05-08
**Auditor**: CLEO subagent (T9068 R1 research)
**Epic**: T9067 — `--role` → `--kind` hard rename
**Branch**: task/T9068

---

## Section 1: Declaration Sites (Confirmed)

The mandate says "confirm count = 6". Actual count is **6 declaration sites** across 4 files.

| # | File | Line | Nature |
|---|------|------|--------|
| 1 | `packages/contracts/src/task.ts` | 53 | `export type TaskRole = 'work' \| 'research' \| 'experiment' \| 'bug' \| 'spike' \| 'release'` — authoritative type |
| 2 | `packages/contracts/src/task.ts` | 315 | `role?: TaskRole` on `Task` interface |
| 3 | `packages/contracts/src/task.ts` | 473 | `role?: TaskRole` on `TaskCreate` interface |
| 4 | `packages/core/src/store/tasks-schema.ts` | 96 | `export const TASK_ROLES = [...] as const` — DB enum source |
| 5 | `packages/core/src/store/tasks-schema.ts` | 254 | `role: text('role', { enum: TASK_ROLES }).notNull().default('work')` — Drizzle column definition |
| 6 | `packages/contracts/src/task-record.ts` | 65-69 | `role?: string \| null` — string-widened wire record |

CLI help declaration sites (already excluded from the rename mandate per the investigation brief):
- `packages/cleo/src/cli/commands/add.ts:142` — `role:` arg definition + `kind:` alias
- `packages/cleo/src/cli/commands/update.ts:138` — same
- `packages/cleo/src/cli/commands/find.ts:37` — `role:` filter arg

Confirmed count: **6 core declaration sites** (contracts + schema). CLI arg definitions are the rename targets for W2.

---

## Section 2: Type-Only Consumers

These files import `TaskRole` as a type and use it only for type annotations. The rename is purely mechanical — find-and-replace on the import symbol. No runtime behaviour changes.

| File | Line(s) | Import Shape | Notes |
|------|---------|--------------|-------|
| `packages/contracts/src/index.ts` | 1157 | `export { TaskRole }` | Re-export barrel — must be updated |
| `packages/core/src/store/tasks-schema.ts` | 13, 99 | `import type { ..., TaskRole, ... }` then `export type { TaskRole }` | Re-export from schema |
| `packages/core/src/tasks/ops.ts` | 25, 119, 168, 234 | `import { TaskRole }` then `role?: TaskRole` on three interfaces | Type annotations only |
| `packages/core/src/tasks/session-scope.ts` | 19 | `import { TaskRole }` | Cast annotation at line 168 |
| `packages/core/src/tasks/update.ts` | 11, 101 | `import { TaskRole }` then `role?: TaskRole` on `UpdateTaskOptions` | Type + cast at line 541 |
| `packages/core/src/store/converters.ts` | 14 | `import { TaskRole }` | Type cast at line 65 |

**Summary**: 6 type-only consumer files. All can be updated with a mechanical symbol rename.

---

## Section 3: Value-Using Consumers

These sites use the `role` field name as a runtime value — property access, SQL column name, or string comparison.

### 3A: Structural — DB column name (`role` in SQL/schema)

These are **the hardest part** of the rename. The SQLite column is named `role`. A rename here requires a DB migration.

| File | Line(s) | Code Snippet | Classification |
|------|---------|--------------|----------------|
| `packages/core/src/store/tasks-schema.ts` | 254 | `role: text('role', { enum: TASK_ROLES })` | DB column definition — rename needs migration |
| `packages/core/src/store/tasks-schema.ts` | 348-350 | `index('idx_tasks_role').on(table.role)` etc. | DB indexes on `role` — updated via migration |
| `packages/core/migrations/drizzle-tasks/20260418174314_t944-role-scope-severity/migration.sql` | whole file | `ALTER TABLE tasks ADD COLUMN role TEXT ...` + CHECK constraint `role IN (...)` + `severity CHECK AND role='bug'` | Existing migration — read-only, do NOT modify |
| `packages/core/src/store/conduit-sqlite.ts` | 289 | `role TEXT` in agent_refs CREATE TABLE | **Agent role**, not TaskRole — NOT in rename scope |
| `packages/core/src/sentient/propose-tick.ts` | 404-428 | `INSERT INTO tasks (..., role, ...)` raw SQL + `role: 'work'` | Raw SQL column ref + default value |
| `packages/core/src/sentient/stage-drift-tick.ts` | 241-267 | `INSERT INTO tasks (..., role, ...)` raw SQL + `role: 'work'` | Raw SQL column ref + default value |
| `packages/core/src/store/__tests__/t944-role-scope-schema.test.ts` | 92-470 | `SELECT role FROM tasks`, `INSERT INTO tasks (..., role, ...)` | Schema tests — all raw SQL column names |
| `packages/core/src/sentient/__tests__/proposal-rate-limiter.test.ts` | 54, 156 | `INSERT INTO tasks (..., role, ...)` | Raw SQL in tests |
| `packages/core/src/sentient/__tests__/stage-drift.test.ts` | 66, 83 | `INSERT INTO tasks (..., role, ...)` | Raw SQL in tests |
| `packages/core/src/sentient/__tests__/propose-tick.test.ts` | 51, 202 | `INSERT INTO tasks (..., role, ...)` | Raw SQL in tests |

### 3B: Structural — Object property access (`task.role`, `params.role`, etc.)

These pass the `role` value through the stack. If the DB column stays `role`, these MAY not need renaming; if the column becomes `kind`, these all require update.

| File | Line(s) | Code Snippet | Classification |
|------|---------|--------------|----------------|
| `packages/core/src/store/converters.ts` | 65 | `role: (row.role as TaskRole) ?? undefined` | DB row → Task object mapping |
| `packages/core/src/store/converters.ts` | 121 | `role: task.role ?? undefined` | Task object → update mapping |
| `packages/core/src/tasks/add.ts` | 1132, 1229 | `previewTask.role = options.role` / `task.role = options.role` | Write path |
| `packages/core/src/tasks/update.ts` | 65, 324-326 | `'role'` in `NON_STATUS_DONE_FIELDS`, `task.role = options.role`, `changes.push('role')` | Update write path — 3 instances |
| `packages/core/src/tasks/update.ts` | 514, 541 | `role?: string` in raw query type + `role: updates.role as TaskRole \| undefined` | ORM query param |
| `packages/core/src/tasks/engine-converters.ts` | 111 | `role: task.role ?? null` | Engine output record |
| `packages/core/src/tasks/session-scope.ts` | 124, 168 | `role?: string` param + `role: params.role as TaskRole \| undefined` | Session task creation |
| `packages/core/src/tasks/ops.ts` | 131, 194, 259 | `role: params.role` (3 sites across create/find/update ops) | Op parameter passthrough |
| `packages/core/src/tasks/find.ts` | 52-55, 173, 183-184, 221, 226, 256-258, 302, 395, 409 | Type annotation + inline filter parser `role:value` + filter application `t.role === options.role` | Filter/search path — 9 locations |
| `packages/cleo/src/dispatch/domains/tasks.ts` | 160, 310 | `role: params.role` | Dispatch domain passthrough (2 sites) |
| `packages/cleo/src/cli/commands/add.ts` | 234-238 | `params['role'] = args.role` / `params['role'] = ... ?? args.kind` | CLI → dispatch mapping |
| `packages/cleo/src/cli/commands/update.ts` | 229-230 | `params['role'] = args.role` / `params['role'] = ... ?? args.kind` | CLI → dispatch mapping |
| `packages/cleo/src/cli/commands/find.ts` | 56-57 | `params['role'] = args.role` | CLI → dispatch mapping |

### 3C: Semantic — `task.role === 'bug'` comparisons

These are value-level string comparisons against TaskRole literals.

| File | Line(s) | Code Snippet | Classification |
|------|---------|--------------|----------------|
| `packages/core/src/orchestration/classify.ts` | 209 | `if (task.role === 'bug') return 0.15` | Semantic boost on bug tasks — reads from Task object |
| `packages/core/src/tasks/find.ts` | 258 | `allTasks.filter((t) => t.role === options.role)` | Filter comparison |

### 3D: String literal TaskRole values embedded in code (not declarations)

These pass TaskRole string literals as default values in raw SQL inserts.

| File | Line(s) | Value | Classification |
|------|---------|-------|----------------|
| `packages/core/src/sentient/propose-tick.ts` | 428 | `role: 'work'` | Default for new sentient proposals |
| `packages/core/src/sentient/stage-drift-tick.ts` | 267 | `role: 'work'` | Default for stage-drift tasks |

### 3E: Document export / serialization

| File | Line(s) | Code Snippet | Classification |
|------|---------|--------------|----------------|
| `packages/core/src/docs/export-document.ts` | 306 | `` `role: ${task.role}` `` | Markdown frontmatter output — string key changes with rename |

### 3F: Test value assertions (Task-domain tests only)

These are tests that verify the `role` property end-to-end.

| File | Line(s) | Notes |
|------|---------|-------|
| `packages/cleo/src/cli/commands/__tests__/tasks-command-aliases.test.ts` | 92, 102, 115, 135 | Assert `role: 'bug'`, `'work'`, `'work'`, `'research'` in dispatched params |
| `packages/core/src/tasks/__tests__/t944-role-scope-wiring.test.ts` | 39, 45, 58, 65, 78, 89, 94, 101, 114, 125, 148 | Integration tests for role create/read/find |
| `packages/core/src/tasks/__tests__/find-filter-modes.test.ts` | 63-64, 83, 99, 101 | `role:research` inline filter extraction tests |
| `packages/core/src/__tests__/pipeline-e2e.test.ts` | 214 | `expect(classifyResult.role).toBe(fixture.expectedRole)` — classify result role (agent role, not TaskRole) |

---

## Section 4: DB-Column Considerations

### CHECK constraint at `tasks-schema.ts:119` / migration SQL

The T944 migration (`20260418174314_t944-role-scope-severity/migration.sql`) adds:

```sql
ALTER TABLE tasks ADD COLUMN role TEXT NOT NULL DEFAULT 'work'
  CHECK (role IN ('work','research','experiment','bug','spike','release'));

-- severity cross-constraint references role:
CHECK (severity IS NULL OR (severity IN ('P0','P1','P2','P3') AND role='bug'));
```

**If the column is renamed from `role` to `kind`:**
- Both CHECK constraints must be updated in the new migration
- The severity cross-constraint must reference `kind` instead of `role`
- Existing data in `role` column must be migrated via `ALTER TABLE RENAME COLUMN role TO kind` (SQLite 3.25+, available in better-sqlite3)
- All three indexes must be recreated: `idx_tasks_role`, `idx_tasks_role_status`, `idx_tasks_scope`

### `classify.ts:209` reads `task.role`

```typescript
if (task.role === 'bug') return 0.15;
```

This reads from the in-memory `Task` object (deserialized by `converters.ts`). After column rename:
- `converters.ts:65` must map `row.kind → task.kind` (property rename on Task interface)
- `classify.ts:209` then becomes `task.kind === 'bug'`
- `contracts/src/task.ts:315` becomes `kind?: TaskRole` (the type alias name stays as `TaskRole` OR also renamed)

### DB migration path

A new Drizzle migration is required:
```sql
-- New migration: rename role column to kind
ALTER TABLE tasks RENAME COLUMN role TO kind;
DROP INDEX idx_tasks_role;
DROP INDEX idx_tasks_role_status;
CREATE INDEX idx_tasks_kind ON tasks (kind);
CREATE INDEX idx_tasks_kind_status ON tasks (kind, status);
```

The severity CHECK constraint referencing `role='bug'` will need recreation via table rebuild (SQLite does not support `ALTER TABLE MODIFY COLUMN` for CHECK constraints). Pattern: recreate table with new CHECK, copy data, drop old.

---

## Section 5: Verdict

### Is rename atomic-safe?

**VERDICT: SAFE-TO-RENAME-ATOMICALLY in a single W2 wave, with one required pre-condition.**

**Pre-condition**: The DB column rename requires a Drizzle migration. This migration MUST be authored and applied as part of W2 (T9072) — it cannot be deferred.

**Rationale**:
1. No cross-package circular dependency on the `role` property name — the value flows in one direction (DB → converters → Task object → callers).
2. The `TaskRole` type alias name is internal to `@cleocode/contracts` — renaming it to (say) `TaskKind` is a purely mechanical change in all consumers.
3. The CLI already has the `--kind` alias infrastructure (`add.ts:151`, `update.ts:147`). W2 inverts the relationship: `--kind` becomes canonical, `--role` is removed entirely (no alias).
4. All string literal `TaskRole` values (`'work'`, `'research'`, `'experiment'`, `'bug'`, `'spike'`, `'release'`) remain **unchanged** — only the property key and column name change, not the values.
5. The inline filter parser (`find.ts:173`) parses `role:value` tokens — this needs updating to `kind:value`. One regex match site.

### W2 (T9072) File List by Package

**`packages/contracts/`** — 4 files
- `src/task.ts` — rename type to `TaskKind`, rename property `role` → `kind` on `Task` and `TaskCreate`
- `src/task-record.ts` — rename property `role` → `kind` on `TaskRecord`
- `src/index.ts` — rename re-export `TaskRole` → `TaskKind`
- (no `src/__tests__/` changes — no `role` assertions on task objects)

**`packages/core/src/store/`** — 4 files + 1 migration
- `tasks-schema.ts` — rename `TASK_ROLES` → `TASK_KINDS`, rename column definition `role` → `kind`, rename indexes, update `export type { TaskRole }` → `export type { TaskKind }`
- `converters.ts` — rename property in both `rowToTask` and `taskToRow` mappings
- `migration: 20260508_t9067-rename-role-to-kind/migration.sql` (new file) — `ALTER TABLE tasks RENAME COLUMN role TO kind`, recreate indexes
- `__tests__/t944-role-scope-schema.test.ts` — all raw SQL `role` → `kind` (13+ sites), description strings

**`packages/core/src/tasks/`** — 7 files
- `add.ts` — rename `role` property in `AddTaskOptions`, two write sites
- `update.ts` — rename `'role'` in `NON_STATUS_DONE_FIELDS`, `UpdateTaskOptions.role → kind`, 3 write sites, `changes.push('role')` → `'kind'`
- `ops.ts` — rename `role?: TaskRole` → `kind?: TaskKind` on 3 interfaces, 3 passthrough sites
- `find.ts` — rename `FindOptions.role → kind`, inline filter case `'role':` → `'kind':`, filter application `t.role === options.role` → `t.kind === options.kind`, error message, 9 sites total
- `session-scope.ts` — rename `role` param + cast (2 sites)
- `engine-converters.ts` — rename `role: task.role` → `kind: task.kind`
- `__tests__/t944-role-scope-wiring.test.ts` — rename `role` → `kind` in all test fixtures (11 sites)
- `__tests__/find-filter-modes.test.ts` — rename `role:research` → `kind:research`, `out.role` → `out.kind` (4 sites)

**`packages/core/src/orchestration/`** — 1 file
- `classify.ts` — rename `task.role === 'bug'` → `task.kind === 'bug'` (line 209 only — all other `role` references in classify.ts are agent spawn roles, NOT TaskRole)

**`packages/core/src/sentient/`** — 2 source + 3 test files
- `propose-tick.ts` — rename raw SQL column `role` → `kind` + default value object key (lines 404-428)
- `stage-drift-tick.ts` — same (lines 241-267)
- `__tests__/proposal-rate-limiter.test.ts` — raw SQL `role` → `kind` (2 sites)
- `__tests__/stage-drift.test.ts` — raw SQL `role` → `kind` (2 sites)
- `__tests__/propose-tick.test.ts` — raw SQL `role` → `kind` (2 sites)

**`packages/core/src/docs/`** — 1 file
- `export-document.ts` — rename `` `role: ${task.role}` `` → `` `kind: ${task.kind}` `` (line 306)

**`packages/cleo/src/cli/commands/`** — 4 files
- `add.ts` — rename `--role` arg definition → `--kind` (canonical), remove `--kind` alias definition (it becomes canonical), update `params['role']` → `params['kind']`, update doc strings
- `update.ts` — same pattern
- `find.ts` — rename `--role` → `--kind` arg definition, rename `params['role']` → `params['kind']`
- `__tests__/tasks-command-aliases.test.ts` — rename `role:` keys in `objectContaining` assertions (4 sites)

**`packages/cleo/src/dispatch/domains/`** — 1 file
- `tasks.ts` — rename `role: params.role` → `kind: params.kind` (2 sites, lines 160 + 310)

**Total file count**: ~24 source files + 1 new migration file = **25 files to touch in W2**

---

## Section 6: Cross-References with T9069 (R2 Scope Research)

T9069 audits `--scope` load-bearing usage. The following observations are relevant:

1. **Both axes travel together through the stack**: `role` and `scope` follow the same passthrough pattern in `ops.ts`, `session-scope.ts`, `dispatch/domains/tasks.ts`, `add.ts`, `update.ts`. W2 changes to the `role`→`kind` rename in those files will require careful coordination with any `scope` changes from T9069 to avoid merge conflicts.

2. **DB migration is shared**: The T944 migration added both `role` and `scope` columns. The W2 migration for renaming `role`→`kind` is independent of scope — scope column name stays as-is unless T9069 recommends otherwise.

3. **`find.ts` inline filter parser** handles both `role:` and `status:` tokens. If T9069 recommends a scope filter token, it gets added to the same regex at line 173. No conflict with the `role`→`kind` rename since they're separate `case` branches.

4. **`NON_STATUS_DONE_FIELDS` in `update.ts:65`**: Both `'role'` and `'scope'` appear in this array. The W2 rename changes `'role'` → `'kind'`; scope stays unchanged.

5. **`export-document.ts:306`**: Currently serializes `role:` and (if T9069 finds a scope serializer) also `scope:`. These are independent YAML keys — no overlap.

---

## Appendix: Out-of-Scope `role` Uses (NOT TaskRole)

The following `role` occurrences in the codebase are **NOT** TaskRole and must NOT be renamed:

| Context | Examples | Why out of scope |
|---------|---------|------------------|
| Agent spawn role | `role: 'worker' \| 'lead' \| 'orchestrator'` in `classify.ts`, `spawn.ts`, `atomicity.ts`, `plan.ts`, `orchestrate/` | Agent tier role, different type |
| LLM message role | `role: 'user' \| 'assistant' \| 'system'` in `llm/`, `memory/`, `adapters/` | LLM protocol |
| Conduit agent refs | `role TEXT` in `conduit-schema.ts:327`, `conduit-sqlite.ts` | Agent attachment role |
| CANT agent role | `role: 'worker' \| 'lead' \| 'specialist'` in `cant/src/types.ts`, `caamp/` | CANT hierarchy role |
| Nexus sigil role | `role text().notNull()` in `nexus-schema.ts:553` | Symbol role classification |
| Playbook node role | `role: 'lead' \| 'worker' \| ...` in `playbooks/src/parser.ts` | Playbook agent role |
| CleoOS agent monitor | `role: AgentTierRole` in `cleo-os/` | Runtime agent role |
| DB handle role | `handle.role` in `open-cleo-db.test.ts` — values like `'tasks'`, `'brain'` | Database handle type |
