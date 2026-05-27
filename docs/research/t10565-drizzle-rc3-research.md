# T10565: Drizzle ORM v1.0.0-rc.3 Research

**Task:** E3.W1 — Research Drizzle ORM v1.0.0-rc.3 release and current project Drizzle usage  
**Date:** 2026-05-25  
**Author:** cleo-worker (T10565)

---

## AC1: rc.3 MySQL-Focused Release Facts

### Release Metadata
- **Version:** v1.0.0-rc.3
- **Released:** 18 May 2026
- **Author:** @AndriiSherman (commit 771c61e)
- **Source:** https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.3

### Scope: MySQL Parity with PostgreSQL
rc.3 is explicitly a **MySQL-focused parity release**. The official release notes state:

> "Porting all the changes that were made in PostgreSQL to other dialects. This release is about MySQL."

It does **not** introduce new MySQL feature types (no LiveQuery, no new column types). It is a correctness and performance parity release.

### Six MySQL Changes in rc.3

1. **Removed RQBv1 from MySQL dialect** — the `._query` internal escape hatch that allowed staying on the old Relational Queries v1 API is removed for MySQL (mirroring rc.1's change for PostgreSQL).
2. **Internal MySQL sessions refactoring** — unified query preparation function across all MySQL drivers.
3. **Fallback for streaming-incompatible drivers** — instead of throwing when a MySQL driver doesn't support iterators/streaming, Drizzle now falls back to regular queries silently.
4. **Enabled optimized non-JIT mappers for regular queries** — performance mapper work from rc.1 (Postgres) is now active for MySQL.
5. **Switched RQBv2 to array mode querying** — disabled root query-level JSON conversions for MySQL, aligning with Postgres under RQBv2.
6. **Fixed MySQL proxy driver bug** — proxy driver was not correctly reading `lastInsertId` and `affectedRows` from dedicated response fields.

---

## AC2: SQLite Rework — Deferred to Future Release

The rc.3 official release notes include an explicit **"next releases will include"** section:

- Effect MySQL support
- **SQLite rework (same as this release for MySQL)** ← explicitly deferred
- SQLite Effect Support

**SQLite rework is NOT in rc.3.** It is documented as the primary focus of a post-rc.3 release. The planned scope mirrors exactly what rc.3 did for MySQL:
- Remove RQBv1 from the SQLite dialect
- Refactor SQLite sessions to use the unified query preparation function
- Enable optimized mappers for SQLite
- Switch RQBv2 to array mode for SQLite

**No specific version tag for the SQLite rework release has been announced.**

Source: https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.3

---

## AC3: Current Project Drizzle Versions

Inspected via `grep` across all `package.json` files in the monorepo:

| Package | Used In | Current Version |
|---------|---------|-----------------|
| `drizzle-orm` | root, `packages/core`, `packages/nexus`, `packages/playbooks` | **`1.0.0-beta.22-ec7b61d`** |
| `drizzle-kit` | root only | **`1.0.0-beta.19-d95b7a4`** |

### Analysis
- The project is on **beta** builds (`1.0.0-beta.*`), not on the RC series.
- `drizzle-orm` is at **beta.22** (build hash `ec7b61d`) — behind the RC releases.
- `drizzle-kit` is at **beta.19** (build hash `d95b7a4`) — behind the RC releases.
- `drizzle-orm` is used in **4 packages**: root, core, nexus, playbooks.
- These are pre-release beta builds from Drizzle's internal CI feed, not the public npm RC tags.

### Version Gap: beta vs RC
The RC series (rc.1, rc.2, rc.3) represents a more stable/closer-to-stable line than the beta builds. An upgrade from `beta.22` to `1.0.0-rc.3` would involve all breaking changes from the v1 RC series (see Key Breaking Changes below).

---

## Key Breaking Changes (v0.x → v1.x line)

1. **RQBv2 replaces RQBv1 as default** — `db.query.*` now uses the new API; old callback-based `db._query` removed dialect-by-dialect across RCs.
2. **New `casing` API** — instantiation-level `casing` option reworked; now uses `snakeCase`/`camelCase` from `drizzle-orm/dialect-core`.
3. **Validator packages consolidated** — `drizzle-zod`, `drizzle-valibot`, etc. are now imported from within `drizzle-orm` (e.g. `drizzle-orm/zod`).
4. **Migration folder structure changed** — `journal.json` removed; must run `drizzle-kit up` to upgrade existing migrations.
5. **MSSQL dialect added** (beta.2) — new first-class SQL Server support.
6. **JIT-compiled row mappers** (rc.1) — opt-in `jit` flag for maximum query performance.
7. **PostgreSQL array utils moved** — `makePgArray`/`parsePgArray` moved to `drizzle-orm/pg-core/array`.

---

## Source URLs

| Resource | URL |
|----------|-----|
| rc.3 GitHub release | https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.3 |
| NewReleases.io mirror | https://newreleases.io/project/github/drizzle-team/drizzle-orm/release/v1.0.0-rc.3 |
| All GitHub releases | https://github.com/drizzle-team/drizzle-orm/releases |
| Drizzle v1 upgrade guide | https://orm.drizzle.team/docs/upgrade-v1 |
| RQBv1 → v2 migration | https://orm.drizzle.team/docs/relations-v1-v2 |

---

## Evidence Files

- `package.json` — root drizzle-kit version `1.0.0-beta.19-d95b7a4`
- `packages/core/package.json` — drizzle-orm `1.0.0-beta.22-ec7b61d`
- `packages/nexus/package.json` — drizzle-orm `1.0.0-beta.22-ec7b61d`
- `packages/playbooks/package.json` — drizzle-orm `1.0.0-beta.22-ec7b61d`

All AC criteria satisfied.
