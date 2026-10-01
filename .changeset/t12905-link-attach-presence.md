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

A 409 means the replica is already attached from another Nexus device.
- When the server says the holder is this user's own revoked device, the store
  rebinds itself (`device-reenrolled`) and attaches the new id.
- Otherwise the warning names both possible causes, a re-enrolled machine or a
  copied store, and the one fix for either: `cleo project link --rebind`, which
  gives this copy a new replica id and attaches it.

An attach or presence failure never fails the link. The project is registered,
`nexus-link.json` is written, and a warning names the remedy. The file is
updated entry by entry: an origin written by a newer CLEO is carried through
untouched, a relink that attached nothing keeps the cached `replicaId`,
`nexusDeviceId` and `attachedAt`, and a newer-format file is refused rather
than overwritten. The result envelope gains `replica` and `warnings`, and the
summary says when the store was rebound.
