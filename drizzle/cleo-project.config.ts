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
 * **Generation boundary (settles the file-split ambiguity).** The `schema` list
 * below declares per-scope DOMAIN MEMBERSHIP, not a generate-ready snapshot. The
 * source modules still carry UNPREFIXED physical table names, so several names
 * collide across domains in a single file (e.g. `schema/attachments.ts` and
 * `conduit-schema.ts` both define `attachments` → `tasks_attachments` vs
 * `conduit_attachments`). Pattern-A domain-prefixing that resolves these
 * collisions is applied by the **E3 exodus prefixer (T11248)**; `drizzle-kit
 * generate` against this config is therefore deferred until exodus emits the
 * prefixed consolidated schema. This task (T11358) authors the target shape
 * (scope axis, file naming, membership, counts) only.
 *
 * @task T11358
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (canonical per-scope counts)
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    // tasks-core (45 tables) — task lifecycle, provenance, releases, playbooks, agents
    './packages/core/src/store/schema/tasks.ts',
    './packages/core/src/store/schema/attachments.ts',
    './packages/core/src/store/schema/audit.ts',
    './packages/core/src/store/schema/background-jobs.ts',
    './packages/core/src/store/schema/evidence-bindings.ts',
    './packages/core/src/store/schema/experiments.ts',
    './packages/core/src/store/schema/lifecycle.ts',
    './packages/core/src/store/schema/manifest.ts',
    './packages/core/src/store/schema/provenance/commits.ts',
    './packages/core/src/store/schema/provenance/pull-requests.ts',
    './packages/core/src/store/schema/provenance/releases.ts',
    './packages/core/src/store/chain-schema.ts',
    './packages/core/src/agents/agent-schema.ts',
    './packages/playbooks/src/schema.ts',
    // conduit (14 tables) — project-local messaging / delivery / attachments
    './packages/core/src/store/conduit-schema.ts',
    // telemetry (2 tables) — project-tier telemetry counters
    './packages/core/src/telemetry/schema.ts',
    // brain / memory (22 tables) — SHARED with cleo-global.config.ts (project-local memory)
    './packages/core/src/store/memory-schema.ts',
  ],
  out: './packages/core/migrations/drizzle-cleo-project',
  dialect: 'sqlite',
  dbCredentials: {
    url:
      process.env.CLEO_DRIZZLE_BASELINE_CLEO_PROJECT_DB ||
      '/tmp/cleo-drizzle-baseline/cleo-project.db',
  },
});
