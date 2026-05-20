-- T9756 (T9738-D / A4 carryforward): Rewrite legacy releases.id PKs from the
-- `legacy:<version>` shape to the uniform `<projectHash>:<version>` shape that
-- the new (T9492) pipeline path already uses.
--
-- Background
-- ──────────
-- T9686-B2 unified `release_manifests` (legacy) and `releases` (new) into one
-- table for expediency, encoding provenance via PK shape:
--   * new-pipeline rows:    `<projectHash>:<version>`  (e.g. `1e3146b7352b:v2026.6.0`)
--   * legacy-migrated rows: `legacy:<version>`         (e.g. `legacy:v2026.5.73`)
--
-- That dual shape requires downstream consumers (e.g. `releasesRowToManifest`
-- in packages/core/src/release/release-manifest.ts) to branch on a PK-prefix
-- check. This migration eliminates that branch by rewriting every legacy row's
-- PK to the uniform shape — choosing a STATIC `projectHash` baked into the
-- SQL because migrations have no runtime context (they run before the CLI is
-- even constructed).
--
-- Choice of projectHash
-- ─────────────────────
-- The hard-coded value `1e3146b7352b` is the canonical hash for `/mnt/projects/cleocode`
-- (the CLEO source repository itself), computed via
-- `crypto.createHash('sha256').update('/mnt/projects/cleocode').digest('hex').slice(0,12)`
-- — see {@link generateProjectHash} in `packages/core/src/nexus/hash.ts`.
--
-- Multi-project caveat
-- ────────────────────
-- This migration ships in the `@cleocode/cleo` npm package and therefore runs
-- against EVERY consumer's `tasks.db`, not just the cleocode repo. The
-- assumption that all legacy rows belong to the cleocode project breaks for
-- consumers who:
--   (a) ran the pre-T9492 12-step `release_manifests` pipeline on their own
--       repo (very rare — that pipeline was internal-only and never shipped
--       to external consumers), AND
--   (b) actually have `legacy:`-prefixed rows in their `releases` table at
--       the moment they install the version carrying this migration.
--
-- For (b)-positive consumers, the rewritten PK will mis-attribute legacy rows
-- to the cleocode project's hash. This is COSMETIC, not data-destructive:
--   * The `version`, `status`, and content columns are unchanged.
--   * The PK is opaque outside its discriminator role; no FK consumer parses
--     it for semantics.
--   * The `project_hash` column on the row remains NULL (this migration does
--     NOT populate it), so the row is still distinguishable from properly
--     attributed new-pipeline rows.
--
-- A follow-up backfill task may correctly re-attribute mis-hashed legacy rows
-- by inspecting the row's `created_at` against the project's git history (or
-- by surveying consumers directly). For now, the cosmetic risk is acceptable.
--
-- Idempotency
-- ───────────
-- The UPDATE statements are guarded by `WHERE id LIKE 'legacy:%'` (or the
-- equivalent on dependent tables) so re-running is a no-op. The migration is
-- replay-safe; cross-instance idempotent in the drizzle journal sense.
--
-- Dependent tables (release_id FK)
-- ────────────────────────────────
-- All four junction tables reference `releases(id)` and must be updated in
-- lockstep with the PK rewrite:
--   * release_commits        — (release_id, commit_sha)
--   * release_changes        — release_id NOT NULL
--   * release_artifacts      — (release_id, artifact_type, identifier)
--   * brain_release_links    — (brain_entry_id, release_id, link_type)
--
-- Foreign keys on `releases(id)` are CASCADE ON DELETE; an UPDATE of the
-- parent PK requires explicit ON UPDATE CASCADE, which the original DDLs do
-- NOT have. We therefore disable foreign_keys for the duration of the UPDATE
-- sequence and rewrite both sides explicitly.
--
-- DESTRUCTIVE: downgrade past this migration via `revert.sql` flips the PKs
-- back to `legacy:` shape. Any external system that captured the new PK
-- between apply and revert will hold stale references.
--
-- @task T9756
-- @epic T9752
-- @see packages/core/migrations/drizzle-tasks/20260519010000_t9686b2-unify-releases-tables/migration.sql
-- @see packages/core/src/nexus/hash.ts (generateProjectHash)
-- @see packages/core/src/release/release-manifest.ts (releasesRowToManifest)

PRAGMA foreign_keys=OFF;
--> statement-breakpoint

-- ── Step 1: Rewrite legacy PKs on dependent tables FIRST ────────────────
-- Order matters: child rows reference the old `legacy:` PK; if we updated
-- the parent first the child rows would dangle (FKs are OFF but logical
-- integrity still matters for the in-flight rewrite).
--
-- The REPLACE is anchored by `WHERE release_id LIKE 'legacy:%'` so it only
-- touches rows that were migrated by T9686-B2 — new-pipeline rows are
-- untouched.

UPDATE `release_commits`
   SET `release_id` = '1e3146b7352b:' || SUBSTR(`release_id`, LENGTH('legacy:') + 1)
 WHERE `release_id` LIKE 'legacy:%';
--> statement-breakpoint

UPDATE `release_changes`
   SET `release_id` = '1e3146b7352b:' || SUBSTR(`release_id`, LENGTH('legacy:') + 1)
 WHERE `release_id` LIKE 'legacy:%';
--> statement-breakpoint

UPDATE `release_artifacts`
   SET `release_id` = '1e3146b7352b:' || SUBSTR(`release_id`, LENGTH('legacy:') + 1)
 WHERE `release_id` LIKE 'legacy:%';
--> statement-breakpoint

UPDATE `brain_release_links`
   SET `release_id` = '1e3146b7352b:' || SUBSTR(`release_id`, LENGTH('legacy:') + 1)
 WHERE `release_id` LIKE 'legacy:%';
--> statement-breakpoint

-- ── Step 2: Rewrite the parent PKs ──────────────────────────────────────
-- Using SUBSTR rather than REPLACE so we ONLY strip the leading `legacy:`
-- prefix — guards against pathological data where `legacy:` happens to
-- appear later in the version string (e.g. `legacy:v1-legacy:hotfix`).

UPDATE `releases`
   SET `id` = '1e3146b7352b:' || SUBSTR(`id`, LENGTH('legacy:') + 1)
 WHERE `id` LIKE 'legacy:%';
--> statement-breakpoint

PRAGMA foreign_keys=ON;
