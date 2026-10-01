---
id: t12336-cloud-vault
tasks: [T12336, T12337, T12338, T12950, T12951, T12952, T12966, T12967, T12968, T12969, T12970, T12971, T12972, T12973, T12974, T12975, T12976]
kind: feat
summary: cleo cloud push, pull, restore, verify, vault, lease release and activity back up and recover project and global stores as encrypted snapshots on Cleo Nexus (the key is escrowed on Cleo Nexus, released only to your approved devices), with lineage, a single-writer lease, verified restore that keeps this machine's own state and credentials, and a per-device integrity check; cleo login nexus also hands the device the encryption key and attaches its global store
---

**Cloud vault (Stage B).** A snapshot is a checkpoint on the store's journal
stream (`project:<id>`, or the account's `home:<userId>` for the global store,
the main brain). The bundle is the store's portable bundle without secrets,
sealed with the stream's data key. The server stores the ciphertext plus a
plaintext manifest of per-table row counts and keyed hashes. It checks that the
counts reconcile with the journal. The manifest covers the syncing tables of
`cleo.db`, one entry per other database in the bundle (blobs manifest,
attachments index) and one entry for the plain-file inventory, so a new or
edited document is a change: push uploads it, and pull refuses to overwrite it.
Cells that never sync (credentials, machine-local columns such as registry
paths) are hashed as NULL.

**Encryption and escrow, plainly.** Snapshots are encrypted, and the key is
escrowed on Cleo Nexus: the account master key is sent over TLS on first use
and stored encrypted under a server-held key (cleo-nexus T082), and released
only to your approved, active devices, sealed to each device's key. Cleo Nexus
can therefore recover the key; this is encryption at rest with server escrow,
not zero-knowledge end-to-end encryption.

- `cleo cloud push [--scope project|global] [--force] [--hold]` pushes a
  snapshot that descends from the head, under the stream's `writer` lease. It is
  refused with `E_NEXUS_VAULT_BEHIND` when another device pushed after this
  machine's last sync (checked before the lease is taken), and with
  `E_NEXUS_VAULT_LEASE_HELD` while another device holds the lease. `--force`
  takes the lease and pushes anyway; the server labels that as a fork. An
  up-to-date push takes no lease, and a push releases the lease when it ends
  (success or failure) unless `--hold`. When the counts changed, one signed
  delta segment carries the exact per-table difference, so the server's
  regression check passes; if another device appends a segment meanwhile, the
  push replays once and retries.
- `cleo cloud pull` brings the store to the head. `cleo cloud restore
  [--checkpoint <id>]` restores any snapshot. `cleo cloud restore --project <id>
  [--into <dir>]` puts a project onto a new machine and links it. Every table's
  count and hash is verified before anything is placed
  (`E_NEXUS_VAULT_VERIFY_FAILED` changes nothing). This machine's own state is
  carried into the snapshot before it is placed: `local-only` tables (the
  replica binding), local-only columns (registry paths), credential cells and
  `portable-secret` rows, matched by primary key. A credential with nowhere to
  go is reported with its re-entry remedy (`W_NEXUS_VAULT_CREDENTIALS_LOST`).
  Local changes since the last sync are never overwritten without `--force`,
  and a safety bundle is written first. A restore refuses with
  `E_NEXUS_VAULT_STORE_BUSY` while another CLEO process holds a writer lease
  on the store, and serialises with first-open migrations. Pull and restore
  are read-only on the server: on an account that never pushed they answer
  `E_NEXUS_VAULT_EMPTY` without minting a key.
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
bundle is verified and before placement; `exportPortableBundle` gains
`globalHomeExclusions` and `includeConfigHome`, which the vault uses so a global
snapshot never carries `device-id`, `state/` (the replica registries on macOS),
`keys/`, `web-server.json`, `sentient-state.json`, `device-heartbeat.stamp`,
`nexus.db` or the config home (`cleo backup export` is unchanged).
`nexus-vault.json` (machine-local vault state) is never exported; it is written
under a lock, atomically, and a file this version cannot read is moved aside
with a warning rather than reset. `cleo cloud vault`, `verify` and `lease
release` never write to the server or bind a replica.
