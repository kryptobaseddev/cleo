-- T10571 — Harden task_relations for the non-containment edge graph.
--
-- PM-Core V2 reserves tasks.parent_id as the single containment edge and keeps
-- task_relations for secondary/non-containment graph semantics only. A pair of
-- tasks may legitimately have more than one semantic relation (for example a
-- cross-reference plus a supersession edge), so relation_type is part of row
-- identity. The optional reason column documents why the non-containment edge
-- exists, and lookup indexes cover source/type, target/type, and type scans.
--
-- @task T10571
-- @saga T10538

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

DROP INDEX IF EXISTS `idx_task_relations_related_to`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_task_relations_task_id_relation_type`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_task_relations_related_to_relation_type`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_task_relations_relation_type`;
--> statement-breakpoint

CREATE TABLE `__new_task_relations` (
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
  CONSTRAINT `task_relations_pk` PRIMARY KEY(`task_id`, `related_to`, `relation_type`),
  CONSTRAINT `fk_task_relations_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_task_relations_related_to_tasks_id_fk` FOREIGN KEY (`related_to`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint

INSERT INTO `__new_task_relations` (`task_id`, `related_to`, `relation_type`, `reason`)
SELECT `task_id`, `related_to`, `relation_type`, `reason`
FROM `task_relations`;
--> statement-breakpoint

DROP TABLE `task_relations`;
--> statement-breakpoint
ALTER TABLE `__new_task_relations` RENAME TO `task_relations`;
--> statement-breakpoint

CREATE INDEX `idx_task_relations_task_id_relation_type` ON `task_relations` (`task_id`, `relation_type`);
--> statement-breakpoint
CREATE INDEX `idx_task_relations_related_to_relation_type` ON `task_relations` (`related_to`, `relation_type`);
--> statement-breakpoint
CREATE INDEX `idx_task_relations_relation_type` ON `task_relations` (`relation_type`);
--> statement-breakpoint

PRAGMA foreign_keys = ON;
