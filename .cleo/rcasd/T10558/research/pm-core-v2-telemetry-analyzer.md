# T10558 — PM-Core V2 read-only telemetry analyzer

## Key Findings

Read-only source: copied `/mnt/projects/cleocode/.cleo/tasks.db` to `.tmp-t10558/tasks-T10558-readonly-copy.db` in the T10558 CLEO worktree, then ran SQLite with `PRAGMA query_only=ON`.

Exact counts from the copied database:

| Metric | Count | Query/source |
| --- | ---: | --- |
| Legacy saga label rows | 61 | `tasks.labels_json` JSON array contains case-insensitive `saga` |
| `type='saga'` rows | 1 | `tasks.type` case-insensitive equals `saga`; row is `T10429` |
| `groups` relation edges | 171 | `task_relations.relation_type='groups'` |
| Parent-id edges under saga ids | 99 | `tasks.parent_id` points to any saga id discovered by legacy label or type |
| Mirrored parent_id edges matching groups | 14 | Same `(saga_id, child_id)` exists both as `tasks.parent_id` and as `task_relations(task_id, related_to, 'groups')` |

Schema evidence:

- `tasks` has `id`, `title`, `type`, `parent_id`, and `labels_json`; it does not have a scalar `label` column.
- `task_relations` has `task_id`, `related_to`, and `relation_type`.

SQL used:

```sql
PRAGMA query_only=ON;

SELECT count(DISTINCT t.id)
FROM tasks t, json_each(CASE WHEN json_valid(t.labels_json) THEN t.labels_json ELSE '[]' END) j
WHERE lower(j.value)='saga';

SELECT count(*)
FROM tasks
WHERE lower(coalesce(type,''))='saga';

SELECT count(*)
FROM task_relations
WHERE relation_type='groups';

WITH saga_ids AS (
  SELECT DISTINCT t.id
  FROM tasks t
  LEFT JOIN json_each(CASE WHEN json_valid(t.labels_json) THEN t.labels_json ELSE '[]' END) j
  WHERE lower(coalesce(t.type,''))='saga' OR lower(coalesce(j.value,''))='saga'
), parent_edges AS (
  SELECT parent_id AS saga_id, id AS child_id
  FROM tasks
  WHERE parent_id IN (SELECT id FROM saga_ids)
), groups_edges AS (
  SELECT task_id AS saga_id, related_to AS child_id
  FROM task_relations
  WHERE relation_type='groups'
)
SELECT count(*) FROM parent_edges;
SELECT count(*)
FROM parent_edges p
JOIN groups_edges g
  ON g.saga_id=p.saga_id AND g.child_id=p.child_id;
```

The only `type='saga'` row found was:

```text
T10429 | smoke-test-AC6-T10326-v3 | type=saga | parent_id=T9796 | labels_json=[]
```

Mirrored parent-id/group edges found:

```text
T10176 -> T10192
T10176 -> T10193
T10176 -> T10194
T10176 -> T10195
T10176 -> T10218
T10180 -> T10211
T10180 -> T10212
T10180 -> T10213
T10180 -> T10214
T10180 -> T10215
T10180 -> T10216
T10180 -> T10217
T10400 -> T10427
T10404 -> T10426
```

## Needs Follow-up

- Clarify whether PM-Core V2 should treat all 99 `parent_id` edges under saga ids as legacy violations, or only the 14 rows mirrored by an existing `groups` edge.
- Migrate consumers away from scalar `label` assumptions; current storage uses `labels_json`.
- After the canonical `type='saga'` migration lands, rerun these queries to confirm `legacy saga label rows` trends to 0 and `type='saga'` becomes the canonical saga count.
