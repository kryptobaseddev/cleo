/**
 * Drizzle-kit config for the **project-scope** `cleo.db` (D1″ lifecycle split).
 *
 * Target shape for SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2). Owner
 * decision D1″ (2026-05-30) partitions the consolidated SQLite substrate by
 * LIFECYCLE, not domain-cluster: exactly two `cleo.db` files survive per machine
 * view — this project-scope DB and the global-scope DB
 * ({@link ./cleo-global.config.ts}).
 *
 * Project `cleo.db` holds every **project-tier** domain (Pattern A —
 * single-file-per-scope, domain-prefixed tables):
 *   `tasks_*` / `brain_*` (this project's memory) / `conduit_*` / `docs_*` /
 *   `telemetry_*` (+ lifecycle / provenance / chain / playbooks / agents).
 *
 * Re-derived count (against the lifecycle split, superseding the prior 66/631
 * domain-split figure): **87 tables / 903 columns** — tasks-core 45t/450c +
 * conduit 14t/116c + docs 4t/48c + telemetry 2t/12c + brain (memory) 22t/277c.
 * The `brain_*` schema modules are SHARED with the global config (the global
 * brain holds cross-project memory; this project brain holds project-local
 * memory) — same DDL, two DB files, data partitioned by scope.
 *
 * Runtime DB path resolves via `@cleocode/paths` to `<projectRoot>/.cleo/cleo.db`;
 * the `dbCredentials.url` below is the drizzle-kit baseline only (generate/check),
 * not the live runtime location.
 *
 * **Generation boundary — RESOLVED (T11363).** The `schema` field below now
 * points at the CONSOLIDATED, domain-prefixed Pattern-A family under
 * `packages/core/src/store/schema/cleo-project/index.ts` (the barrel authored by
 * T11360, mirrored brain via `cleo-shared`). Those modules carry the FINAL
 * prefixed physical names (`tasks_tasks`, `tasks_commits`, `docs_attachments`,
 * `telemetry_events`, …), so the cross-domain physical-name collisions that
 * blocked generation against the OLD unprefixed live modules no longer exist —
 * `drizzle-kit generate` against this config emits a single clean consolidation
 * migration into `out`.
 *
 * Pointing at the prefixed barrel (not the live unprefixed modules) is exactly
 * the "generate-ready membership" the prior T11358/T11360 notes described: the
 * audit's per-scope domain membership is the consolidated family, and the v3
 * consolidation migration generated here is the canonical target the exodus
 * cutover (T11248) applies.
 *
 * @task T11358
 * @task T11360
 * @task T11363
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (canonical per-scope counts)
 * @see packages/core/src/store/schema/cleo-project/index.ts (consolidated target barrel)
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // Consolidated, domain-prefixed Pattern-A target schema (T11360 barrel + mirrored
  // brain via cleo-shared). No physical-name collisions → generate-ready (T11363).
  schema: './packages/core/src/store/schema/cleo-project/index.ts',
  out: './packages/core/migrations/drizzle-cleo-project',
  dialect: 'sqlite',
  dbCredentials: {
    url:
      process.env.CLEO_DRIZZLE_BASELINE_CLEO_PROJECT_DB ||
      '/tmp/cleo-drizzle-baseline/cleo-project.db',
  },
});
