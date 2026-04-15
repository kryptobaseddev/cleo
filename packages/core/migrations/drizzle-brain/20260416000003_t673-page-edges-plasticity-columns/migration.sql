-- T673-M3: Add plasticity tracking columns to brain_page_edges.
--
-- Adds 6 new columns enabling the STDP plasticity substrate:
--   last_reinforced_at    — ISO 8601 timestamp of last LTP event
--   reinforcement_count   — count of LTP events applied lifetime (DEFAULT 0)
--   plasticity_class      — routing class: 'static' | 'hebbian' | 'stdp' (DEFAULT 'static')
--   last_depressed_at     — ISO 8601 timestamp of last LTD event
--   depression_count      — count of LTD events applied lifetime (DEFAULT 0)
--   stability_score       — tanh(rc/10) * exp(-(days/30)), null = not yet computed
--
-- Seeding strategy:
--   - All existing edges: plasticity_class = 'static' (safe default via ALTER TABLE)
--   - co_retrieved edges are overridden to 'hebbian' (Hebbian strengthener origin)
--
-- New indexes:
--   idx_brain_edges_last_reinforced — decay pass filter (skip recently reinforced)
--   idx_brain_edges_plasticity_class — class routing (skip static edges in decay)
--   idx_brain_edges_stability — fast stable-edge skip filter
--
-- Per docs/specs/stdp-wire-up-spec.md §2.1.3 and T673-council-schema.md §4.3.

ALTER TABLE `brain_page_edges` ADD COLUMN `last_reinforced_at` text;
--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD COLUMN `reinforcement_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD COLUMN `plasticity_class` text NOT NULL DEFAULT 'static';
--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD COLUMN `last_depressed_at` text;
--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD COLUMN `depression_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD COLUMN `stability_score` real;
--> statement-breakpoint

-- Seed: co_retrieved edges are Hebbian-origin, not static.
-- This UPDATE is idempotent — re-running sets already-hebbian rows to hebbian.
UPDATE `brain_page_edges` SET plasticity_class = 'hebbian' WHERE edge_type = 'co_retrieved';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_brain_edges_last_reinforced` ON `brain_page_edges` (`last_reinforced_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_edges_plasticity_class` ON `brain_page_edges` (`plasticity_class`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_edges_stability` ON `brain_page_edges` (`stability_score`);
