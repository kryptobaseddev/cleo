-- Revert T10571 task_relations edge identity hardening.
--
-- This restores the legacy one-row-per-source/target-pair policy. If a database
-- contains multiple relation_type rows for the same task pair, the lexicographic
-- first relation_type is retained so the legacy primary key can be recreated.

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

DROP INDEX IF EXISTS `idx_task_relations_task_id_relation_type`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_task_relations_related_to_relation_type`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_task_relations_relation_type`;
--> statement-breakpoint

CREATE TABLE `__old_task_relations` (
  `task_id` text NOT NULL,
  `related_to` text NOT NULL,
  `relation_type` text DEFAULT 'related' NOT NULL
    CHECK (`relation_type` IN (
      'related',
      'blocks',
      'duplicates',
      'absorbs',
      'fixes',
      'extends',
      'supersedes',
      'groups'
    )),
  `reason` text,
  CONSTRAINT `task_relations_pk` PRIMARY KEY(`task_id`, `related_to`),
  CONSTRAINT `fk_task_relations_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_task_relations_related_to_tasks_id_fk` FOREIGN KEY (`related_to`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint

INSERT INTO `__old_task_relations` (`task_id`, `related_to`, `relation_type`, `reason`)
SELECT tr.`task_id`, tr.`related_to`, tr.`relation_type`, tr.`reason`
FROM `task_relations` tr
JOIN (
  SELECT `task_id`, `related_to`, MIN(`relation_type`) AS `relation_type`
  FROM `task_relations`
  GROUP BY `task_id`, `related_to`
) chosen
  ON chosen.`task_id` = tr.`task_id`
 AND chosen.`related_to` = tr.`related_to`
 AND chosen.`relation_type` = tr.`relation_type`;
--> statement-breakpoint

DROP TABLE `task_relations`;
--> statement-breakpoint
ALTER TABLE `__old_task_relations` RENAME TO `task_relations`;
--> statement-breakpoint

CREATE INDEX `idx_task_relations_related_to` ON `task_relations` (`related_to`);
--> statement-breakpoint

PRAGMA foreign_keys = ON;
