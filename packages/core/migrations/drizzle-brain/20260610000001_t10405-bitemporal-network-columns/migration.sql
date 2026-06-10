-- T10405 (SG-PSYCHE-FOUNDATION · Tier 5): bitemporal `expired_at` + four-network `network`.
--
-- Completes the Graphiti 4-timestamp bitemporal model on the four BRAIN tables.
-- Prior schema shipped created_at + valid_at + invalid_at; this migration adds the
-- 4th timestamp `expired_at` (TRANSACTION-time end — when a row was retracted from
-- the active store, distinct from `invalid_at` = VALID-time end). It also adds the
-- four-network classification column `network` (world / bank / opinion / observation
-- per masterplan §16.D Mem0-V3 envelope). Both columns are declared in
-- memory-schema.ts; this file is their forward Drizzle DDL (T9179 precedent —
-- columns reach a fresh DB via Drizzle, never via the retired ensureColumns()).
--
-- Per-table `network` DEFAULT matches the row's cognitive role:
--   brain_decisions    → 'bank'        (durable account-of-record)
--   brain_patterns     → 'world'       (objective recurring behaviour)
--   brain_learnings    → 'opinion'     (evaluative belief, updates on evidence)
--   brain_observations → 'observation' (raw episodic event)
--
-- The enum is enforced in-app (no SQLite CHECK constraint — Lesson 3 convention).
-- All statements are ALTER TABLE ADD COLUMN / CREATE INDEX IF NOT EXISTS → atomic
-- + idempotent on SQLite 3.35+. The migration-manager reconciler marks this
-- migration applied-without-running when the columns already exist (consolidated
-- cleo.db path), or executes it directly on a standalone / fresh brain DB.
--
-- SAFE FOR: SQLite 3.35+ (ALTER TABLE ADD COLUMN is atomic)

ALTER TABLE brain_decisions ADD COLUMN expired_at TEXT;
--> statement-breakpoint
ALTER TABLE brain_decisions ADD COLUMN network TEXT DEFAULT 'bank';
--> statement-breakpoint
ALTER TABLE brain_patterns ADD COLUMN expired_at TEXT;
--> statement-breakpoint
ALTER TABLE brain_patterns ADD COLUMN network TEXT DEFAULT 'world';
--> statement-breakpoint
ALTER TABLE brain_learnings ADD COLUMN expired_at TEXT;
--> statement-breakpoint
ALTER TABLE brain_learnings ADD COLUMN network TEXT DEFAULT 'opinion';
--> statement-breakpoint
ALTER TABLE brain_observations ADD COLUMN expired_at TEXT;
--> statement-breakpoint
ALTER TABLE brain_observations ADD COLUMN network TEXT DEFAULT 'observation';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_decisions_expired_at
  ON brain_decisions (expired_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_decisions_network
  ON brain_decisions (network);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_patterns_expired_at
  ON brain_patterns (expired_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_patterns_network
  ON brain_patterns (network);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_learnings_expired_at
  ON brain_learnings (expired_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_learnings_network
  ON brain_learnings (network);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_observations_expired_at
  ON brain_observations (expired_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_observations_network
  ON brain_observations (network);
--> statement-breakpoint
-- T10405 (Tier 6): exponential-backoff gate on the derivation queue.
-- A re-queued item carries `next_attempt_at = now + base * 2^retryCount` so the
-- worker's claim query skips it until the backoff window elapses (no hot-loop on
-- a transiently-failing item). NULL = claimable now (default for new items).
ALTER TABLE deriver_queue ADD COLUMN next_attempt_at TEXT;

