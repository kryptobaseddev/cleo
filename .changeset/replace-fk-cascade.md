---
id: replace-fk-cascade
tasks: [T12787]
kind: fix
summary: REPLACE on FK parent tables no longer cascade-deletes children; REPLACE is banned by gate 28
---

`INSERT OR REPLACE` resolves a uniqueness conflict by deleting the existing row
and inserting a new one. With foreign keys enforced, SQLite runs the ON DELETE
action of every foreign key that references the deleted row, so a same-key
REPLACE on a parent table deleted its `ON DELETE CASCADE` children (or nulled
its `SET NULL` ones), even though a row with the same key was back a moment
later.

The backfill that rebuilds child-task acceptance criteria wrote the bare
`task_acceptance_criteria` table with REPLACE. That table is the parent of
`evidence_ac_bindings.ac_id … ON DELETE CASCADE`, and the handle enforces
foreign keys, so an id conflict deleted the evidence bound to that criterion.
It is now an UPSERT on `id`.

The other REPLACE writers were converted too, so none of them relies on a
pragma to stay safe:

- the legacy tasks-lineage carry-forward (`INSERT … SELECT`) is an untargeted
  UPSERT. A snapshot row still wins over a seeded row that collides on the
  primary key or on any secondary UNIQUE constraint, but the colliding row is
  updated in place instead of deleted. The rebuild disables foreign keys, so
  this site was not cascading today;
- the `_agent_registry_meta` and `_conduit_meta` schema-version sentinels use
  UPSERTs on `key`. Neither table is an FK parent.

`brain_embeddings` keeps REPLACE with an opt-out. It is a `vec0` virtual
table: it cannot be an FK parent, and virtual tables reject UPSERT.

Gate 28 (`scripts/lint-no-raw-table-writes.mjs`) now rejects every
`INSERT OR REPLACE` and `REPLACE INTO` in `packages/` and `crates/`, including
the sanctioned accessors, in every mode. A site can opt out with
`// replace-allowed: <reason>`. The gate refuses the opt-out when the target
is dynamic, or when it is the parent of an `ON DELETE CASCADE`, `SET NULL` or
`SET DEFAULT` foreign key declared in a migration or in source.
