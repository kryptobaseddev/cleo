-- Fix orphaned parent_id values pointing to non-existent tasks (T5034).
-- Sets parent_id to NULL for any task whose parent has been deleted.
UPDATE tasks SET parent_id = NULL
WHERE parent_id IS NOT NULL
  AND parent_id NOT IN (SELECT id FROM tasks);
