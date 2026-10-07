---
id: cloud-contract-replica-retirement
tasks: [T13284]
kind: feat
summary: Contracts mirror cleo-nexus replica retirement (E31, contract v2.28) and its signed message
---

cleo-nexus #41 (T123, 39d1895) shipped replica retirement to staging and
production. This mirrors it.

**`@cleocode/contracts/cloud`** gains:

- `RetireReplicaRequest` and `RetireReplicaResult`, the request and answer of
  E31 `POST /v1/streams/:streamId/replicas/:replicaId/retirements`.
- `ReplicaRetirement`, the stored record.
- `retiredAt` and `successor` on `HomeReplica`, so also on
  `AttachHomeReplicaResult` and `ListHomeReplicasResult`.

The definitions match the server's.

**Elsewhere:**

- Core gains `replicaRetireMessage`, the signed form
  `cleo-nexus/replica-retire/v1`. A null successor, `lastReplicaSeq` or txn id
  is signed as `-`. It is pinned to the server's three golden vectors.
- The seven E31 refusal reasons are `NEXUS_REPLICA_RETIREMENT_REASONS` in
  `@cleocode/contracts/nexus-vault`. They live outside the cloud mirror so that
  mirror stays exactly the server's.

These are types and the signed message only; the retire/rebind wiring comes
with S4.
