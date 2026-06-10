-- T11733 (E8-CATALOG-CURATION · epic T11694) — the `models_catalog` catalog SSoT
-- table in the consolidated GLOBAL cleo.db (drizzle-cleo-global scope ONLY — the
-- provider+model capability catalog is a cross-project, machine-wide signal with
-- no project-tier analog, so it is NOT mirrored into drizzle-cleo-project).
--
-- One row per model: the full models.dev wire capability set (modalities, cost,
-- limits, reasoning/tool-call flags, status, release_date). This table is the
-- catalog SSoT — seeded from the shipped offline `curated-catalog.json` (T11734),
-- read table-first via resolveCatalogEntry() (T11737), and consulted by the
-- resolver default (latest release_date wins — T11944), killing the hardcoded
-- `claude-haiku-4-5` default literal (which survives only as the offline floor).
--
-- This carries NO secrets and NO encryption — it is catalog DATA, distinct from
-- the `accounts` LLM-credential pool (T11709) and the `service_*` vault (T11937).
--
-- ## Page-2 invariant
--
-- This migration runs AFTER the consolidation baseline (…_t11363-consolidation-
-- cleo-global) and many subsequent migrations, so `models_catalog` is NEVER the
-- first CREATE on a fresh DB — rootpage 2 is already owned by
-- `__drizzle_migrations` / the baseline tables. No journal pre-create is required.
--
-- `IF NOT EXISTS` so a re-open over an already-migrated DB is a no-op (idempotent).
-- Each statement is separated by a drizzle breakpoint marker line so node:sqlite
-- prepare() does not silently truncate the multi-statement file to statement one
-- (the marker token is intentionally not spelled out in this comment — drizzle's
-- readMigrationFiles splits the file on that literal substring).
--
-- @task T11733
-- @epic T11694

CREATE TABLE IF NOT EXISTS `models_catalog` (
  `id` text PRIMARY KEY NOT NULL,
  `provider_id` text NOT NULL,
  `name` text NOT NULL,
  `family` text NOT NULL,
  `attachment` integer NOT NULL DEFAULT 0,
  `reasoning` integer NOT NULL DEFAULT 0,
  `temperature` integer NOT NULL DEFAULT 1,
  `interleaved` integer NOT NULL DEFAULT 0,
  `tool_call` integer NOT NULL DEFAULT 0,
  `modalities` text NOT NULL DEFAULT '{"input":["text"],"output":["text"]}',
  `cost` text NOT NULL DEFAULT '{}',
  `context_limit` integer,
  `output_limit` integer,
  `status` text NOT NULL DEFAULT 'stable',
  `release_date` text NOT NULL,
  `models_dev_id` text NOT NULL,
  `source` text NOT NULL DEFAULT 'seed',
  `seeded_at` text NOT NULL DEFAULT (datetime('now')),
  CHECK ("status" IN ('stable', 'beta', 'preview', 'deprecated', 'retired')),
  CHECK ("attachment" IN (0, 1)),
  CHECK ("reasoning" IN (0, 1)),
  CHECK ("temperature" IN (0, 1)),
  CHECK ("interleaved" IN (0, 1)),
  CHECK ("tool_call" IN (0, 1)),
  CHECK ("release_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK ("seeded_at" IS NULL OR "seeded_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_models_catalog_provider_modeldev` ON `models_catalog` (`provider_id`, `models_dev_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_models_catalog_provider_release` ON `models_catalog` (`provider_id`, `release_date`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_models_catalog_provider_status` ON `models_catalog` (`provider_id`, `status`);
