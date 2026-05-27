-- T9755: Backfill legacy v5.x ship commits into the `commits` table and
-- re-enable the `merge_commit_sha` FK on `releases`.
--
-- Background: PR #328 (T9686-B2 unify-releases-tables) RELAXED the FK from
-- `releases.merge_commit_sha` → `commits.sha` from a hard REFERENCES to a
-- soft text column. The reason: the unification migration copied ~16 legacy
-- ship SHAs out of `release_manifests.commit_sha`, but those SHAs were not
-- present in the `commits` table (the table was added in T9506 well after
-- those releases were cut). A hard FK at copy time would have either
-- nullified the SHA links or failed the migration.
--
-- The v5.88 CHANGELOG (T9686-B2 entry) flags re-enablement as a follow-up.
-- This migration is that follow-up.
--
-- WHAT THIS MIGRATION DOES
--
--   Step 1: INSERT one `commits` row per legacy v5.80 → v5.88 ship/merge
--           SHA referenced by `releases.merge_commit_sha`. Idempotent via
--           ON CONFLICT(sha) DO NOTHING so re-applying the migration on a
--           DB whose commits table already has these rows is a no-op.
--
--   Step 2: REBUILD `releases` with the hard FK back in place
--           (`merge_commit_sha TEXT REFERENCES commits(sha) ON DELETE SET NULL`)
--           via the standard SQLite create-new-table → copy → drop → rename
--           dance (PRAGMA foreign_keys=OFF wraps the rebuild). Indexes are
--           recreated to match the post-rebuild table.
--
-- WHY 18 ENTRIES INSTEAD OF 9
--
-- For each v5.80 → v5.88 release there are typically two relevant SHAs:
--   - the canonical `release: ship vX.Y.Z ...` commit (always present), and
--   - the PR merge commit `Merge pull request #N from .../release/vX.Y.Z`
--     (present when shipped via a PR, missing only when the ship commit was
--     pushed directly).
--
-- Both can appear in `releases.merge_commit_sha` depending on whether the
-- row was written by the new release-publish workflow (which records the PR
-- merge SHA) or by hand (which records the ship SHA). To make the FK
-- restoration succeed for any historical row, we backfill both.
--
-- v5.86 is the hotfix release with subject prefix `release(T9739): ship ...`
-- — this matches the same Conventional Commits `release` type as the
-- standard form `release: ship ...` so `conventional_type` is `release`
-- across all 18 rows.
--
-- The PR squash-merge entry for v5.88 (#352) uses subject `release: ship
-- v2026.5.88 — T9738 IVTR remediation close (#352)` (Keaton Hoskins / GitHub
-- committer) and has the ship commit `ebee726e5...` as its second parent.
-- Both are inserted: the squash-merge as the canonical row used by
-- release-publish, and the ship commit as the row used by anything that
-- recorded the SHA before the PR was merged.
--
-- WHY ALL DATA INLINE
--
-- This migration MUST be self-contained — no runtime `git show` or
-- subprocess execution. Migrations run on operator machines that may not
-- have the cleocode repo cloned, or may have a shallow clone where these
-- SHAs are unreachable. The 18 SHA → metadata mappings below are
-- hand-extracted from `git show --format='%H|%s|%aN|%aE|%aI|%cI|%P'` on
-- the cleocode repo at HEAD = 23dc2cc5e (v5.88 PR squash merge).
--
-- @task T9755
-- @epic T9752
-- @see /mnt/projects/cleocode/packages/core/migrations/drizzle-tasks/20260519010000_t9686b2-unify-releases-tables/migration.sql
-- @see CHANGELOG.md (v2026.5.88 — T9686-B2 follow-up note)

PRAGMA foreign_keys=OFF;
--> statement-breakpoint

-- ── Step 1: Backfill legacy v5.80 → v5.88 commits ─────────────────────────
-- One INSERT per SHA. `is_release_commit = 1` for every row (all are ship
-- or release-merge commits). `is_merge_commit = 1` only on PR-merge rows
-- (those whose `parent_shas` JSON has 2 entries).

-- v5.80 PR merge — Merge pull request #288 from kryptobaseddev/release/v2026.5.80
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '9f1eac565d44818f7c803e3327aaed4d5d830c67',
  '9f1eac5',
  'Keaton Hoskins',
  '95310582+kryptobaseddev@users.noreply.github.com',
  '2026-05-18T20:11:47-07:00',
  'GitHub',
  'noreply@github.com',
  '2026-05-18T20:11:47-07:00',
  'Merge pull request #288 from kryptobaseddev/release/v2026.5.80',
  'Merge pull request #288 from kryptobaseddev/release/v2026.5.80',
  'merge',
  1,
  1,
  '["c63377fe8896079539eb7a81122a01e8b109686a","1e1f2302b1ad5ed764206f573b6ca07d638cfa5b"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.80 ship commit
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '1e1f2302b1ad5ed764206f573b6ca07d638cfa5b',
  '1e1f230',
  'kryptobaseddev',
  'kryptobaseddev@users.noreply.github.com',
  '2026-05-18T20:07:47-07:00',
  'kryptobaseddev',
  'kryptobaseddev@users.noreply.github.com',
  '2026-05-18T20:07:47-07:00',
  'release: ship v2026.5.80 — T9580 CLI dispatch fixes',
  'release: ship v2026.5.80 — T9580 CLI dispatch fixes',
  'release',
  1,
  0,
  '["b2b82fa8982f06fd0a3b343050ce39c9ef0f8b95"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.81 PR merge — Merge pull request #298
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '572630ee6a54b94a904ae6c79a7a86fc3a5054b0',
  '572630e',
  'Keaton Hoskins',
  '95310582+kryptobaseddev@users.noreply.github.com',
  '2026-05-18T21:11:08-07:00',
  'GitHub',
  'noreply@github.com',
  '2026-05-18T21:11:08-07:00',
  'Merge pull request #298 from kryptobaseddev/release/v2026.5.81',
  'Merge pull request #298 from kryptobaseddev/release/v2026.5.81',
  'merge',
  1,
  1,
  '["e330a47d2d9af28e50142dc18ca7eca07ed474a7","f2b2466bf9f5f53c5ab6f619a30490621c27e903"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.81 ship commit
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  'f2b2466bf9f5f53c5ab6f619a30490621c27e903',
  'f2b2466',
  'kryptobaseddev',
  'kryptokeaton@gmail.com',
  '2026-05-18T20:59:47-07:00',
  'kryptobaseddev',
  'kryptokeaton@gmail.com',
  '2026-05-18T20:59:47-07:00',
  'release: ship v2026.5.81 — T9580 closeout + post-ship cleanup',
  'release: ship v2026.5.81 — T9580 closeout + post-ship cleanup',
  'release',
  1,
  0,
  '["6e748c5811e3ec4964cfebdfc09275145c325b15"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.82 PR merge — Merge pull request #307
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '101c0eb6f637cdc92165ade04ceef58f8f4dd014',
  '101c0eb',
  'Keaton Hoskins',
  '95310582+kryptobaseddev@users.noreply.github.com',
  '2026-05-19T01:19:21-07:00',
  'GitHub',
  'noreply@github.com',
  '2026-05-19T01:19:21-07:00',
  'Merge pull request #307 from kryptobaseddev/release/v2026.5.82',
  'Merge pull request #307 from kryptobaseddev/release/v2026.5.82',
  'merge',
  1,
  1,
  '["338290fd571c667bfbe4f46aa1bc9c5953c4c767","1386636d32bfd58d90d900e2636c02cc939025a8"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.82 ship commit
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '1386636d32bfd58d90d900e2636c02cc939025a8',
  '1386636',
  'kryptobaseddev',
  'kryptobaseddev@users.noreply.github.com',
  '2026-05-19T01:09:53-07:00',
  'kryptobaseddev',
  'kryptobaseddev@users.noreply.github.com',
  '2026-05-19T01:09:53-07:00',
  'release: ship v2026.5.82 — E-PROJECT-ROOT-AUDIT closure (T9580 epic)',
  'release: ship v2026.5.82 — E-PROJECT-ROOT-AUDIT closure (T9580 epic)',
  'release',
  1,
  0,
  '["338290fd571c667bfbe4f46aa1bc9c5953c4c767"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.83 PR merge — Merge pull request #317
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '6607fc2cd09f0bd700bf6bdbcc7d7aac75873b4d',
  '6607fc2',
  'Keaton Hoskins',
  '95310582+kryptobaseddev@users.noreply.github.com',
  '2026-05-19T11:11:41-07:00',
  'GitHub',
  'noreply@github.com',
  '2026-05-19T11:11:41-07:00',
  'Merge pull request #317 from kryptobaseddev/release/v2026.5.83',
  'Merge pull request #317 from kryptobaseddev/release/v2026.5.83',
  'merge',
  1,
  1,
  '["ce026501fdaad08e80017f4a83eeb084c2be50e3","5638ac5f567a9420c9c18b356ed1640f4236f526"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.83 ship commit
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '5638ac5f567a9420c9c18b356ed1640f4236f526',
  '5638ac5',
  'kryptobaseddev',
  'kryptobaseddev@users.noreply.github.com',
  '2026-05-19T10:55:05-07:00',
  'kryptobaseddev',
  'kryptobaseddev@users.noreply.github.com',
  '2026-05-19T10:55:05-07:00',
  'release: ship v2026.5.83 — T9685 strict-mode flip',
  'release: ship v2026.5.83 — T9685 strict-mode flip',
  'release',
  1,
  0,
  '["ce026501fdaad08e80017f4a83eeb084c2be50e3"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.84 PR merge — Merge pull request #329
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  'bd4bba8f654722a0e4ebd491bbb8b500cf8ae4d0',
  'bd4bba8',
  'Keaton Hoskins',
  '95310582+kryptobaseddev@users.noreply.github.com',
  '2026-05-19T15:58:17-07:00',
  'GitHub',
  'noreply@github.com',
  '2026-05-19T15:58:17-07:00',
  'Merge pull request #329 from kryptobaseddev/release/v2026.5.84-ship',
  'Merge pull request #329 from kryptobaseddev/release/v2026.5.84-ship',
  'merge',
  1,
  1,
  '["88d6fabcc5c94c4e67631f264d4547e1c538e10f","1867e9778f7c02807d543435dd6bd29fc89abddd"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.84 ship commit
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '1867e9778f7c02807d543435dd6bd29fc89abddd',
  '1867e97',
  'kryptobaseddev',
  'kryptobaseddev@users.noreply.github.com',
  '2026-05-19T15:55:42-07:00',
  'kryptobaseddev',
  'kryptobaseddev@users.noreply.github.com',
  '2026-05-19T15:55:42-07:00',
  'release: ship v2026.5.84 — SG-CLEO-SKILLS Sphere A close (T9560)',
  'release: ship v2026.5.84 — SG-CLEO-SKILLS Sphere A close (T9560)',
  'release',
  1,
  0,
  '["88d6fabcc5c94c4e67631f264d4547e1c538e10f"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.85 PR merge — Merge pull request #339
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '856353ebe45a4904e461fe00f326bd83d863ded8',
  '856353e',
  'Keaton Hoskins',
  '95310582+kryptobaseddev@users.noreply.github.com',
  '2026-05-19T22:59:47-07:00',
  'GitHub',
  'noreply@github.com',
  '2026-05-19T22:59:47-07:00',
  'Merge pull request #339 from kryptobaseddev/release/v2026.5.85-ship',
  'Merge pull request #339 from kryptobaseddev/release/v2026.5.85-ship',
  'merge',
  1,
  1,
  '["7633add8c02bf8e01ba69631513bc2fa50d1c33d","018b2cd7d36c0edde68234544834d9bc076c08d8"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.85 ship commit
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '018b2cd7d36c0edde68234544834d9bc076c08d8',
  '018b2cd',
  'kryptobaseddev',
  'kryptobaseddev@users.noreply.github.com',
  '2026-05-19T22:58:40-07:00',
  'kryptobaseddev',
  'kryptobaseddev@users.noreply.github.com',
  '2026-05-19T22:58:40-07:00',
  'release: ship v2026.5.85 — SG-CLEO-SKILLS Sphere B close + Sphere A follow-ups (T9560)',
  'release: ship v2026.5.85 — SG-CLEO-SKILLS Sphere B close + Sphere A follow-ups (T9560)',
  'release',
  1,
  0,
  '["7633add8c02bf8e01ba69631513bc2fa50d1c33d"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.86 PR merge — Merge pull request #348 (hotfix)
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '85fa011fb08eb4e49f94be4ac92071e5b7f80b6e',
  '85fa011',
  'Keaton Hoskins',
  '95310582+kryptobaseddev@users.noreply.github.com',
  '2026-05-20T00:07:57-07:00',
  'GitHub',
  'noreply@github.com',
  '2026-05-20T00:07:57-07:00',
  'Merge pull request #348 from kryptobaseddev/release/v2026.5.86-hotfix',
  'Merge pull request #348 from kryptobaseddev/release/v2026.5.86-hotfix',
  'merge',
  1,
  1,
  '["567cd12de0d23d37d09aaf98d95968a165f2b8d1","8a0a0131a536730a0017cf9de056d18f4a86e800"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.86 ship commit (hotfix, scoped `release(T9739)`)
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '8a0a0131a536730a0017cf9de056d18f4a86e800',
  '8a0a013',
  'kryptobaseddev',
  'kryptokeaton@gmail.com',
  '2026-05-20T00:06:56-07:00',
  'kryptobaseddev',
  'kryptokeaton@gmail.com',
  '2026-05-20T00:06:56-07:00',
  'release(T9739): ship v2026.5.86 — hotfix biome lint on generated command-manifest.ts (v2026.5.85 release workflow rescue)',
  'release(T9739): ship v2026.5.86 — hotfix biome lint on generated command-manifest.ts (v2026.5.85 release workflow rescue)',
  'release',
  1,
  0,
  '["567cd12de0d23d37d09aaf98d95968a165f2b8d1"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.87 PR merge — Merge pull request #351
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '422ff7353365f7e3ab5b2e1b7ca824e0b486ded6',
  '422ff73',
  'Keaton Hoskins',
  '95310582+kryptobaseddev@users.noreply.github.com',
  '2026-05-20T00:31:56-07:00',
  'GitHub',
  'noreply@github.com',
  '2026-05-20T00:31:56-07:00',
  'Merge pull request #351 from kryptobaseddev/release/v2026.5.87-saga-t9625',
  'Merge pull request #351 from kryptobaseddev/release/v2026.5.87-saga-t9625',
  'merge',
  1,
  1,
  '["de6c1cd9dc17af6ca53e8e3b91ef1883a4eee016","d36146b979ed0c50b4275400074188dabce79c86"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.87 ship commit
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  'd36146b979ed0c50b4275400074188dabce79c86',
  'd36146b',
  'kryptobaseddev',
  'kryptokeaton@gmail.com',
  '2026-05-20T00:19:14-07:00',
  'kryptobaseddev',
  'kryptokeaton@gmail.com',
  '2026-05-20T00:19:14-07:00',
  'release: ship v2026.5.87 — SG-CLEO-DOCS-CANON Saga close (T9625)',
  'release: ship v2026.5.87 — SG-CLEO-DOCS-CANON Saga close (T9625)',
  'release',
  1,
  0,
  '["89c94a75f857c70b121610292a55064b9a7fe654"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.88 PR squash merge — release: ship v2026.5.88 ... (#352)
-- NOTE: this is the PR squash-merge commit, NOT a `Merge pull request`-style
-- merge. It still has 2 parents (the v5.87 PR merge and the ship commit).
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  '23dc2cc5e10176697f14f172c4ee5b94937fd7fc',
  '23dc2cc',
  'Keaton Hoskins',
  '95310582+kryptobaseddev@users.noreply.github.com',
  '2026-05-20T01:00:31-07:00',
  'GitHub',
  'noreply@github.com',
  '2026-05-20T01:00:31-07:00',
  'release: ship v2026.5.88 — T9738 IVTR remediation close (#352)',
  'release: ship v2026.5.88 — T9738 IVTR remediation close (#352)',
  'release',
  1,
  1,
  '["812e380ce5fae1ec852793dd00c5683c135f416f","ebee726e5318d3cd7407310d0c44c0b53ead392b"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- v5.88 ship commit (the underlying squashed work)
INSERT INTO `commits` (
  `sha`, `short_sha`, `author_name`, `author_email`, `authored_at`,
  `committer_name`, `committer_email`, `committed_at`, `message`, `subject`,
  `conventional_type`, `is_release_commit`, `is_merge_commit`, `parent_shas`
) VALUES (
  'ebee726e5318d3cd7407310d0c44c0b53ead392b',
  'ebee726',
  'kryptobaseddev',
  'kryptokeaton@gmail.com',
  '2026-05-20T00:50:34-07:00',
  'kryptobaseddev',
  'kryptokeaton@gmail.com',
  '2026-05-20T00:50:34-07:00',
  'release: ship v2026.5.88 — T9738 IVTR functional bug remediation close',
  'release: ship v2026.5.88 — T9738 IVTR functional bug remediation close',
  'release',
  1,
  0,
  '["812e380ce5fae1ec852793dd00c5683c135f416f"]'
)
ON CONFLICT(`sha`) DO NOTHING;
--> statement-breakpoint

-- ── Step 2: Re-enable the `merge_commit_sha` FK via table rebuild ─────────
-- SQLite can't ALTER a constraint in place; we rebuild the table with the
-- hard FK and copy every row across. This mirrors the rebuild dance from
-- T9686-B2 — same column set, same default values, same indexes — but
-- ADDS BACK the `REFERENCES commits(sha) ON DELETE SET NULL` constraint
-- that was dropped in Step 3 of that earlier migration.
--
-- All junction tables (release_commits, release_changes, release_artifacts,
-- brain_release_links) reference `releases(id)` by name — they continue to
-- resolve to the rebuilt table after RENAME.
--
-- Because PRAGMA foreign_keys=OFF wraps the entire migration, the copy
-- succeeds even though some `merge_commit_sha` values may still be NULL or
-- (transiently) reference commits not yet inserted on a partial backfill —
-- when we PRAGMA foreign_keys=ON at the end, SQLite re-validates the FKs
-- against the now-populated `commits` table.

CREATE TABLE `releases_rebuilt` (
  `id`                TEXT PRIMARY KEY NOT NULL,
  `version`           TEXT NOT NULL UNIQUE,
  `scheme`            TEXT NOT NULL DEFAULT 'calver',
  `channel`           TEXT NOT NULL DEFAULT 'latest',
  `epic_id`           TEXT REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  `release_kind`      TEXT NOT NULL DEFAULT 'regular',
  `status`            TEXT NOT NULL DEFAULT 'planned',
  `previous_version`  TEXT,
  `merge_commit_sha`  TEXT REFERENCES `commits`(`sha`) ON DELETE SET NULL,  -- HARD FK restored (T9755)
  `pr_id`             TEXT REFERENCES `pull_requests`(`id`) ON DELETE SET NULL,
  `workflow_run_url`  TEXT,
  `created_at`        TEXT NOT NULL DEFAULT (datetime('now')),
  `planned_at`        TEXT,
  `pr_opened_at`      TEXT,
  `pr_merged_at`      TEXT,
  `published_at`      TEXT,
  `reconciled_at`     TEXT,
  `rolled_back_at`    TEXT,
  `failed_at`         TEXT,
  `cancelled_at`      TEXT,
  `failure_reason`    TEXT,
  `rolled_back_by`    TEXT,
  `project_hash`      TEXT,
  -- Legacy columns merged in by T9686-B2 (preserved):
  `tasks_json`        TEXT,
  `changelog`         TEXT,
  `notes`             TEXT,
  `git_tag`           TEXT,
  `prepared_at`       TEXT,
  `committed_at`      TEXT,
  `tagged_at`         TEXT,
  `pushed_at`         TEXT
);
--> statement-breakpoint

INSERT INTO `releases_rebuilt` (
  `id`, `version`, `scheme`, `channel`, `epic_id`, `release_kind`, `status`,
  `previous_version`, `merge_commit_sha`, `pr_id`, `workflow_run_url`,
  `created_at`, `planned_at`, `pr_opened_at`, `pr_merged_at`, `published_at`,
  `reconciled_at`, `rolled_back_at`, `failed_at`, `cancelled_at`,
  `failure_reason`, `rolled_back_by`, `project_hash`,
  `tasks_json`, `changelog`, `notes`, `git_tag`,
  `prepared_at`, `committed_at`, `tagged_at`, `pushed_at`
)
SELECT
  `id`, `version`, `scheme`, `channel`, `epic_id`, `release_kind`, `status`,
  `previous_version`, `merge_commit_sha`, `pr_id`, `workflow_run_url`,
  `created_at`, `planned_at`, `pr_opened_at`, `pr_merged_at`, `published_at`,
  `reconciled_at`, `rolled_back_at`, `failed_at`, `cancelled_at`,
  `failure_reason`, `rolled_back_by`, `project_hash`,
  `tasks_json`, `changelog`, `notes`, `git_tag`,
  `prepared_at`, `committed_at`, `tagged_at`, `pushed_at`
FROM `releases`;
--> statement-breakpoint

DROP TABLE `releases`;
--> statement-breakpoint

ALTER TABLE `releases_rebuilt` RENAME TO `releases`;
--> statement-breakpoint

-- ── Step 3: Recreate indexes on the rebuilt table ─────────────────────────
-- Same set as T9686-B2 Step 4 — drizzle's schema layer expects these by name.
CREATE INDEX `idx_releases_version` ON `releases` (`version`);
--> statement-breakpoint
CREATE INDEX `idx_releases_status` ON `releases` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_releases_channel` ON `releases` (`channel`);
--> statement-breakpoint
CREATE INDEX `idx_releases_epic_id` ON `releases` (`epic_id`);
--> statement-breakpoint
CREATE INDEX `idx_releases_merge_commit_sha` ON `releases` (`merge_commit_sha`);
--> statement-breakpoint
CREATE INDEX `idx_releases_project_hash` ON `releases` (`project_hash`);
--> statement-breakpoint
CREATE INDEX `idx_releases_published_at` ON `releases` (`published_at`);
--> statement-breakpoint
CREATE INDEX `idx_releases_pushed_at` ON `releases` (`pushed_at`);
--> statement-breakpoint

PRAGMA foreign_keys=ON;
