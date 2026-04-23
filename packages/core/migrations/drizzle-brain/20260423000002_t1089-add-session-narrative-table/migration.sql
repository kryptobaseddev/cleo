-- T1089 PSYCHE Wave 3: Add session_narrative table to brain.db
--
-- Context: T1082 Wave 3 Continuous Dialectic Evaluator & Observer Upgrade.
-- Adds the session_narrative table to store a rolling prose summary of each
-- CLEO session, maintained by the Dialectic Evaluator's appendNarrativeDelta().
--
-- session_id      TEXT PRIMARY KEY
--   Matches the CLEO session ID from the session store.
--
-- narrative       TEXT NOT NULL DEFAULT ''
--   Rolling prose summary of the session (max 2000 chars in application layer).
--   Oldest content is trimmed from the left when the limit is exceeded.
--
-- turn_count      INTEGER NOT NULL DEFAULT 0
--   Number of dialectic turns that have contributed to this narrative.
--   Incremented by appendNarrativeDelta() on each write.
--
-- last_updated_at INTEGER NOT NULL DEFAULT 0
--   Unix epoch milliseconds of the most recent narrative update.
--
-- pivot_count     INTEGER NOT NULL DEFAULT 0
--   Number of detected topic pivots in this session.
--   Incremented when detectPivot() returns true for a new delta.
--
-- Note: session-narrative.ts also includes CREATE TABLE IF NOT EXISTS DDL for
-- zero-dep startup resilience before this migration is applied.
-- That DDL is kept in sync with the authoritative schema below.
--
-- Reversibility: additive new table. DROP TABLE is safe and sufficient.
-- This migration has no dependencies on T1084 (peer_id) schema.

CREATE TABLE `session_narrative` (
  `session_id`      text PRIMARY KEY NOT NULL,
  `narrative`       text NOT NULL DEFAULT '',
  `turn_count`      integer NOT NULL DEFAULT 0,
  `last_updated_at` integer NOT NULL DEFAULT 0,
  `pivot_count`     integer NOT NULL DEFAULT 0
);
