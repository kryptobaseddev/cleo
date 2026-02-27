# ADR-010: SQL Engine & ORM Layer Selection

**Date**: 2026-02-23
**Status**: accepted
**Accepted**: 2026-02-23
**Amends**: ADR-006
**Related Tasks**: T4817
**Summary**: Selects node:sqlite (Node.js built-in, v22.5+) over sql.js and better-sqlite3 as the SQLite engine, paired with drizzle-orm/sqlite-proxy as the ORM layer. Zero native dependencies, cross-platform, WAL mode enabled.
**Keywords**: sqlite, node-sqlite, drizzle-orm, orm, sql-engine, wasm, better-sqlite3, wal
**Topics**: storage, admin, migration

---

## 1. Context

CLEO requires safe concurrent access to SQLite across multiple agents and processes (CLI + MCP + orchestrated subagents). The prior `sql.js` (WASM, in-memory + export/save model) implementation does not provide native SQLite file-lock semantics or practical WAL behavior for cross-process coordination.

This project enforces a Node runtime baseline of `>=24.0.0` and uses `drizzle-orm` with `drizzle-kit` as the ORM and migration tooling layer over SQLite.

As of 2026-02-23, Drizzle ORM v1.0.0-beta has reached general availability as a consolidated release that merges validation packages, improves migration tooling, and tightens SQLite dialect enforcement.

## 2. Decision

### 2.1 SQLite Engine

CLEO SHALL use Node built-in `node:sqlite` as the canonical SQLite engine for project and global stores.

Specifically:

1. CLEO MUST open databases as file-backed SQLite databases via `node:sqlite`.
2. CLEO MUST enable WAL mode for multi-process read/write concurrency where applicable.
3. CLEO MUST preserve ACID transactional behavior and foreign-key enforcement.
4. CLEO MUST keep Node.js `>=24.0.0` as a hard runtime requirement.
5. CLEO MUST keep ADR-006 as the canonical storage architecture, with this ADR as the engine-specific amendment.

### 2.2 ORM Layer: Drizzle v1.0.0-beta

CLEO SHALL use `drizzle-orm` v1.0.0-beta (floor: beta.15) and `drizzle-kit` v1.0.0-beta as the ORM and schema tooling layer.

Specifically:

1. CLEO MUST pin `drizzle-orm` to `^1.0.0-beta.15` and `drizzle-kit` to `^1.0.0-beta.15` to track the v1 release line.
2. CLEO MUST use `drizzle-orm/zod` (consolidated into the main package in v1) for schema-derived validation when Zod validation of database rows is needed. The separate `drizzle-zod` package MUST NOT be installed.
3. CLEO MUST NOT install separate validator packages (`drizzle-zod`, `drizzle-valibot`, `drizzle-typebox`). All validator integrations are available as subpath exports of `drizzle-orm` in v1.
4. CLEO SHOULD adopt `drizzle-kit` v1 migration improvements (applies all missing migrations, not just those with a later creation date) when migrating from manual SQL schema creation to managed migrations.

## 3. Rationale

### 3.1 SQLite Engine: `node:sqlite`

`node:sqlite` is built into the Node.js runtime, provides file-backed SQLite with WAL support, and requires zero third-party native module management. It is the only engine consistent with CLEO's Node 24+ baseline and zero-native-dependency goals. `node:sqlite` remains Stability 1.1 (Active Development); CLEO suppresses the `ExperimentalWarning` in built CLI/MCP entry points via `--disable-warning=ExperimentalWarning`.

### 3.2 ORM Layer: Drizzle v1.0.0-beta

Drizzle v1 consolidates validation packages into the main `drizzle-orm` package, provides stricter SQLite dialect enforcement at schema definition time, and fixes the `drizzle-kit` migrator to apply all missing migrations regardless of creation date ordering. These improvements directly address CLEO's needs for type-safe schema validation, early error detection, and reliable migration tooling.

## 4. ADR-006 Compliance Mapping

This decision remains compliant with ADR-006 goals:

