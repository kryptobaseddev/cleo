---
id: t13231-identity-full-refill
tasks: [T13231, T12749]
kind: fix
summary: a provably unshared store with a stale identity recipe re-derives ALL of its row identity from scratch; anything that may have left the store is kept
---

The targeted refill kept existing uids on the premise that the uid recipe did not change. On
cleocode that premise was false. A device filling the same data from nothing derived different
uids for 201 symmetric `related` task relations and one acceptance criterion, so those rows would
diverge on the first sync (spec `t12341-uid-scheme` v13 §15.0).

**Unshared stores re-derive everything.** When the recipe marker is stale and the store is
provably unshared, the open:
1. takes a `VACUUM INTO` snapshot (`.cleo/backups/sqlite/cleo-identity-refill-<ts>.db`, recorded
   under the `row_identity_refill_snapshot` meta key);
2. clears every identity column of every declared table (the alias tables are never touched);
3. refills from scratch.

**"Unshared" is strict.** Any of these makes the store shared:
- the shared marker is set;
- a sync stream has started (`sync.seal`, `sync.push` or `sync.pull` on, or rows in a sealed-op,
  ledger, apply-intent or quarantine table);
- identity aliases exist;
- the store was rebound (copied, moved or restored);
- a vault push or restore of this store root is recorded in `nexus-vault.json`.

Any of these makes it unknown:
- a Nexus-linked project with no local vault record;
- an unreadable link or vault-state file.

**Shared or unknown means refuse.** The open keeps every value, refuses the refill and logs
the reasons with a remedy. A store whose fill never ran just gets its marker.

**Under sync capture,** the snapshot is taken before the capture bracket, because a `VACUUM INTO`
cannot run inside a transaction.

Gate B, with the from-scratch check, now passes on a sandbox copy of cleocode's backup. The live
cleocode store is Nexus-linked, so it stays refused until it is proven unshared.
