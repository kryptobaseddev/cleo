-- T10505 — Backfill `task_acceptance_criteria` from legacy `tasks.acceptance_json`.
--
-- Wave 2b of Epic T10381 (E-AC-MIGRATION) under Saga T10377
-- (SG-IVTR-AC-BINDING). PR 4 of 8 in the AC-binding migration train.
--
-- ## What this migration does
--
--   Step 1: For every task whose `acceptance_json` column contains a
--           non-empty JSON array AND has NO existing rows in
--           `task_acceptance_criteria`, expand each non-empty array
--           element into a row in `task_acceptance_criteria`. The
--           UUIDv4 `id` is generated in pure SQL via the canonical
--           `printf` + `randomblob` pattern (see "UUID generation"
--           below). The `ordinal` is the 1-based position within the
--           source JSON array (preserving authorship order).
--
--   Step 2: For every newly-backfilled AC row that has NO existing
--           `task_acceptance_criteria_history` row with reason='backfill',
--           insert an audit row recording the original AC text and
--           reason='backfill'. The history table's `ac_id` column is
--           plain TEXT (not an FK, per T10504 design) so this works
--           even though the AC rows were just inserted.
--
-- ## Why pure SQL (no JS data-migration runner)
--
-- CLEO's migration runtime (`packages/core/src/store/migration-manager.ts`)
-- applies plain `.sql` files via drizzle-orm's `migrate()`. There is no
-- post-DDL JavaScript callback hook (see the runtime contract in
-- `packages/core/migrations/README.md` §"Runtime Contract"). Adding one
-- would be an architectural change far larger than this backfill warrants.
--
-- Per AC8 the migration must handle: pipe/JSON-split correctness,
-- idempotency, ordinal assignment, history-row creation, whitespace
-- skipping — all of which SQLite's `json_each` + window functions
-- support natively.
--
-- ## UUID generation (UUIDv4 in pure SQL)
--
-- The canonical writer path uses `crypto.randomUUID()` (Node 24 native).
-- For migration-time backfill we must generate compatible UUIDv4s
-- without a JS callback. SQLite's `randomblob(N)` returns N
-- cryptographically-random bytes; `hex(...)` formats them as
-- lowercase hex. We then assemble the canonical
-- `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` UUIDv4 shape:
--
--   * Hex digit at position 13 is forced to `4` (version 4).
--   * Hex digit at position 17 is forced to one of `8|9|a|b` (RFC 4122
--     variant), selected uniformly from `'89ab'` via `abs(random()) % 4`.
--
-- The generated IDs are indistinguishable from `crypto.randomUUID()`
-- output for downstream consumers. Collision probability with the
-- existing PK space is 2^-122 — astronomically lower than a single
-- hardware bit-flip on the same machine.
--
-- ## Idempotency contract (AC2)
--
-- The Step 1 `INSERT ... SELECT` is gated by
--   `NOT EXISTS (SELECT 1 FROM task_acceptance_criteria ac
--                WHERE ac.task_id = t.id)`
-- This guarantees that re-running the migration on a DB whose AC table
-- is already populated for the source task produces ZERO new rows. The
-- Step 2 history insert is gated by
--   `NOT EXISTS (SELECT 1 FROM task_acceptance_criteria_history h
--                WHERE h.ac_id = ac.id AND h.reason = 'backfill')`
-- which guarantees no duplicate audit rows on re-application.
--
-- Per the runtime contract, drizzle-orm's `__drizzle_migrations` journal
-- already prevents re-application under normal operation; the gates
-- above harden against journal-bypass recovery paths (Scenario 3 in
-- migration-manager.ts).
--
-- ## Whitespace and shape handling (AC4 + AC5)
--
-- The CASE inside `split_ac` handles two `acceptance_json` element
-- shapes observed in the wild (matching `parseAcceptanceJson` in
-- `packages/core/src/sentient/hygiene-scan.ts`):
--
--   * Plain text: element is a JSON string, `j.type = 'text'`,
--     `j.value` IS the raw text (NOT a quoted JSON literal).
--   * Object form: element is `{"criteria": "..."}`, `j.type =
--     'object'`, `j.value` is the JSON object string; we extract
--     `$.criteria` via `json_extract`.
--
-- Each extracted text is `trim(..., char(9,10,13,32))`ed — explicit
-- char set covers tab/newline/CR/space because SQLite's default
-- `trim(x)` strips ASCII space ONLY. Any element trimming to the
-- empty string is filtered out by the trailing `WHERE ac_text != ''`.
-- This skips whitespace-only and empty-string elements per AC5.
--
-- ## Malformed-JSON safety
--
-- We wrap the `acceptance_json` input to `json_each(...)` in a CASE
-- expression that returns `'[]'` whenever the value is NULL, not
-- valid JSON, or not a JSON array. Without this guard, a single
-- malformed row anywhere in `tasks` would abort the entire migration
-- because `json_each` raises `SQLITE_ERROR: malformed JSON` at plan
-- time. (Empirically verified — `json_valid` short-circuits inside
-- a CASE but the `json_each(t.col)` form does not.)
--
-- ## Legacy column preservation (AC7)
--
-- This migration is READ-ONLY against `tasks.acceptance_json`. The
-- column is NEVER altered or dropped — back-compat read paths
-- (hygiene-scan, workflow-telemetry, etc.) still resolve AC text
-- through `acceptance_json` until the cutover wave later in Epic
-- T10381 retires it.
--
-- DEPENDS ON:
--   * 20260524000002_t10502-task-acceptance-criteria   (AC table)
--   * 20260524000004_t10504-ac-history                 (history table)
-- Timestamp seconds `05` orders this AFTER both.
--
-- SAFE FOR: SQLite 3.35+ (RETURNING, window functions, json_each all GA).
--
-- @adr  ADR-079-r1 §2.1 §2.2 §D6
-- @saga T10377
-- @epic T10381
-- @task T10505
-- @decision D013

