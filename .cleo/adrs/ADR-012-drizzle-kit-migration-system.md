# ADR-012: Drizzle-Kit Migration System for DDL Management

**Status**: Implemented
**Date**: 2026-02-23
**Implemented**: 2026-02-23 (T4837)
**References**: ADR-006 (node:sqlite canonical storage), ADR-010 (drizzle-orm beta adoption), T4817 (store layer refactor epic), T3.3 (drizzle-kit investigation), T4837 (audit log migration)

---

## 1. Context

CLEO uses drizzle-orm v1.0.0-beta.15 with `sqlite-proxy` backed by `node:sqlite` `DatabaseSync`. DDL is currently maintained as manual SQL strings in `src/store/sqlite.ts` (`createTablesIfNeeded()`) -- over 100 lines of raw `CREATE TABLE` and `CREATE INDEX` statements.

This approach has several problems:

| Problem | Impact |
|---------|--------|
| Manual DDL has already drifted from `schema.ts` | Lifecycle tables defined in schema.ts are missing from manual DDL |
| Manual DDL was duplicated across `sqlite.ts` and `migration-sqlite.ts` | Consolidated in T1.4, but still manually maintained |
| CHECK constraints exist only in manual DDL | Not represented in `schema.ts`, invisible to Drizzle ORM |
| `schema.ts` is source of truth for types but NOT for DDL | Two sources of truth for database structure |

---

## 2. Decision

Adopt **drizzle-kit generate** (dev-time) + **drizzle-orm/sqlite-proxy/migrator** programmatic `migrate()` (runtime) as the DDL management system.

### What We Use

| Tool | Phase | Purpose |
|------|-------|---------|
| `drizzle-kit generate` | Dev-time | Offline schema introspection, generates migration SQL from `schema.ts` diffs |
| `drizzle-orm/sqlite-proxy/migrator` | Runtime | Programmatic `migrate()` that works with `node:sqlite` via callback |

### What We Explicitly Do NOT Use

| Tool | Reason |
|------|--------|
| `drizzle-kit push` | Requires `better-sqlite3`/`bun`/`@libsql` driver; incompatible with `node:sqlite` |
| `drizzle-kit pull` | Same driver limitation; not needed since `schema.ts` is source of truth |
| `drizzle-kit studio` | Same driver limitation; use `sqlite3` CLI or DB browser instead |

---

## 3. Key Findings (T3.3 Investigation)

1. **`drizzle-kit generate` works perfectly** -- offline schema introspection requires no DB connection
2. **`drizzle-kit push/pull/studio` do NOT support `node:sqlite`** -- this is expected and acceptable
3. **`drizzle-orm/sqlite-proxy/migrator`** provides programmatic `migrate()` that works with `node:sqlite` via callback
4. **drizzle-orm v1.0.0-beta.15 supports `check()` constraints** -- these generate correct SQL CHECK clauses
5. **Self-referencing foreign keys work** (`tasks.parentId` references `tasks.id`)
6. **Migration idempotency** is handled via `__drizzle_migrations` journal table
7. **Existing databases** can be bootstrapped by marking the initial migration as already applied

---

## 4. Implementation Approach

### Step A: Update schema.ts

- Add `check()` constraints for all enum-like columns (10 checks across 6 tables: `tasks`, `task_relations`, `sessions`, `lifecycle_pipelines`, `lifecycle_stages`, `lifecycle_gate_results`, `lifecycle_evidence`, `lifecycle_transitions`)
- Add `.references(() => tasks.id)` on `tasks.parentId`
- `schema.ts` becomes the **single source of truth** for BOTH types AND DDL

### Step B: Generate Baseline Migration

- Run `drizzle-kit generate` with sqlite dialect, pointing at `./src/store/schema.ts`, outputting to `./drizzle`
- Commit `drizzle/` directory as the baseline migration
- Add `drizzle.config.ts` for developer convenience

### Step C: Replace createTablesIfNeeded()

- Use programmatic `migrate()` from `drizzle-orm/sqlite-proxy/migrator`
- Callback runs SQL via `nativeDb.exec()`
- Keep `schema_meta` version seeding for new databases
- Remove ~100 lines of manual DDL from `sqlite.ts`

### Step D: Handle Existing Databases

- Existing DBs created by manual DDL have no `__drizzle_migrations` table
- On first run with new system: detect existing tables, mark baseline migration as applied
- Subsequent migrations apply incrementally

### Future Workflow

1. Developer edits `schema.ts`
2. Runs `drizzle-kit generate` to create migration SQL
3. Commits both `schema.ts` changes and generated migration
4. Runtime `migrate()` applies pending migrations automatically

---

## 5. Consequences

### Positive

| Benefit | Detail |
|---------|--------|
| Single source of truth | `schema.ts` defines BOTH types AND DDL -- eliminates drift |
| CHECK constraints in schema | Defined in code, not separate manual SQL strings |
| Proper migration system | Version tracking via `__drizzle_migrations` journal |
| ~100 lines removed | Manual DDL in `createTablesIfNeeded()` eliminated |
| Simple change workflow | Edit schema.ts, generate, commit, done |

### Negative

| Cost | Detail |
|------|--------|
| `drizzle/` directory added | Migration SQL files committed to repo |
| Existing DB bootstrap | One-time migration path needed for databases created by manual DDL |
| `drizzle-kit push` unavailable | Minor -- programmatic `migrate()` covers the use case |
| Beta dependency | `drizzle-kit` v1.0.0-beta -- but already committed to drizzle-orm beta (ADR-010) |

---

## 6. Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| Continue manual DDL | Already drifted from schema.ts; unsustainable as schema grows |
| Switch to `better-sqlite3` for full drizzle-kit support | Would require abandoning `node:sqlite` (contradicts ADR-006/ADR-010) |
| Custom migration system | Unnecessary complexity when drizzle-kit generate + programmatic migrate works |

---

## 7. References

- **ADR-006**: node:sqlite as canonical storage engine
- **ADR-010**: drizzle-orm v1.0.0-beta adoption
- **T4817**: Store layer refactor epic
- **T3.3**: drizzle-kit investigation task
- **drizzle-orm docs**: sqlite-proxy migrator documentation
