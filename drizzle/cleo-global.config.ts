/**
 * Drizzle-kit config for the **global-scope** `cleo.db` (D1″ lifecycle split).
 *
 * Target shape for SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2). Owner
 * decision D1″ (2026-05-30) partitions the consolidated SQLite substrate by
 * LIFECYCLE: exactly two `cleo.db` files survive per machine view — this
 * global-scope DB and the project-scope DB
 * ({@link ./cleo-project.config.ts}).
 *
 * Global `cleo.db` holds every **global / cross-project** domain (Pattern A —
 * single-file-per-scope, domain-prefixed tables):
 *   `nexus_*` (cross-project code index) / `skills_*` / `signaldock_*`
 *   (global agent identity — folded here per D1, no standalone `signaldock.db`
 *   survives) / `brain_*` (the global cross-project memory store).
 *
 * Re-derived count (against the lifecycle split, superseding the prior 48/550
 * domain-split figure): **49 tables / 555 columns** — nexus 10t/109c +
 * skills 4t/36c + signaldock 13t/133c + brain (memory) 22t/277c. The `brain_*`
 * schema modules are SHARED with the project config — same DDL, two DB files,
 * data partitioned by scope (global = cross-project memory). Project-tier
 * `tasks_*` (releases, provenance, lifecycle, playbooks) are intentionally NOT
 * mirrored here — they are project concerns and live only in the project
 * `cleo.db`.
 *
 * Runtime DB path resolves via `@cleocode/paths` to
 * `$XDG_DATA_HOME/cleo/cleo.db` (per-OS XDG location); the `dbCredentials.url`
 * below is the drizzle-kit baseline only.
 *
 * **Generation boundary — RESOLVED (T11363).** The `schema` field now points at
 * the CONSOLIDATED, domain-prefixed Pattern-A family under
 * `packages/core/src/store/schema/cleo-global/index.ts` (the barrel authored by
 * T11361 — nexus_* / skills_* / signaldock_* + mirrored brain_* via
 * `cleo-shared`). Those modules carry the FINAL prefixed physical names, so the
 * cross-domain collisions that blocked generation against the OLD unprefixed live
 * modules no longer exist — `drizzle-kit generate` emits a single clean
 * consolidation migration into `out`.
 *
 * @task T11358
 * @task T11361
 * @task T11363
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (canonical per-scope counts)
 * @see packages/core/src/store/schema/cleo-global/index.ts (consolidated target barrel)
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // Consolidated, domain-prefixed Pattern-A target schema (T11361 barrel + mirrored
  // brain via cleo-shared). No physical-name collisions → generate-ready (T11363).
  schema: './packages/core/src/store/schema/cleo-global/index.ts',
  out: './packages/core/migrations/drizzle-cleo-global',
  dialect: 'sqlite',
  dbCredentials: {
    url:
      process.env.CLEO_DRIZZLE_BASELINE_CLEO_GLOBAL_DB ||
      '/tmp/cleo-drizzle-baseline/cleo-global.db',
  },
});
