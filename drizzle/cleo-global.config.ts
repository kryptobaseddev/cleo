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
 * **Generation boundary (settles the file-split ambiguity).** The `schema` list
 * declares per-scope DOMAIN MEMBERSHIP, not a generate-ready snapshot. Source
 * modules carry UNPREFIXED physical table names; Pattern-A domain-prefixing is
 * applied by the **E3 exodus prefixer (T11248)**, so `drizzle-kit generate`
 * against this config is deferred until exodus emits the prefixed consolidated
 * schema. This task (T11358) authors the target shape only.
 *
 * @task T11358
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (canonical per-scope counts)
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    // nexus (10 tables) — cross-project code-intelligence index
    './packages/core/src/store/schema/nexus-schema.ts',
    './packages/core/src/store/schema/code-index.ts',
    // skills (4 tables) — global skills catalog
    './packages/core/src/store/schema/skills-schema.ts',
    // signaldock (13 tables) — global agent identity / capabilities (folded per D1)
    './packages/core/src/store/schema/signaldock-schema.ts',
    // brain / memory (22 tables) — SHARED with cleo-project.config.ts (global cross-project memory)
    './packages/core/src/store/schema/memory-schema.ts',
  ],
  out: './packages/core/migrations/drizzle-cleo-global',
  dialect: 'sqlite',
  dbCredentials: {
    url:
      process.env.CLEO_DRIZZLE_BASELINE_CLEO_GLOBAL_DB ||
      '/tmp/cleo-drizzle-baseline/cleo-global.db',
  },
});
