---
id: brain-schema-before-sync-apply
tasks: [T13719]
kind: fix
summary: a sync joiner that never opened brain no longer refuses brain ops, and refused-schema ops retry once the schema has their columns
---

The `drizzle-brain` lineage ran only when the brain domain bound. A joining
device whose sync pull ran before any brain open lacked `network` (and
`prune_candidate`, which only an ad-hoc runtime ALTER ever added), so it
marked every brain observation op `refused-schema`, and their follow-up
updates waited forever on "row not seen yet". A genesis cut taken before
brain opened snapshotted the old shape too.

- The sync pull and the genesis cut now bring the brain tables current
  first (`establishLazySchemas`), then regenerate the capture triggers for
  any new column.
- `prune_candidate` is a forward `drizzle-brain` migration; the ad-hoc
  ALTER in quality feedback is gone. It is classed `local-only` (a per-device
  curation flag), so it never travels in ops.
- The consolidated brain reconciler skips an ADD COLUMN whose column already
  exists, so a partly applied column set no longer throws "duplicate column
  name" on every brain open, pull and genesis cut.
- Every apply call re-opens the stream's `refused-schema` transactions, so
  one applies as soon as the store has what it names. Nothing replayed them
  before, not even after an upgrade.
