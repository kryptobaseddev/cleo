# JSON-Column Storage Decision Matrix (JSONB / TEXT / DENORMALIZE)

Status: accepted
Epic: T11286 (EP-JSON-STORAGE-OPTIMIZATION)
Saga: T11283 (SG-COGNITIVE-SUBSTRATE)
Task: T11354
Source audit: `.cleo/rcasd/json-storage-jsonb-audit.md`
Runtime: node:sqlite 3.53.0 (JSONB + `jsonb_*()` functions supported since SQLite 3.45.0)

## Purpose

This spec is the tracked, durable reference for how CLEO classifies each
JSON-bearing SQLite column by access pattern. It freezes the per-field
decisions from the 62-column audit so future schema work does not re-litigate
them, and it documents the load-bearing JSONB read/backup discipline.

## Decision classes

| Class | Storage | When |
|---|---|---|
| **TEXT** (keep) | `text` column, `JSON.parse` on read | read-whole blob, never SQL-queried |
| **JSONB** | `blob` via `jsonb()` customType | queried / mutated / append-hot *inside SQL* |
| **DENORMALIZE** | scalar column or junction table | membership-hot; filtered/joined in SQL |

## Totals (62 JSON-bearing columns audited)

| Class | Count |
|---|---|
| TEXT (keep) | 49 |
| JSONB (blob + customType) | 9 |
| DENORMALIZE (junction) | 2 firm (+ ~4 low-priority watch-list) |
| Special (not JSON-semantic) | 2 |

## JSONB targets (9)

| table.column | why JSONB |
|---|---|
| `tasks.notes_json` (`dedupHash`) | `LIKE '%"dedupHash":"…"%'` → exact `jsonb_extract($.dedupHash)`; append-heavy |
| `sessions.notes_json` | append-on-every-event → `jsonb_insert($[#])` not RMW-whole-array |
| `sessions.tasks_completed_json` | append-heavy id-list |
| `sessions.tasks_created_json` | append-heavy id-list |
| `schema_meta.value` (`task_id_sequence`) | in-SQL `json_extract` + `json_set` on every task create |
| `brain_page_nodes.metadata_json` | `metadata_json LIKE ?` → `jsonb_extract` |
| `brain_retrieval_log.entry_ids` | `json_each` via fragile `replace()` rebuild; append-heavy |
| `attachments.related_tasks` | already `json_each` membership — pure speedup |
| `attachments.topics` / `attachments.keywords` | same json_each pattern |

Low-priority JSONB-if-append-hot: `lifecycle_stages.notes_json`,
`warp_chain_instances.gate_results`.

## DENORMALIZE targets (2 firm)

1. **`brain_sticky_notes.tags_json` → `sticky_tags(sticky_id, tag)`** (T11355).
   `sticky/list.ts` dropped the SQL `LIMIT`, loaded the whole table,
   `JSON.parse`-d every row, and JS-`.filter()`-d — the worst pattern in the
   repo. Tag filtering now runs in SQL via the junction, honoring `LIMIT`.
2. **`tasks.labels_json` → `task_labels(task_id, label)`** (T11356). Fragile
   `LIKE '%label%'` matched across array boundaries and was unindexable.
   Replaced with a junction join. Mirrors `task_dependencies` /
   `task_relations`.

Low-priority DENORM watch-list (keep TEXT until queried):
`manifest_entries.linked_tasks_json`, `release_changesets.task_ids`,
`brain_observations.concepts_json`, signaldock `agents.capabilities/skills`.

## TEXT (keep) — 49 columns

All read-whole blobs, e.g. `tasks.{acceptance,files,verification,ivtr_state}`,
`sessions.{handoff,debrief,stats}_json`, all `audit_log.*_json`,
`token_usage.metadata`, all `manifest_*`/`lifecycle_*` metadata, brain
read-whole columns, all `nexus_*`, all conduit/signaldock metadata/payload.
JSONB on any of these only adds the `json()` read tax with no SQL-query benefit.

## Drizzle JSONB pattern (rc.3 — no native `jsonb()` builder)

The reusable helper lives at `packages/core/src/store/schema/jsonb.ts`:

```ts
export const jsonb = <T>(name: string) =>
  customType<{ data: T; driverData: Buffer | Uint8Array }>({
    dataType: () => 'blob',
    toDriver: (v: T) => sql`jsonb(${JSON.stringify(v)})`, // store as JSONB BLOB
    fromDriver: () => { throw new Error('read via json(col) — see jsonbText'); },
  })(name);

// Whole-value read helper — projects json(col) and parses the TEXT:
export function jsonbText<T>(col) { return sql`json(${col})`.mapWith((t) => JSON.parse(t)); }
```

## Load-bearing read & backup rule (version-instability constraint)

The on-disk JSONB binary encoding is **opaque and version-unstable** — it is
NOT cross-version portable.

- **Whole-value reads MUST use `SELECT json(col)`** (via `jsonbText`), never
  `JSON.parse` of the raw BLOB. The `jsonb()` customType's `fromDriver` throws
  if a raw BLOB reaches application code, so a forgetful `SELECT *` fails loudly
  instead of silently parsing version-unstable bytes.
- **In-SQL access** uses `jsonb_extract` / `json_each` / `jsonb_insert` on the
  BLOB directly.
- **Backups / exports MUST `json(col)` the value back to TEXT.** A
  `VACUUM INTO` snapshot preserves bytes verbatim (same engine, safe), but any
  logical dump / cross-machine export / JSON serialization path MUST project
  through `json()` first.
- `float[]` payloads (e.g. `brain_memory_trees.centroid`) are Float32 BLOBs, NOT
  JSONB.
