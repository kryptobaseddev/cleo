---
id: t12894-brain-row-identity
tasks: [T12894]
kind: feat
summary: "Brain text-keyed tables get row uids in both the project and global stores"
---

The brain tables keyed by a TEXT id now carry a row uid in both scopes: decisions,
patterns, learnings, observations, page nodes, attention, backfill runs, the
observation staging and promotion logs, transcript events and session narratives
(project and global), plus the global sticky notes. Each minted table also gets
a birth fingerprint. The migration `20261010120000_t12894-brain-row-uids` adds the
columns and unique indexes, and the open fills existing rows deterministically, so
two devices that share a history derive the same uid. On a 1.3 GB cleocode store
copy, the fill of 48,013 brain rows took about 1.2 s.

The global store's identity schema is now checked and healed at open like the
project store's. `brain_attention`'s INTEGER epoch-ms `created_at` is read as the
uid timestamp.

The brain FTS5 update triggers now fire only when an indexed column changes
(`AFTER UPDATE OF id, title, narrative`, and so on). Before, the uid fill's UPDATE
fired them before the row was indexed, and the replayed `'delete'` corrupted the
index ("database disk image is malformed"). An existing store's triggers are
rewritten at open, before any fill runs. The newly synced brain tables' text
timestamps join the one-time canonical rewrite in both scopes, and
`brain_decisions` (a self-parent through `supersedes`) declares the `conflict`
remote-delete policy.
