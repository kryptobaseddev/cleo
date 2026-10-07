---
id: cloud-verify-deep
tasks: [T13291]
kind: feat
summary: cleo cloud verify --deep downloads the snapshots again and re-hashes their bytes and the journal tail
---

`cleo cloud verify` compared manifests: per-table counts and keyed hashes
against the signed head checkpoint. It never fetched the stored bytes, so a
bundle that went bad in storage passed until someone tried to restore it.

`--deep` (opt-in, because it downloads every bundle) downloads the head snapshot
and each device's newest snapshot again, checking size, sha256 and decryption
against the signed checkpoint. It then re-hashes, signature-checks and decrypts
every journal segment after the head. That tail is what a pull would still
replay; the segments a snapshot covers are what its bundle captured.

- If the head's bundle or a tail segment fails, the verdict is `untrusted` and
  the remedy says not to pull.
- If another device's older snapshot fails, a `W_NEXUS_VAULT_BLOB_INTEGRITY`
  warning is added and the verdict stands.
- A network or HTTP failure fails the command. It is never reported as a
  finding about the cloud copy.

The result carries a `deep` object with each snapshot checked and the segments
checked. The human line points to `cleo backup verify` for local backups.
