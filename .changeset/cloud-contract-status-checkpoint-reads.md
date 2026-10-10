---
id: cloud-contract-status-checkpoint-reads
tasks: [T13282, T13283]
kind: feat
summary: Contracts mirror cleo-nexus DeviceScope, StatusQuery and GetCheckpointResult (contract v2.27)
---

`@cleocode/contracts/cloud` gains three schemas that cleo-nexus shipped to
production:

- `DeviceScope`: the eight credential scopes from §2.3.
- `StatusQuery`: the E3 `GET /v1/status` query (cleo-nexus #38). Both fields
  are optional, and a `replicaId`, which must be a UUIDv7, requires a
  `projectId`.
- `GetCheckpointResult` `{ checkpoint }`: the answer of E29
  `GET …/checkpoints/head` and E30 `GET …/checkpoints/:checkpointId`
  (cleo-nexus #39). The checkpoint has the same shape as a list item.

These are types only; the client calls come with S4/S5. A test also keeps
core's `NEXUS_DEVICE_SCOPES` equal to the shared `DeviceScope`.
