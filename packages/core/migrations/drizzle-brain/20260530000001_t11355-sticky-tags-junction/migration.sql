-- T11355 — Denormalize brain_sticky_notes.tags_json into a sticky_tags junction.
--
-- Background:
--   packages/core/src/sticky/list.ts previously dropped the SQL LIMIT whenever a
--   tag filter was active, loaded the whole brain_sticky_notes table, JSON.parse-d
--   every row's tags_json, then .filter()-d in memory — the worst load-all-then-
--   JS-filter pattern in the repo. This junction moves tag membership filtering
--   into SQL so the LIMIT is honored and the filter is index-backed.
--
--   tags_json is RETAINED as the legacy whole-array compatibility column; the
--   junction is the membership-query SSoT and is kept in sync on every write.
--
-- Changes (idempotent — safe to re-run):
--   1. CREATE TABLE sticky_tags(sticky_id, tag) with composite PK + cascade FK.
--   2. CREATE INDEX idx_sticky_tags_tag for the WHERE tag = ? filter path.
--   3. Backfill from existing tags_json arrays via json_each. INSERT OR IGNORE
--      coalesces re-runs against the composite primary key.
--
-- @task T11355
-- @epic T11286
-- @saga T11283

CREATE TABLE IF NOT EXISTS `sticky_tags` (
  `sticky_id` text NOT NULL,
  `tag` text NOT NULL,
  CONSTRAINT `sticky_tags_pk` PRIMARY KEY(`sticky_id`, `tag`),
  CONSTRAINT `fk_sticky_tags_sticky_id_brain_sticky_notes_id_fk`
    FOREIGN KEY (`sticky_id`) REFERENCES `brain_sticky_notes`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_sticky_tags_tag` ON `sticky_tags` (`tag`);
--> statement-breakpoint

-- Backfill: explode each note's tags_json array into junction rows. json_each
-- yields zero rows for NULL/empty/non-array tags_json, so notes without tags are
-- skipped cleanly. INSERT OR IGNORE makes the backfill idempotent on re-run.
INSERT OR IGNORE INTO `sticky_tags` (`sticky_id`, `tag`)
SELECT n.`id`, je.`value`
FROM `brain_sticky_notes` AS n,
     json_each(n.`tags_json`) AS je
WHERE n.`tags_json` IS NOT NULL
  AND json_valid(n.`tags_json`)
  AND json_type(n.`tags_json`) = 'array'
  AND je.`value` IS NOT NULL;
