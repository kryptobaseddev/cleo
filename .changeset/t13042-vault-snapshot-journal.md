---
id: t13042-vault-snapshot-journal
tasks: [T13042]
kind: fix
summary: Vault snapshots no longer carry the local change journal, and snapshot redaction never re-journals what it clears
---

A store with sync capture on keeps its capture triggers in every snapshot copy. When the cloud vault (and
`cleo backup export`) cleared columns in that copy, each clearing UPDATE fired the snapshot's own capture
triggers: strip columns are captured whole, so the cleared values were written straight back into the
snapshot's `_sync_capture` and `_sync_undo`, undoing the clearing inside the bundle. Snapshot clearing
now runs in one transaction with the snapshot's capture and side-effect triggers suspended.

The vault also empties this device's local-only change journal (`_sync_capture`, `_sync_undo`,
`_sync_frame`) in every snapshot, so their images never leave the machine. These tables never sync, the
manifest never hashes them, and a restore takes them from the live store, so the change has no effect
on restores or on comparisons. `cleo backup export` changes only by the trigger suspension.
