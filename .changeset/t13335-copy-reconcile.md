---
id: t13335-copy-reconcile
tasks: [T13335, T12763, T12753]
kind: feat
summary: "Sync: a rebound store reconciles against the restored checkpoint pulled to head before it pushes"
---

A store the open pass rebinds (a copy, a move, a rollback, another device's store) now reconciles against the stream
before it sends anything (journal spec §1.5 N7, T13335):

- **The rebind** records `sync.reconcile_due`, discards the inherited pull cursor, and pauses push (`reconcile-pending`).
- **`cleo cloud sync`** restores the stream's latest verified journal checkpoint into a scratch store (`sync: 'off'`),
  pulls the stream to head there with the merge engine, then reconciles the store against that merged state in one
  apply frame, field by field:
  - **rule 1:** a field an inherited change touched is re-emitted at the time of that change;
  - **rule 2:** a field whose local HLC is below the merged one takes the merged value, with nothing emitted;
  - **rule 3:** a field whose local HLC is at or above the merged one (the stream never saw it) is emitted with that
    HLC unchanged. The capture carries `pin_json` (new column, migration `20261009150000_t13335-capture-pin`), and the
    sealer publishes it as the op's `fh` (or `h` for a delete).
- Rows are adopted (inserted or deleted) or pinned in the same way. A local row the stream cannot account for is
  emitted, never deleted.
- The store then takes the merged pull position, and push resumes.
