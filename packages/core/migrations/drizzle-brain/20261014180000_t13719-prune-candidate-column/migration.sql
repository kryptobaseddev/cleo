-- T13719: `prune_candidate` on the four typed BRAIN tables, as forward DDL.
--
-- The column was added at runtime by quality-feedback.ts's ad-hoc ALTER, so a
-- store that never ran that code lacked it, and a synced joiner refused every
-- brain op naming it (refused-schema). As a migration it reaches every store
-- when its brain schema is established (the brain bind, sync apply, genesis).
-- The consolidated reconciler marks this applied without running it when the
-- columns already exist.

ALTER TABLE brain_decisions ADD COLUMN prune_candidate INTEGER DEFAULT 0;
--> statement-breakpoint
ALTER TABLE brain_patterns ADD COLUMN prune_candidate INTEGER DEFAULT 0;
--> statement-breakpoint
ALTER TABLE brain_learnings ADD COLUMN prune_candidate INTEGER DEFAULT 0;
--> statement-breakpoint
ALTER TABLE brain_observations ADD COLUMN prune_candidate INTEGER DEFAULT 0;
