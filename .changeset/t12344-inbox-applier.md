---
id: t12344-inbox-applier
tasks: [T12344, T12937, T12938, T12939]
kind: feat
summary: The change journal's receive inbox and applier loop, which apply staged remote transactions through the merge engine and record every conflict
---

This is the third slice of the apply side (T12344, PR-3 of 6), against journal spec §3.1, §3.2, §2.9 and §1.3.

- **Migration `t12344-inbox`** creates three local-only tables:
  - `_sync_inbox`: every received transaction, with the §3.1 statuses plus a `schema_version` column;
  - `_sync_conflict`: the conflict log;
  - `_sync_field_leave`: typed-rule field state that row meta has no place for. That is the latest explicit leave (a reopen, or a
    rank-max restore floor) and a rank-max column's alive candidate writes (its frontier, T13223).
- **`stageTxns` and `stagedTxns`.** Staging is idempotent per `(stream, seq, txn_idx)`. A split transaction is returned only once every part is staged, as one transaction.
- **`applyStagedTxns`** seals local captures first. It then decides and applies each transaction in one apply frame, together with its status, row meta, leaves and conflict records.
  - **Refused-schema:** a newer segment schema, a newer transaction format, or an unknown table or column.
  - **Held-skew:** an HLC beyond the skew bound holds that replica's later transactions FIFO; other replicas keep applying.
  - **Pending:** an update of a row not seen yet makes its whole transaction pending, with nothing written. Later transactions that write the same rows wait behind it. A pending transaction applies in the same call once the row it needs arrives.
  - **Not applied in this slice:** re-keys, non-NULL references and secrets stay pending until the reference and re-key slice lands.
- **Row meta follows the merge engine exactly** (new write-API call `setMergedRowMeta`):
  - an absorbing override keeps its own HLC;
  - a tombstone is the delete's HLC, even when a field held a newer edit.
- **Explicit leaves and frontiers:** the applier records the leaves and frontiers the merge decides. The sealer records a local
  leave: a U whose `actor.op` is a leave op moving status off an absorbing value, or a restore op writing pipeline_stage.
- **Malformed ops** (a partial merge group, or a wrong counter shape) are `refused-schema`, with the columns named in the reason.
- **Deletes run with foreign keys ON.** A child D whose row the parent's cascade already removed applies as a tombstone. SET NULL is
  left to this replica's own FK actions until T13226.
- **Write-invariant registry:** `task.status.absorbing`, `task.pipeline-stage.max` and `task.verification.frozen-on-done` are no longer pending. Their runtime gate is the merge engine's `applyOp`, which the applier calls.
