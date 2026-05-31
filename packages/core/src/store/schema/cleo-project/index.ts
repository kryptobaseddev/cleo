/**
 * Consolidated **PROJECT-scope `cleo.db`** target schema — barrel.
 *
 * SG-DB-SUBSTRATE-V2 · saga T11242 · epic T11245 (E2) · task T11360.
 *
 * ## What this directory is
 *
 * The owner-ratified D1″ lifecycle split (2026-05-30) collapses the CLEO SQLite
 * fleet into exactly two `cleo.db` files: a PROJECT-scope DB
 * (`<projectRoot>/.cleo/cleo.db`) and a GLOBAL-scope DB
 * (`$XDG_DATA_HOME/cleo/cleo.db`). The PROJECT-scope DB holds every project-tier
 * domain — `tasks_*` / `brain_*` (this project's memory) / `conduit_*` /
 * `docs_*` / `telemetry_*` — as domain-prefixed Pattern-A tables (87 tables /
 * 903 columns per the canonical typing report §1).
 *
 * Modules under this directory author that **target shape**: domain-prefixed
 * `sqliteTable` definitions with the E10 strict typing applied per
 * `docs/migration/sqlite-schema-canonical.md`. They are NOT yet the runtime
 * schema — the live runtime modules one level up
 * (`packages/core/src/store/schema/*.ts`) keep their UNPREFIXED physical names
 * (`tasks`, `commits`, `attachments`, …) because they back the live runtime
 * queries and the journaled drizzle migrations (the migration-baseline test
 * asserts the existence table `tasks`, not `tasks_tasks`). The **exodus
 * migration (T11248)** swaps the substrate to this shape and renames the
 * physical tables; pointing a runtime accessor at this module before exodus
 * would read an empty / nonexistent table.
 *
 * ## Idempotent prefixer (AC1)
 *
 * Each table's physical name is its `targetTable` from
 * `docs/migration/sqlite-schema-columns.json`. A table already carrying a
 * recognized domain prefix (`telemetry_events`, `conduit_*`, `brain_*`, …) is
 * NOT double-prefixed; bare tables (`tasks` → `tasks_tasks`, `attachments` →
 * `docs_attachments`) gain their domain prefix.
 *
 * ## Coverage status (T11360 — partial, by design)
 *
 * Authored here (a coherent, fully-green slice — 9 tables):
 *   - **docs** (D11 collapse, AC3): docs_attachments · docs_attachment_refs ·
 *     docs_manifest_entries · docs_pipeline_manifest
 *   - **telemetry**: telemetry_events · telemetry_schema_meta
 *   - **provenance/commits** (E10 §3b boolean + §5b enum demonstrator):
 *     tasks_commits · tasks_task_commits · tasks_commit_files
 *
 * Remaining for follow-on T11360 increments (NOT in this slice): the rest of
 * tasks-core (tasks_tasks, tasks_sessions, lifecycle, releases, PRs,
 * playbooks, agents, chain, audit, evidence, experiments, background-jobs,
 * task_labels junction), the full conduit_* family (14 tables, incl. the 45
 * epoch→ISO8601 timestamp conversions + idempotency keys), and the brain_*
 * memory family (22 tables, mirrored project+global). Each follows the exact
 * pattern established here.
 *
 * @task T11360
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (per-scope counts) · §3–§6 (typing rules)
 * @see drizzle/cleo-project.config.ts (per-scope domain membership)
 */

export * from './docs.js';
export * from './provenance-commits.js';
export * from './telemetry.js';
