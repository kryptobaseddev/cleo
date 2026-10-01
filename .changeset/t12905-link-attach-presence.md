---
id: t12905-link-attach-presence
tasks: [T12905]
kind: feat
summary: with a device credential, cleo project link now attaches this machine's copy of the project and reports its presence, so cleocode.dev shows the device holding the project
---

**Before**, `cleo project link` registered the project and stopped there. The
server showed the project with 0 devices and no replicas, so nothing linked
this machine to the project.

**Now**, with a device credential (the default), link also runs steps 3 to 5
of contract §3.6:

1. `ensureProjectReplica` binds the project store to a replica id once. It
   applies only the three local-only sync bookkeeping tables, adds no trigger
   and enables no `sync.*` flag, so capture, push and pull stay off.
2. `POST /v1/projects/:id/replicas` attaches that replica to this Nexus
   device.
3. `PUT …/replicas/:replicaId/presence` sends path-free presence (git dirty,
   ahead/behind, remote state, CLI version), never a path or hostname.

A 409 means the replica is already attached from another device. When the
holder is this user's own revoked device (after a re-enrolment), the store
rebinds to a new id (`device-reenrolled`) and attaches that. Any other holder
is a copied store and fails with `E_NEXUS_REPLICA_COPIED`; there is no
automatic rebind. A failed presence report is a warning. `nexus-link.json`
caches `replicaId`, `nexusDeviceId` and `attachedAt`, and the result envelope
gains `replica` and `warnings`.
