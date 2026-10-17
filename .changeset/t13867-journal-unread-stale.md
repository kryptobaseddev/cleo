---
id: t13867-journal-unread-stale
tasks: [T13867]
kind: fix
summary: a store that reads only snapshots is no longer reported up to date while the change journal has moved past the newest snapshot
---

A store that does not read the change journal (it restored a snapshot and
never ran `cleo sync enable push`) holds only the newest snapshot. When other
devices then wrote through the journal, `cleo cloud pull` still said
`up-to-date` and `cleo cloud verify` said `match`, while every journal change
was missing. Now that pull refuses with `E_NEXUS_VAULT_BEHIND`, verify says
`behind`, and a restore warns (`W_NEXUS_VAULT_JOURNAL_UNREAD`), each naming
how many journal segments are missing and the way forward: `cleo sync enable
push`, or a vault push from a device that writes the journal.

On a journal stream, `cleo cloud verify` no longer reports `ahead` only
because a table that snapshots alone carry (the file inventory, other
databases, the device and project registries) differs on this machine. Those
tables are still listed, with a `W_NEXUS_VAULT_SNAPSHOT_ONLY` warning.

Every request now sends `x-cleo-stream-reader: 3`, so a Cleo Nexus server can
refuse a journal stream to a client that reads only snapshots. Released
v2026.10.19 does not send it.
