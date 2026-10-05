---
id: t12779-remap-pending
tasks: [T12779]
kind: fix
summary: A uid remap the stream never learns now rewrites every pending reference to the old uid, so a sealed op never points at a row no replica has
---

Journal spec §3.3 G. A capture records a reference as `[local key, target uid]` with the uid read at write time. When a re-key nets into its row's own insert, the stream never learns the old uid, yet another row's capture in the same transaction still named it. The sealed op then carried a dangling reference (reproduced: a child's `parent_id` sealed as the pre-re-key uid).

- `remapPending(db, {table, oldUid, newUid, newBfp})` (`store/sync/remap.ts`) rewrites reference uids in every live capture and in every op of a sealed, unsegmented transaction, plus the remapped row's own uid and birth fingerprint. Segmented transactions are history and never change.
- The sealer applies dropped re-keys to the other ops of the transaction, to the captures still waiting in the batch, and through `remapPending` to the store.
- After a refill re-derives birth fingerprints, `refreshPendingBirthFps` points pending captures and unsegmented ops at each row's current `birth_fp`.
- A test pins why apply intents must use the stored value (F): an INTEGER column stores the text `'5'` as `5`, and only that enc matches the capture.

The apply engine (T12344) calls `remapPending` from its re-key paths.
