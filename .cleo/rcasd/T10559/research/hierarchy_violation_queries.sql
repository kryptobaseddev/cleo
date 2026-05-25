-- T10559 hierarchy violation detection queries
-- Source DB must be a copied snapshot of .cleo/tasks.db; set PRAGMA query_only=ON before running.
PRAGMA query_only=ON;

-- Type normalization used by all reports:
--   saga: type='saga' OR legacy type='epic' with labels_json containing 'saga'
--   epic/task/subtask: lower(trim(type))

-- 1. Cycle detector over tasks.parent_id edges.
WITH RECURSIVE
  norm AS (
    SELECT id, title, parent_id,
      CASE
        WHEN lower(trim(coalesce(type,'')))='saga' THEN 'saga'
        WHEN lower(trim(coalesce(type,'')))='epic' AND EXISTS (SELECT 1 FROM json_each(coalesce(labels_json,'[]')) WHERE value='saga') THEN 'saga'
        ELSE lower(trim(coalesce(type,'')))
      END AS tier
    FROM tasks
  ),
  walk(origin, node, path, depth, cycle) AS (
    SELECT id, parent_id, id || '>' || coalesce(parent_id,'NULL'), 1,
      CASE WHEN parent_id = id THEN 1 ELSE 0 END
    FROM norm
    WHERE parent_id IS NOT NULL
    UNION ALL
    SELECT walk.origin, norm.parent_id, walk.path || '>' || coalesce(norm.parent_id,'NULL'), walk.depth + 1,
      CASE WHEN instr('>' || walk.path || '>', '>' || coalesce(norm.parent_id,'NULL') || '>') > 0 THEN 1 ELSE 0 END
    FROM walk
    JOIN norm ON norm.id = walk.node
    WHERE walk.node IS NOT NULL AND walk.cycle = 0 AND walk.depth < 64
  )
SELECT origin, path, depth FROM walk WHERE cycle=1 ORDER BY origin;

-- 2. Blank/null type rows.
SELECT id, title, status, parent_id, type, labels_json
FROM tasks
WHERE type IS NULL OR trim(type)=''
ORDER BY id;

-- 3. Tier matrix violations on parent_id hierarchy edges.
WITH norm AS (
  SELECT id, title, parent_id, status, type, labels_json,
    CASE
      WHEN lower(trim(coalesce(type,'')))='saga' THEN 'saga'
      WHEN lower(trim(coalesce(type,'')))='epic' AND EXISTS (SELECT 1 FROM json_each(coalesce(labels_json,'[]')) WHERE value='saga') THEN 'saga'
      ELSE lower(trim(coalesce(type,'')))
    END AS tier
  FROM tasks
), edges AS (
  SELECT child.id AS child_id, child.title AS child_title, child.status AS child_status,
         child.tier AS child_tier, child.type AS child_type, child.labels_json AS child_labels,
         parent.id AS parent_id, parent.title AS parent_title, parent.tier AS parent_tier,
         parent.type AS parent_type, parent.labels_json AS parent_labels
  FROM norm child
  JOIN norm parent ON parent.id = child.parent_id
)
SELECT * FROM edges
WHERE NOT (
  (parent_tier='epic' AND child_tier='task')
  OR (parent_tier='task' AND child_tier='subtask')
)
ORDER BY parent_tier, child_tier, parent_id, child_id;

-- 4. Orphan roots: non-saga/non-epic active task rows with parent_id NULL.
WITH norm AS (
  SELECT id, title, status, parent_id, type, labels_json,
    CASE
      WHEN lower(trim(coalesce(type,'')))='saga' THEN 'saga'
      WHEN lower(trim(coalesce(type,'')))='epic' AND EXISTS (SELECT 1 FROM json_each(coalesce(labels_json,'[]')) WHERE value='saga') THEN 'saga'
      ELSE lower(trim(coalesce(type,'')))
    END AS tier
  FROM tasks
)
SELECT id, title, status, type, labels_json
FROM norm
WHERE parent_id IS NULL AND tier NOT IN ('saga','epic') AND status NOT IN ('archived','cancelled')
ORDER BY id;
