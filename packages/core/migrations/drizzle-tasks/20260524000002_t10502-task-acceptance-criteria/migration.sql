-- T10502 — Create `task_acceptance_criteria` table per ADR-079-r1 §2.1 + §2.2.
--
-- First of three parallel-safe schemas in Wave 2a of Epic T10381
-- (E-AC-MIGRATION) under Saga T10377 (SG-IVTR-AC-BINDING).
--
-- Replaces the JSON-array `tasks.acceptance_json` column for new writes
-- with first-class rows. Each Acceptance Criterion (AC) gets exactly one
-- canonical identifier — a UUIDv4 generated at AC creation by
-- `crypto.randomUUID()` (Node 24 native, no external dep). The UUID is
-- the sole primary key and binds Validator verdicts, `satisfies:`
-- evidence atoms (T10503/T10504), and CI gate references.
--
-- The `ordinal` column carries the 1-based insertion-order alias that
-- powers the `AC<n>` display label (e.g. `AC1`, `AC2`). Per ADR-079-r1
-- §2.2, ordinals are NEVER reused — deleting AC2 leaves a gap and
-- subsequent ACs continue from the highest existing ordinal. The
-- persistence layer never renumbers; the (taskId, ordinal) UNIQUE index
-- enforces the no-collision invariant.
--
-- The `content_hash` column is an OPTIONAL sha256(text) snapshot for
-- drift detection by the future `task_acceptance_criteria_history`
-- companion (T10503). Writers MAY leave it NULL; readers MUST NOT treat
-- NULL as "text unchanged".
--
-- Schema:
--   id            TEXT PRIMARY KEY    — UUIDv4, immutable, generated at creation
--   task_id       TEXT NOT NULL FK    — REFERENCES tasks(id) ON DELETE CASCADE
--   ordinal       INTEGER NOT NULL    — 1-based monotonic, never reused per task
--   text          TEXT NOT NULL       — the AC statement itself
--   created_at    TEXT NOT NULL       — DEFAULT CURRENT_TIMESTAMP (ISO 8601)
--   updated_at    TEXT                — last-edit timestamp, NULL until first edit
--   content_hash  TEXT                — optional sha256(text) for drift detection
--
-- Indices:
--   idx_task_acceptance_criteria_task_id          — `WHERE task_id = ?` lookup
--   uq_task_acceptance_criteria_task_ordinal      — UNIQUE (task_id, ordinal)
--
-- FKs:
--   task_id → tasks(id) ON DELETE CASCADE
--
-- Forward-only and additive — no data backfill in this PR. The legacy
-- `tasks.acceptance_json` column remains the read-path SSoT until the
-- backfill + cutover wave later in Epic T10381.
--
-- DEPENDS ON: 20260318205539_initial (creates `tasks`).
-- SAFE FOR:   SQLite 3.35+ (CREATE TABLE + CREATE INDEX are atomic).
--
-- @adr  ADR-079-r1 §2.1 §2.2 §4.2
-- @saga T10377
-- @epic T10381
-- @task T10502
-- @decision D013

CREATE TABLE IF NOT EXISTS `task_acceptance_criteria` (
  `id`            TEXT PRIMARY KEY NOT NULL,
  `task_id`       TEXT NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `ordinal`       INTEGER NOT NULL,
  `text`          TEXT NOT NULL,
  `created_at`    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  `updated_at`    TEXT,
  `content_hash`  TEXT
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_task_acceptance_criteria_task_id`
  ON `task_acceptance_criteria` (`task_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `uq_task_acceptance_criteria_task_ordinal`
  ON `task_acceptance_criteria` (`task_id`, `ordinal`);
