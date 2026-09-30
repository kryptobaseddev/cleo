---
id: nexus-device-store
tasks: [T12867]
kind: feat
summary: a typed, sealed, owner-only store for Nexus device credentials (nexus-device.json), dormant until the device login lands, and never exported in backup bundles
---

Adds `NexusDeviceStore` in `@cleocode/core/cloud/nexus-device.js`, the client
side of the cleo-nexus device contract §2.2, §2.5 and §3.5. It holds, per API
origin and user id, the Nexus device id, the device key pairs, the current
`cnx_d1_` credential, the `pending`, `pendingSignOut` and `pendingRevoke`
slots, and the unsettled requests of any device an entry replaced.

- **Path.** `<CLEO_HOME>/nexus-device.json`, resolved through the new
  `resolveNexusDevicePath()` in `@cleocode/paths`. `resolveNexusCredentialsPath()`
  is added beside it, and `nexusCredentialsPath()` now uses it (same path).
- **Sealed at rest.** Tokens and private keys are encrypted under the machine
  key (id `nexus-device:<origin>:<userId>`), so a copied file opens nowhere
  else. `cleo backup export` never includes the file, even encrypted.
- **Permissions.** Created 0600. Reads check the open descriptor (regular
  file, one link, owner, mode). A group- or world-writable or foreign-owned
  directory is refused. Each refusal names the fix.
- **Locking.** The store has its own lock: it waits about a minute, gives a
  typed `E_NEXUS_DEVICE_BUSY`, refuses re-entry, and turns a lost lock into
  an aborted `tx.signal` and `E_NEXUS_DEVICE_LOCK_COMPROMISED` instead of an
  uncaught throw. Every change re-reads the file after the lock is taken.
- **Durable writes.** `tx.flush()` writes mid-transaction with the lock held,
  so a rotation's `pending` credential is on disk before E8 is sent. Writes go
  to a temp file that is fsynced and renamed; the directory is fsynced. No
  backups are made, and leftover temp files are swept.
- **No downgrade.** A newer format version, a malformed file or an entry that
  does not open under this machine's key is refused and left untouched.
  Unknown fields are kept at every depth.
- **Slots never drop a credential.** Sign-out and revoke put live credentials
  first and refuse rather than truncate. A login refuses to re-enrol a device
  whose revoke is unconfirmed. Promoting `pending` is a compare-and-swap.
- **Redaction.** Handles, transaction entries and enrolments print only a
  redacted view. `redactNexusDeviceSecrets` masks credentials and private-key
  fields in any diagnostic text.

Nothing calls the store yet. Login, rotation, logout and reads use it in
T12868–T12871, behind `CLEO_NEXUS_DEVICE=1`. `nexus-credentials.json` is
unchanged and stays format version 1.
