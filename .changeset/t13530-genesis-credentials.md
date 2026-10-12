---
id: t13530-genesis-credentials
tasks: [T13530]
kind: fix
summary: "A device joining the home stream gets usable credentials from the genesis checkpoint"
---

A global vault snapshot (a genesis checkpoint, or a `cloud push` of the global
store) used to carry every credential column cleared, so a device that
restored it and joined the home stream had the account rows without their
secrets. Only credentials written after the cut arrived usable.

The snapshot now carries each credential cell of `accounts`,
`service_connections` and `service_configs` sealed under the account's
secret-values key, the same envelope cloud sync's phase A uses. The bundle
still holds no plaintext and no machine-bound ciphertext. A restore opens each
sealed cell, re-encrypts it under the restoring machine's key, and fills only
the cells that machine does not already hold. A credential the pushing machine
cannot decrypt is left cleared with a `W_SYNC_SECRET_UNREADABLE` warning.

A merge join (a never-synced store joining without a restore, T13544) fills the
same sealed cells into its scratch copy of the checkpoint before it adopts any
row, and adopts an adopted row's secret columns with it. A row the joining
store already holds keeps its own secrets. A fill that fails aborts the join or
the owed reconcile, which the next attempt retries.
