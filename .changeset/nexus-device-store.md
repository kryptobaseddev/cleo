---
id: nexus-device-store
tasks: [T12867]
kind: feat
summary: a typed, owner-only store for Nexus device credentials (nexus-device.json), dormant until the device login lands
---

Adds `NexusDeviceStore` in `@cleocode/core/cloud/nexus-device.js`, the client
side of the cleo-nexus device contract §2.2, §2.5 and §3.5. It holds, per API
origin and user id, the Nexus device id, the device key pairs, the current
`cnx_d1_` credential, and the `pending`, `pendingSignOut` and `pendingRevoke`
slots.

- **Path.** `<CLEO_HOME>/nexus-device.json`, resolved through the new
  `resolveNexusDevicePath()` in `@cleocode/paths`. `resolveNexusCredentialsPath()`
  is added beside it, and `nexusCredentialsPath()` now uses it (same path).
- **Permissions.** Created 0600 in a 0700 directory. A file with a wider mode
  or another owner is refused, with a `chmod 600` fix in the error. Symlinks
  are refused.
- **Locking.** Every change runs under the file lock and re-reads the file
  after acquiring it (M6, N1). Writes go to a temp file that is fsynced and
  renamed, then the directory is fsynced. No backup copies are made, and any
  found are purged.
- **No downgrade.** A newer format version or a malformed file is refused and
  left untouched, never read as empty. Unknown fields are kept on rewrite.
- **Redaction.** Reads return a sealed handle whose JSON, string and inspect
  forms mask tokens and omit private keys. `redactNexusDeviceSecrets` masks
  credentials in any diagnostic text.

Nothing calls the store yet. Login, rotation, logout and reads use it in
T12868–T12871, behind `CLEO_NEXUS_DEVICE=1`. `nexus-credentials.json` is
unchanged and stays format version 1.
