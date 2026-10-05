---
id: t12344-merge-engine
tasks: [T12344, T13222, T13223]
kind: feat
summary: The change journal's pure merge engine, with per-field LWW by HLC, typed rules for task status, pipeline stage and verification, tombstones, counters, explicit schema-skew refusal and ledger contracts
---

This is the first slice of the apply side (T12344, PR-1 of 6), against journal spec §1.7, §2.6, §2.9, §3.2 and §3.6. It is pure code
with no database. Nothing calls it yet; the apply frame and the applier loop come in the next slices.

- **Contracts.** `@cleocode/contracts/ledger` adds `LedgerTxn`, `LedgerOp`, `LedgerValue` (with `{ $inc }` counter deltas) and
  `LEDGER_TXN_VERSION` as zod schemas.
- **`applyOp(row, op, ctx)`** decides one I, U or D op against a row's stream-derived state:
  - per-field LWW by HLC (`fh[col] ?? h`);
  - **merge groups travel whole** (T13222). The capture trigger records every member of a group when any of them changes. Netting and
    apply-intent subtraction keep a group whole. An insert's omitted members are NULL. A U op carrying only part of a group is refused
    as `malformed`. So the status group (status, completed_at, cancelled_at, cancellation_reason) resolves as one unit, and a cancelled
    task never keeps a completion stamp;
  - counters by `{ $inc }` delta sum, or by max/min over absolute numbers. Mixed shapes are refused as `malformed`, since they would
    make the result depend on order. A counter set from NULL nets to a delta from 0;
  - tombstones never resurrect. An older op is skipped; a newer update of a deleted row is voided with an `edit-vs-delete` conflict;
    a newer insert re-creates the row. A re-insert racing a delete is therefore order-sensitive: deterministic per stream, not
    order-free;
  - a delete over newer edits records `delete-vs-edit`;
  - every concurrent divergent edit is recorded as a `field` conflict, applied or not. A divergent edit is one whose before-image
    differs from the current value;
  - an op naming a column this schema lacks is `refused-schema`, never partly applied;
  - leave, restore and unfreeze are granted per transaction, so a command's cascade is covered.
- **`checkSchemaVersion`** refuses a newer segment `schemaVersion` or transaction format with `E_SCHEMA_AHEAD`.
- **`SYNC_MERGE_RULES`** implements three typed rules:
  - `task.status.absorbing`: done, cancelled and archived are left only by an explicit restore or reopen, and dominate an ordinary
    concurrent edit;
  - `task.pipeline-stage.max` (T13223): pipeline_stage is the maximum over (rank by STAGE_ORDER, then HLC). NULL and unranked values
    rank lowest, and the winner keeps its own HLC. A restore raises a floor that kills older writes. The state keeps the alive
    candidates, so the result is the same in every order, HLCs included. A rule override is recorded as a typed-rule conflict;
  - `task.verification.frozen-on-done`: verification is frozen while done.
- **Convergence property tests** fold every interleaving of the writes of 2 and 3 concurrent replicas, from a seeded generator:
  - plain LWW, groups and counters converge in every order, row state and HLCs included;
  - a delete wins in every order when no re-insert races it;
  - typed-rule invariants hold at every step;
  - no divergent edit is silent;
  - without explicit leave ops, the status group and pipeline_stage converge in every order, HLCs included. The ops are shaped as the
    sealer emits them, with NULL and unranked stages;
  - pipeline_stage converges in every order with explicit restores too.
