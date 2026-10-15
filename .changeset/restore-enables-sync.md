---
id: restore-enables-sync
tasks: [T13718]
kind: fix
summary: "cleo cloud restore now turns sync on for the restored project and the home stream, so a device that joins by restore syncs with no enable step"
---

A device that joined through `cleo cloud restore` (for example after
`cleo login nexus` outside a project) left every sync flag off, so
`cleo cloud sync` failed with `E_SYNC_DISABLED` until `cleo sync enable push`
was run by hand.

A successful restore now runs the same enable for the restored store and for
the account's home stream. It is inert while sync is unreleased, skipped under
a test runner or CI, and off with `CLEO_DISABLE_AUTO_SYNC=1` or
`cloud.autoSync: false`. A failure to enable warns `W_NEXUS_FIRST_RUN_SYNC`
with the command to run; the restore still succeeds.
