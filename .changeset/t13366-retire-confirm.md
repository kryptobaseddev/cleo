---
id: t13366-retire-confirm
tasks: [T13366]
kind: fix
summary: "Sync: a replica retire counts only once the server confirms it"
---

A receiver used to honour any validly signed `retire` transaction whose emitter named itself successor. Any device on
the account could then retire any replica: its later changes applied with no conflict records and it left the fold
horizon. Now a recorded retire changes nothing until the server confirms it (T13366):

- **Emitter:** the E31 answer (`ReplicaRetirement`) confirms the store's own retire.
- **Home stream:** each pull reads `retiredAt` and `successor` from `GET /v1/account/home/replicas` and confirms the retires
  they match. The successor must be the same.
- **Project streams:** the server has no read of retirements yet, so receivers keep every retire unconfirmed. Late
  segments apply with their conflicts recorded and the fold horizon still counts the replica.

New sync-journal migration `t13366-retire-confirm` (local-only): `_sync_retired.confirmed_at`. Journal spec v11.5 records
the rule and the server's `not-pinned-or-owner` check that bounds it.
