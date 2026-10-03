---
id: t13109-vault-restore-rebind
tasks: [T13109]
kind: fix
summary: A vault pull or restore now retires this store's replica as a vault restore and records it for S4; cloud status, projects show and restore name the retired replicas
---

After `cleo cloud pull` or `cleo cloud restore` places a snapshot, the store is a new file: either another
device's data, or this store rolled back. The journal spec (§1.5, rules 1 and 3, N6) therefore gives it a
new replica, and the retired replica stays on the server as history. That already happened, but silently:
the next link rebound the store as a copied file (`file-identity`), so the project's replica list grew by
one entry per pull with no explanation.

The vault now rebinds the placed store itself, recorded as `vault-restore`. Restore reports it
(`replica: { retired, current }`, "replica X retired → Y"). This device's replica registry keeps the retired
replica with its successor, the reason and its last `replicaSeq` per stream. These are the retire candidates
that S4's signed `retire` transaction will announce. A copy at another path still retires nothing.
`cleo cloud status` (`local.retiredReplicas`) and `cleo cloud projects show` (`retiredHere`) list the replicas
this device retired, so the server's longer list is explained. Retiring the replica on the server waits for
S4. A project restored onto a machine for the first time has no replica to retire and is unchanged.
