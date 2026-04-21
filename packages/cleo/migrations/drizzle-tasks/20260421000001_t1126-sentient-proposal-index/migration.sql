-- T1126 — partial index for Tier-2 proposal rate-limiter COUNT query.
--
-- The proposal-rate-limiter.ts COUNT query filters on:
--   labels_json LIKE '%sentient-tier2%'
--   date(created_at) = date('now')
--   status IN ('proposed', 'pending', 'active', 'done')
--
-- Without this index the query scans the entire tasks table every tick.
-- The partial index covers only rows that could match the LIKE predicate,
-- making the daily-cap check O(log n) instead of O(n).
--
-- Drizzle ORM schema note: partial indexes with .where() are not yet
-- supported in the sqliteTable callback style used by tasks-schema.ts.
-- This migration is the canonical source of truth for the index.

CREATE INDEX IF NOT EXISTS `idx_tasks_sentient_proposals_today`
ON `tasks` (date(`created_at`))
WHERE `labels_json` LIKE '%sentient-tier2%';
