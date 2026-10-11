---
id: t13324-carry-bare-accounts
tasks: [T13324]
kind: fix
summary: a vault restore keeps the reconcile record that matches the restored bare tables, so a pulled reconciled store enables sync
---

The store's record of the bare legacy tables a reconcile carried (`_exodus_recovery_bare_accounts`, T13320) is local-only, so a vault pull replaced it with this machine's (usually none) while the twins arrived from the reconciled device: the pulled store was refused as a strand. A restore now settles it after the bare tables (local-only) are this machine's: per bare table it keeps the snapshot's record, else this machine's, whichever still matches the bare table by row count and key digest, and drops a record neither matches. Bundles already carry the table whole; it never syncs.