-- ── Step 1: Expand acceptance_json into task_acceptance_criteria rows ──
-- The CASE-wrapped json_each guards against malformed inputs without
-- aborting the migration. The NOT EXISTS clause makes this idempotent.
-- ROW_NUMBER() OVER (PARTITION BY task_id) emits the 1-based ordinal.
WITH split_ac AS (
  SELECT
    t.`id`         AS task_id,
    j.`key`        AS json_idx,
    trim(
      CASE
        WHEN j.`type` = 'text'   THEN j.`value`
        WHEN j.`type` = 'object' THEN COALESCE(json_extract(j.`value`, '$.criteria'), '')
        ELSE ''
      END,
      char(9, 10, 13, 32)
    )              AS ac_text
  FROM `tasks` t, json_each(
    CASE
      WHEN t.`acceptance_json` IS NOT NULL
        AND json_valid(t.`acceptance_json`)
        AND json_type(t.`acceptance_json`) = 'array'
      THEN t.`acceptance_json`
      ELSE '[]'
    END
  ) j
  WHERE NOT EXISTS (
    SELECT 1
      FROM `task_acceptance_criteria` ac
     WHERE ac.`task_id` = t.`id`
  )
)
INSERT INTO `task_acceptance_criteria` (`id`, `task_id`, `ordinal`, `text`)
SELECT
  -- UUIDv4 in pure SQL: see "UUID generation" header comment.
  printf(
    '%s-%s-4%s-%s%s-%s',
    lower(hex(randomblob(4))),
    lower(hex(randomblob(2))),
    substr(lower(hex(randomblob(2))), 2, 3),
    substr('89ab', abs(random()) % 4 + 1, 1),
    substr(lower(hex(randomblob(2))), 2, 3),
    lower(hex(randomblob(6)))
  ),
  `task_id`,
  ROW_NUMBER() OVER (PARTITION BY `task_id` ORDER BY `json_idx`),
  `ac_text`
FROM `split_ac`
WHERE `ac_text` != '';
--> statement-breakpoint

-- ── Step 2: Append backfill history rows for every newly-created AC ──
-- The history table has no FK on ac_id (T10504 design — orphan-tolerant
-- for drift forensics) so this works against the rows we just inserted.
-- The NOT EXISTS clause prevents duplicate backfill audit rows on
-- re-application of the migration.
INSERT INTO `task_acceptance_criteria_history` (`ac_id`, `previous_text`, `reason`)
SELECT
  ac.`id`,
  ac.`text`,
  'backfill'
FROM `task_acceptance_criteria` ac
WHERE NOT EXISTS (
  SELECT 1
    FROM `task_acceptance_criteria_history` h
   WHERE h.`ac_id`  = ac.`id`
     AND h.`reason` = 'backfill'
);
