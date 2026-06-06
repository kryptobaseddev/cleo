-- T11826 — `docs_wikilinks`: a DERIVED, slug-addressed edge table for the docs
-- provenance graph (ratified Docs-SSoT model, saga T11778).
--
-- Background:
--   `cleo.db` is the SOLE doc authority. `docs_wikilinks` is NOT an
--   authoritative input surface — it is a minimal edge table DERIVED from the
--   three provenance columns already on `attachments`:
--     - `supersedes`     → newer→older edges (+ reverse `superseded-by`)
--     - `related_tasks`  → doc→T#### edges (JSON array, exploded via json_each)
--     - `topics`         → doc↔doc co-membership edges (shared topic slug)
--   It makes the bidirectional backlink graph queryable in O(edges) for the
--   Obsidian plugin (T11827) without recomputing the BFS. The derivation is
--   rebuilt idempotently by `rebuildDocsWikilinks` (docs/wikilinks.ts); this
--   migration creates the table and seeds the initial backfill.
--
-- Edges are slug-primary (vault links are slug-addressed and survive
-- attachment-id churn across doc versions). `to_is_task = 1` marks a
-- `related-task` edge whose `to_slug` is a `T####` id rather than a doc slug.
-- No markdown body `[[link]]` parsing is performed (AC4) — edges derive purely
-- from structured provenance columns.
--
-- Changes (idempotent — safe to re-run):
--   1. CREATE TABLE docs_wikilinks(from_slug, to_slug, relation, to_is_task,
--      derived_at) with a composite PK + supporting indices.
--   2. Backfill `supersedes` + `superseded-by` doc→doc edges by joining
--      `attachments` to itself on the supersedes/superseded_by FK and resolving
--      both endpoints to their slugs.
--   3. Backfill `related-task` doc→T#### edges by exploding `related_tasks`
--      JSON arrays via json_each.
--   4. Backfill `topic` doc↔doc edges: any two distinct slugged docs that share
--      a topic slug (json_each over `topics`) get a symmetric pair of edges.
--   INSERT OR IGNORE coalesces re-runs against the composite primary key.
--
-- DEPENDS ON: 20260524000000_t10158-docs-provenance-columns (adds supersedes /
--             superseded_by / topics / related_tasks to `attachments`)
-- SAFE FOR:   SQLite 3.35+ (CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE)
--
-- @task T11826
-- @epic T11781 (E3-OBSIDIAN-INTEGRATION)
-- @saga T11778 (SG-DOCS-SSOT-VAULT)

CREATE TABLE IF NOT EXISTS `docs_wikilinks` (
  `from_slug` text NOT NULL,
  `to_slug` text NOT NULL,
  `relation` text NOT NULL,
  `to_is_task` integer NOT NULL DEFAULT 0,
  `derived_at` text NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT `docs_wikilinks_pk` PRIMARY KEY(`from_slug`, `to_slug`, `relation`)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_docs_wikilinks_from` ON `docs_wikilinks` (`from_slug`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_docs_wikilinks_to` ON `docs_wikilinks` (`to_slug`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_docs_wikilinks_relation` ON `docs_wikilinks` (`relation`);
--> statement-breakpoint

-- (2) supersedes: newer (a) → older (a.supersedes) doc→doc edge.
INSERT OR IGNORE INTO `docs_wikilinks` (`from_slug`, `to_slug`, `relation`, `to_is_task`)
SELECT a.`slug`, b.`slug`, 'supersedes', 0
FROM `attachments` AS a
JOIN `attachments` AS b ON b.`id` = a.`supersedes`
WHERE a.`slug` IS NOT NULL
  AND b.`slug` IS NOT NULL
  AND a.`supersedes` IS NOT NULL;
--> statement-breakpoint

-- (2b) superseded-by: older (a) → newer (a.superseded_by) doc→doc reverse edge.
INSERT OR IGNORE INTO `docs_wikilinks` (`from_slug`, `to_slug`, `relation`, `to_is_task`)
SELECT a.`slug`, b.`slug`, 'superseded-by', 0
FROM `attachments` AS a
JOIN `attachments` AS b ON b.`id` = a.`superseded_by`
WHERE a.`slug` IS NOT NULL
  AND b.`slug` IS NOT NULL
  AND a.`superseded_by` IS NOT NULL;
--> statement-breakpoint

-- (3) related-task: doc → T#### edge from the related_tasks JSON array.
INSERT OR IGNORE INTO `docs_wikilinks` (`from_slug`, `to_slug`, `relation`, `to_is_task`)
SELECT a.`slug`, je.`value`, 'related-task', 1
FROM `attachments` AS a,
     json_each(a.`related_tasks`) AS je
WHERE a.`slug` IS NOT NULL
  AND a.`related_tasks` IS NOT NULL
  AND json_valid(a.`related_tasks`)
  AND json_type(a.`related_tasks`) = 'array'
  AND je.`value` IS NOT NULL;
--> statement-breakpoint

-- (4) topic: symmetric doc↔doc edge for any two distinct slugged docs sharing a
-- topic slug. The self-join over json_each(topics) produces both directions
-- because (a,b) and (b,a) are both yielded when a.slug <> b.slug.
INSERT OR IGNORE INTO `docs_wikilinks` (`from_slug`, `to_slug`, `relation`, `to_is_task`)
SELECT a.`slug`, b.`slug`, 'topic', 0
FROM `attachments` AS a,
     json_each(a.`topics`) AS ta,
     `attachments` AS b,
     json_each(b.`topics`) AS tb
WHERE a.`slug` IS NOT NULL
  AND b.`slug` IS NOT NULL
  AND a.`slug` <> b.`slug`
  AND a.`topics` IS NOT NULL
  AND b.`topics` IS NOT NULL
  AND json_valid(a.`topics`)
  AND json_valid(b.`topics`)
  AND json_type(a.`topics`) = 'array'
  AND json_type(b.`topics`) = 'array'
  AND ta.`value` = tb.`value`
  AND ta.`value` IS NOT NULL;
