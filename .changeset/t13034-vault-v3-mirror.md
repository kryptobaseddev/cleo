---
id: t13034-vault-v3-mirror
tasks: [T13034]
kind: feat
summary: "Cloud vault reads segment/v3 and checkpoint/v3, refuses to push onto a v3 stream, and stamps a shared SYNC_SCHEMA_VERSION"
---

cleo-nexus #30 added segment/v3 (per-transaction `txnDeltas`) and
checkpoint/v3 (`pending`, `voided`, `revived`, `pruned`, `replayPin`), each
signed under its own domain, and a per-stream ratchet: once a stream has a v3
checkpoint, a v2 one gets 409 `E_STREAM_VERSION` (reason `stream-v3`). The
cleocode copy of the contract was plain `z.object`, so it stripped the v3
fields, and the client then verified v3 records under the v2 canonical form
and domain. Every signature check failed, so `cleo cloud pull`, `restore` and
`verify` would break as soon as the change journal wrote a v3 checkpoint.

- `@cleocode/contracts/cloud` mirrors the server's v3 schemas (`TxnDelta`,
  `TxnRef`, `RefDeltas`, `ReplayPin`, `MANIFEST_V3_FIELDS`, the txnDeltas sum
  check, the new error codes `E_MANIFEST_ACCOUNTING` and `E_STREAM_VERSION`).
  The server's contract-parity check now matches every pending T089 entry.
- Core signing produces the v3 canonical forms and picks the domain from the
  record: `segment/v3` when the metadata carries `txnDeltas`, `checkpoint/v3`
  for a manifest with a replay pin (`manifestVersion`). The golden vectors are
  the server's. The manifest rules (`checkManifestV3`, the T090 schema floor)
  are ported, and the server's own cases run against them.
- `cleo cloud pull`, `restore` and `verify` verify v3 checkpoints and replay
  v3 segments. A push folds segment/v3 windows into its v2 snapshot.
- A push onto a stream whose head is checkpoint/v3, or that holds a newer
  sync schema, is refused with `E_NEXUS_VAULT_STREAM_UPGRADED` before
  anything is written: no lease, no upload, no delta segment left orphaned in
  the journal. The server's `E_STREAM_VERSION` maps to the same code. The
  vault does not write v3 itself. A v3 checkpoint's replay pin is recomputed
  by endorsers through replay, and its bundle carries the unresolved journal
  entries. A store snapshot has neither, so writing v3 is left to vault and
  journal coexistence (T12999).
- `SYNC_SCHEMA_VERSION` (2), in `@cleocode/contracts`, is one numbering for
  the change journal and the vault. The vault stamps it on its delta segments
  and manifests in place of its manifest computation version, which is now
  `VAULT_MANIFEST_FORMAT_VERSION` and never goes on the wire. The value stays
  2, so nothing already stored changes.
