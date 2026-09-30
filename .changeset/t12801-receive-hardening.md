---
id: t12801-receive-hardening
tasks: [T12801]
kind: fix
summary: The row-uid refill re-derives fingerprints that hashed a stale one, and received rows are validated, cheap to release and re-keyed only against the named winner (row uids, opt-in)
---

- **Refill.** A store whose fingerprints a pre-release build derived now
  also re-derives every fingerprint that hashed a cleared one: an AC's hashes
  its task's, and a history row's or binding's hashes its criterion's. Before,
  an AC whose uid and fingerprint an edit had carried onto a new row could
  not be recognised and kept a stale value. Measured on a copy of live
  cleocode: 3 stale rows before, 0 after.
- **Releasing held rows.** Placing a row now re-tries only the held rows it
  may unblock: rows waiting on its uid, or on an old uid a re-key led to it,
  or on a key it freed. A row still held for the same reason is not
  rewritten. Before, every receive re-tried and rewrote every held row.
- **Validated inserts.** A received task is checked against the same schema
  as a local task write, and arrives without the sender's claim lease. A row
  that fails that check, or that the store's guards refuse (containment
  cycle, parent type matrix, status/pipeline invariant), is held as
  `invalid` instead of inserted. The merge is not aborted.
- **Re-key.** `rekeyRowUid` takes the winner's fingerprint as well as the
  loser's. It refuses a pair where the winner is not the smaller of the two,
  or where a row held here has neither fingerprint.
