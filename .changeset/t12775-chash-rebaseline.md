---
id: t12775-chash-rebaseline
tasks: [T12775]
kind: fix
summary: A migration's data backfill is never emitted, and the row-meta content hash follows it under the new sync-set version (journal B, migration half)
---

Journal spec §2.3a rule 3. Migrations already ran with the capture triggers dropped, so their backfills were never emitted. That is correct, because every replica runs the same deterministic migration. But `_sync_row_meta.chash` kept the pre-migration hash, so the next repair diff would have read every migrated row as an uncaptured edit.

After each migration on a store with sealed rows, the canonical open now re-baselines `chash` to the live rows and emits nothing. Tombstones keep the hash they were deleted with. `syncSetVersion` is a hash of the sync set's captured columns, secrets and references as the schema now has them, and the baseline is recorded under that version in `_sync_meta`. The hook lives in `store/sync/migration-hooks.ts` (`syncMigrationHooks`), which wraps the existing capture bracket hooks.

The other half of T12775, suspect marking at rewriter call sites (bundle import, partial restore, twin collapse), is team-p0-caps'.
