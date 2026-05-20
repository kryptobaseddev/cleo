-- Revert for T9756: flip `<projectHash>:<version>` rows BACK to `legacy:<version>`
-- shape, restoring the post-T9686-B2 dual-shape encoding.
--
-- Idempotent: the WHERE clause `LIKE '1e3146b7352b:%'` ensures only rows that
-- the T9756 forward migration touched are flipped back. Properly
-- attributed new-pipeline rows that happen to share the cleocode project
-- hash will ALSO be flipped here — this is the inverse of the forward
-- migration's mis-attribution risk. Consumers who reverted on a non-cleocode
-- project should verify they have no genuine `1e3146b7352b:*` new-pipeline
-- rows before applying this revert. (Practically: virtually no consumer
-- has rows under this exact project hash.)
--
-- @task T9756
-- @epic T9752

PRAGMA foreign_keys=OFF;
--> statement-breakpoint

UPDATE `brain_release_links`
   SET `release_id` = 'legacy:' || SUBSTR(`release_id`, LENGTH('1e3146b7352b:') + 1)
 WHERE `release_id` LIKE '1e3146b7352b:%';
--> statement-breakpoint

UPDATE `release_artifacts`
   SET `release_id` = 'legacy:' || SUBSTR(`release_id`, LENGTH('1e3146b7352b:') + 1)
 WHERE `release_id` LIKE '1e3146b7352b:%';
--> statement-breakpoint

UPDATE `release_changes`
   SET `release_id` = 'legacy:' || SUBSTR(`release_id`, LENGTH('1e3146b7352b:') + 1)
 WHERE `release_id` LIKE '1e3146b7352b:%';
--> statement-breakpoint

UPDATE `release_commits`
   SET `release_id` = 'legacy:' || SUBSTR(`release_id`, LENGTH('1e3146b7352b:') + 1)
 WHERE `release_id` LIKE '1e3146b7352b:%';
--> statement-breakpoint

UPDATE `releases`
   SET `id` = 'legacy:' || SUBSTR(`id`, LENGTH('1e3146b7352b:') + 1)
 WHERE `id` LIKE '1e3146b7352b:%';
--> statement-breakpoint

PRAGMA foreign_keys=ON;