- **Concurrency**: improved by file-backed WAL-capable engine.
- **Relational integrity**: unchanged (SQLite + FK constraints). Drizzle v1 adds stricter schema validation that catches duplicate FK/index names at definition time.
- **Transactional safety**: unchanged (SQLite ACID).
- **Type safety contract**: strengthened by Drizzle v1's consolidated `drizzle-orm/zod` for schema-derived validation, eliminating the need for separate validation packages.
- **Cross-session continuity**: improved by real on-disk database coordination.

## 5. Drizzle v1.0.0-beta Capabilities for CLEO

### 5.1 Consolidated Validation (`drizzle-orm/zod`)

Drizzle v1 merges all validator packages into subpath exports:

- `drizzle-orm/zod` -- Zod schema generation (`createInsertSchema`, `createSelectSchema`, `createUpdateSchema`)
- `drizzle-orm/valibot` -- Valibot integration
- `drizzle-orm/typebox` -- TypeBox integration
- `drizzle-orm/arktype` -- ArkType integration
- `drizzle-orm/effect-schema` -- Effect library integration (new in v1)

CLEO uses Zod (`zod` v4.3.6, peer dep `^3.25.0 || ^4.0.0`). When schema-derived validation is needed, import from `drizzle-orm/zod` directly rather than installing `drizzle-zod`.

### 5.2 Improved Migration Tooling (`drizzle-kit` v1)

The v1 migrator applies all missing migrations by comparing each migration's `folderMillis` (the timestamp encoded in the migration folder name) against the `created_at` column in `__drizzle_migrations`. The `hash` column is populated for audit purposes but is not used as the tracking key — only `created_at` determines whether a migration has been applied. All pending migrations are batched into a single callback call, which must be wrapped in a `BEGIN/COMMIT/ROLLBACK` transaction to guarantee atomicity (see ADR-012 Step C and commit `1d0da22a`). `drizzle-kit` managed migrations adopted per ADR-012 (T4837, 2026-02-23).

### 5.3 Stricter SQLite Dialect Enforcement

Drizzle v1 (beta.12+) errors at schema definition time for:

- Duplicate column names within a table
- Duplicate FK constraint names
- Duplicate index names
- Duplicate primary key names
- Tables with no columns

This provides earlier detection of schema definition errors that previously only surfaced at runtime.

### 5.4 Enhanced SQLite SQL Support

- Fixed `SQL.Aliased` in `.orderBy()` and `.groupBy()` for SQLite dialect.
- `.prepare()` name parameter is now optional (auto-generated if omitted).

## 6. Consequences

### Positive

- Aligns runtime engine behavior with WAL/concurrency requirements.
- Removes dependence on `sql.js` export/save lifecycle for persistence.
- Better matches multi-agent multi-process operational model.
- Consolidated ORM validation eliminates separate package management.
- Stricter schema enforcement catches definition errors earlier.

### Tradeoffs

- Requires explicit Node 24+ compatibility discipline.
- Requires migration of engine-specific code paths and tests.
- Drizzle v1 beta requires tracking for breaking changes until stable release.

## 7. Implementation and Documentation Requirements

1. Update storage engine implementation and migration/integrity helpers that currently depend on `sql.js` semantics.
2. Update tests and docs that assume in-memory export/save behavior.
3. Keep ADR-006 and ADR-010 cross-linked for decision traceability.
4. Use `drizzle-orm/zod` (not `drizzle-zod`) for any new schema validation work.
5. `drizzle-kit` migrations adopted. See ADR-012. Complete.

## 8. References

- `.cleo/adrs/ADR-006-canonical-sqlite-storage.md` -- canonical storage architecture (amended by this ADR)
- `.cleo/adrs/ADR-012-drizzle-kit-migration-system.md` -- drizzle-kit migration system (fulfills Section 5.2/7.5 recommendations)
- `.cleo/adrs/archive/ADR-002-hybrid-storage-strategy.md` -- original sql.js selection (superseded by ADR-006)
- `.cleo/agent-outputs/2026-02-23_T4820-adr006-compliance-review.md` -- compliance traceability checklist
- `package.json` -- Node.js engines field (`>=24.0.0`), drizzle-orm `^1.0.0-beta.15`, drizzle-kit `^1.0.0-beta.15`
- Epic `T4817` and child tasks (T4818-T4823)
- [Drizzle ORM v1.0.0-beta release notes](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.15)
