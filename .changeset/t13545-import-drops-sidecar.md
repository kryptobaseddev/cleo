---
id: t13545-import-drops-sidecar
tasks: [T13545]
kind: fix
summary: "Any bundle import drops the vault's sealed-credential sidecar from the placed store"
---

The vault restore drops the `_vault_sealed_credentials` sidecar from its staged
copy itself (T13530). Every other import of a global vault bundle now drops it
from the placed `cleo.db` too, so the unclassified table never stays in a live
store.
