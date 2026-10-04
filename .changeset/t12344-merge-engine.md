---
id: t12344-merge-engine
tasks: [T12344]
kind: feat
summary: The change journal's pure merge engine, with per-field LWW by HLC, typed rules for task status, pipeline stage and verification, tombstones, counters, explicit schema-skew refusal and ledger contracts
---

This is the first slice of the apply side (T12344, PR-1 of 6), against journal spec §1.7, §2.6, §2.9, §3.2 and §3.6. It is pure code
with no database. Nothing calls it yet; the apply frame and the applier loop come in the next slices.

- **Contracts.** `@cleocode/contracts/ledger` adds `LedgerTxn`, `LedgerOp`, `LedgerValue` (with `{ $inc }` counter deltas) and
  `LEDGER_TXN_VERSION` as zod schemas.
- **`applyOp(row, op, ctx)`** decides one I, U or D op against a row's stream-derived state:
  - per-field LWW by HLC (`fh[col] ?? h`), with groups merged as one unit and counters by delta sum or max/min;
  - tombstones never resurrect. An older op is skipped; a newer update of a deleted row is voided with an `edit-vs-delete` conflict;
    a newer insert re-creates the row;
  - a delete over newer edits records `delete-vs-edit`;
  - every concurrent divergent edit is recorded as a `field` conflict, applied or not. A divergent edit is one whose before-image
    differs from the current value;
  - an op naming a column this schema lacks is `refused-schema`, never partly applied.
- **`checkSchemaVersion`** refuses a newer segment `schemaVersion` or transaction format with `E_SCHEMA_AHEAD`.
- **`SYNC_MERGE_RULES`** implements three typed rules:
  - `task.status.absorbing`: done, cancelled and archived are left only by an explicit restore or reopen, and dominate an ordinary
    concurrent edit;
  - `task.pipeline-stage.max`: pipeline_stage only moves up by STAGE_ORDER, except on restore;
  - `task.verification.frozen-on-done`: verification is frozen while done.
- **Convergence property tests** fold every interleaving of the writes of 2 and 3 concurrent replicas, from a seeded generator:
  - plain LWW and counters converge in every order;
  - a delete wins in every order;
  - typed-rule invariants hold at every step;
  - no divergent edit is silent;
  - without explicit ops, status and pipeline_stage converge in every order.
