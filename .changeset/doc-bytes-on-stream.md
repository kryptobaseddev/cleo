---
id: doc-bytes-on-stream
tasks: [T13721]
kind: feat
summary: synced docs now carry their bytes; a doc added on one device fetches with identical content on another, with no vault restore
---

`docs_attachments` rows already synced (T12919), but their bodies in
`.cleo/blobs/blobs/<sha256>` never left the device, so `docs fetch` on the
second device returned no-content.

- After a project push, each doc body this store has not yet put on the stream
  is encrypted under the stream data key (bound to the stream and the body's
  sha256), uploaded as an `attachment` blob, and recorded under an opaque ref,
  an HMAC of the sha256 under a key derived from the stream key (Nexus E32).
  A body some member already recorded is not uploaded again. Each leg makes at
  most 100 attempts per run and resumes from a cursor, so rows that cannot move
  (no device has their bytes yet, refused) never starve the ones behind them.
- After a project pull, each synced doc row whose body is missing here is
  downloaded (Nexus E33), checked against the announced size and sha256,
  decrypted, and checked against the row's sha256 before it is written
  atomically. A body that fails any check is refused with a
  `W_SYNC_DOC_BYTES_REFUSED` warning, and nothing is written for it.
- A ref recorded with a blob that fails these checks (a squatting writer, a buggy
  client; the server keeps the first record) heals: a device holding the bytes
  checks the recorded blob on its next push, clears it (Nexus E34) and records
  its own. When it may not clear it, or a racer recorded first, the body stays
  unmarked and `W_SYNC_DOC_BYTES_CONTESTED` says so; the next push checks again.
  A pull that refuses a body clears its record when it may, and each push
  re-checks a few bodies it already marked sent, so a record cleared later is
  recorded again. A failure here never fails a sync whose segments applied: it
  becomes a warning.
- A Nexus without the stream-attachment routes answers 404: rows still sync,
  `docs fetch` reports no-content, and `W_SYNC_DOC_BYTES_UNAVAILABLE` says why.
