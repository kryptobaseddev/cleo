-- T9509 (1/2): Add `release_artifacts` polymorphic artifact registry table
-- (ADR-073 / SPEC-T9345 §3.9).
--
-- Single table covering all artifact archetypes (npm, cargo, docker, pypi,
-- github-release, binary, github-tag). Adding a new artifact type requires
-- ZERO schema changes — extend RELEASE_ARTIFACT_TYPES in tasks-schema.ts
-- and write a new row. The `metadata` column absorbs type-specific extras
-- (npm integrity hash, docker digest, cargo checksum, etc.) as a JSON blob.
--
-- Composite PRIMARY KEY: (release_id, artifact_type, identifier).
-- A monorepo release may publish 22 npm packages + 1 cargo crate + 1 docker
-- image = 24 artifact rows per release row.
--
-- FKs:
--   release_id → releases(id)  ON DELETE CASCADE
--
-- All timestamps are ISO-8601 TEXT (matches existing convention in tasks.db).
--
-- @task T9509
-- @epic T9491
-- @see SPEC-T9345 §3.9

CREATE TABLE `release_artifacts` (
  `release_id`    TEXT NOT NULL REFERENCES `releases`(`id`) ON DELETE CASCADE,
  `artifact_type` TEXT NOT NULL,
  `identifier`    TEXT NOT NULL,
  `version`       TEXT NOT NULL,
  `url`           TEXT,
  `published_at`  TEXT,
  `metadata`      TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (`release_id`, `artifact_type`, `identifier`)
);
--> statement-breakpoint

CREATE INDEX `idx_release_artifacts_release_id` ON `release_artifacts` (`release_id`);
--> statement-breakpoint
CREATE INDEX `idx_release_artifacts_artifact_type` ON `release_artifacts` (`artifact_type`);
--> statement-breakpoint
CREATE INDEX `idx_release_artifacts_published_at` ON `release_artifacts` (`published_at`);
