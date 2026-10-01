---
id: t12336-cloud-vault
tasks: [T12336, T12337, T12338, T12950, T12951, T12952]
kind: feat
summary: cleo cloud push, pull, restore, verify, vault, lease release and activity back up and recover project and global stores as end-to-end encrypted snapshots on Cleo Nexus, with lineage, a single-writer lease, verified restore and a per-device integrity check; cleo login nexus also hands the device the encryption key and attaches its global store
---

**Cloud vault (Stage B).** A snapshot is a checkpoint on the store's journal
stream (`project:<id>`, or the account's `home:<userId>` for the global store,
the main brain). The bundle is the store's portable bundle without secrets,
sealed with the stream's data key. The server sees ciphertext plus a manifest of
per-table row counts and keyed hashes of the syncing tables. It checks that the
counts reconcile with the journal; only key holders can check the hashes.

- `cleo cloud push [--scope project|global] [--force]` takes the stream's
  `writer` lease and pushes a snapshot that descends from the head. It is
  refused with `E_NEXUS_VAULT_LEASE_HELD` while another device holds the lease,
  and with `E_NEXUS_VAULT_BEHIND` when another device pushed after this
  machine's last sync. `--force` takes the lease and pushes anyway; the server
  labels that as a fork. When the counts changed, one signed delta segment
  carries the exact per-table difference, so the server's regression check
  passes.
- `cleo cloud pull` brings the store to the head. `cleo cloud restore
  [--checkpoint <id>]` restores any snapshot. `cleo cloud restore --project <id>
  [--into <dir>]` puts a project onto a new machine and links it. Every table's
  count and hash is verified before anything is placed
  (`E_NEXUS_VAULT_VERIFY_FAILED` changes nothing). This machine's `local-only`
  rows, such as the replica binding and registry paths, are carried into the
  snapshot. Local changes since the last sync are never overwritten without
  `--force`, and a safety bundle is written first.
- `cleo cloud verify` (read-only) checks SQLite integrity and compares the
  store with the cloud head table by table, and each device's newest snapshot
  with the head. The verdict is `match`, `ahead`, `behind`, `diverged` or
  `empty`, with a remedy; a forced lease is warned as a fork.
- `cleo cloud vault` shows the snapshot lineage, the last push per device,
  the tables changed since the last sync, and who holds the lease until when.
  `cleo cloud lease release` hands the lease back.
- `cleo cloud activity [--project <id>] [--device <id>] [--limit] [--before]`
  shows what the account's devices did and when, following pages.

**Keys (owner decision 2026-10-01).** Adding a device needs only `cleo login
nexus` and the one-time browser approval. The account master key is escrowed on
Cleo Nexus and released only to an approved, active device, sealed to that
device's X25519 key. The first push mints and escrows the key. Every device
certifies itself under it, so other devices verify its snapshots. Project data
keys are wrapped by the master key; the home key is derived from it.

**Global store attach (T12952).** `cleo login nexus` binds the global store's
global-scope replica and attaches it to the account's home stream, with
presence. `cleo cloud status` reports it under `global`. A server without the
home-replica endpoints yields a warning, never a failure.

`importPortableBundle` gains an `onStaged` hook that runs after the staged
bundle is verified and before placement. `nexus-vault.json` (machine-local vault
state) is never exported.
