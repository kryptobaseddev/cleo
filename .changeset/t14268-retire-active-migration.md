---
id: t14268-retire-active-migration
tasks: [T14268]
kind: feat
summary: "a project store is snapshotted before its first pending migration, and a migration retires stored active with one audit row per task"
---

- Before the first pending migration of a project store, the open writes one
  `migration` system backup (`cleo.db.migration-<stamp>` and its sidecar)
  inside the cold-open lease, so concurrent opens of a store mid-upgrade take
  one snapshot. When the snapshot cannot be written, a pending set with data
  DML (any INSERT, REPLACE, UPDATE or DELETE, a table rebuild's copy
  included) is refused with `E_MIGRATION_SNAPSHOT_REQUIRED`; a schema-only
  set warns and proceeds. New and in-memory stores are skipped.
- Migration `t14268-retire-active` rewrites stored `active` to `pending`
  (D11230: `active` is a live claim lease). Each retired task first gets an
  audit row (`task_active_retired`, id `t14268-retire-active-<task id>`, at
  the row's `updated_at`) that keeps the lease it held.
