ALTER TABLE tasks ADD COLUMN assignee TEXT;--> statement-breakpoint
CREATE INDEX idx_tasks_assignee ON tasks (assignee);
