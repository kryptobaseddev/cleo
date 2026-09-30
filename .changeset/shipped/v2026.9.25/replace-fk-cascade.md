---
id: replace-fk-cascade
tasks: [T12787, T12789]
kind: fix
summary: REPLACE on FK parent tables no longer cascade-deletes children; AC edits apply as a diff so surviving criteria keep their evidence bindings; REPLACE is banned by gate 28
---

`INSERT OR REPLACE` resolves a uniqueness conflict by deleting the existing row
and inserting a new one. With foreign keys enforced, SQLite runs the ON DELETE
action of every foreign key that references the deleted row, so a same-key
REPLACE on a parent table deleted its `ON DELETE CASCADE` children (or nulled
its `SET NULL` ones), even though a row with the same key was back a moment
later.

Acceptance-criteria edits no longer delete and re-create every criterion of
the task (T12789). `applyAcPlan` used to run `DELETE … WHERE task_id = ?` and
then re-insert the new set, including the criteria that did not change. Where
`evidence_ac_bindings.ac_id … ON DELETE CASCADE` is declared and foreign keys
are enforced, that delete wiped the evidence bound to every criterion, not
only to the ones being removed. The plan is now applied as a diff. Criteria
that leave the set are deleted, kept ids are updated in place, and only new
ids are inserted. A reorder parks the changed rows on temporary ordinals, so
the UNIQUE `(task_id, ordinal)` and `(task_id, source_key)` indexes never
collide mid-way. Kept criteria also keep their `created_at`. The live
`cleo.db` table `tasks_evidence_ac_bindings` declares no foreign key, so it
was not cascading there. The bare legacy schema that the child-projection
backfill writes does declare one, and node:sqlite enforces it.

The same backfill wrote the bare `task_acceptance_criteria` table with
REPLACE. It is now a guarded UPSERT. An id is `sha256(taskId, key)`, so a
conflicting id can only belong to another task's corrupt or hand-seeded row.
The UPSERT refuses to take that row over (`E_AC_ID_FOREIGN_OWNER`) instead of
re-parenting it and crediting the other task's evidence to this one. The
rebuild transaction rolls back and changes nothing.

The other REPLACE writers were converted too, so none of them relies on a
pragma to stay safe:

- the legacy tasks-lineage carry-forward (`INSERT … SELECT`) is an untargeted
  UPSERT. A snapshot row still wins over a seeded row that collides on the
  primary key or on any secondary UNIQUE constraint, but the colliding row is
  updated in place instead of deleted. The rebuild disables foreign keys, so
  this site was not cascading today. One snapshot row that collides with two
  different seeded rows now raises an error where REPLACE silently deleted
  both, and the rebuild rolls back;
- the `_agent_registry_meta` and `_conduit_meta` schema-version sentinels use
  UPSERTs on `key`. Neither table is an FK parent.

`brain_embeddings` keeps REPLACE with an opt-out. It is a `vec0` virtual
table: it cannot be an FK parent, and virtual tables reject UPSERT.

Gate 28 (`scripts/lint-no-raw-table-writes.mjs`) now rejects every
`INSERT OR REPLACE`, `REPLACE INTO`, `UPDATE OR REPLACE` and DDL
`ON CONFLICT REPLACE` in `packages/` and `crates/`, including
the sanctioned accessors, in every mode. A site can opt out with
`// replace-allowed: <reason>`. The gate refuses the opt-out when the target
is dynamic, or when it is the parent of an `ON DELETE CASCADE`, `SET NULL` or
`SET DEFAULT` foreign key declared in a migration or in source.
