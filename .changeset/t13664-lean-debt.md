---
id: t13664-lean-debt
tasks: [T13664]
kind: feat
summary: "`cleo lean debt`: ledger of every `shortcut:` comment, with --file-tasks into lean-debt tasks"
---

ct-lean asks for a `shortcut: <the limit>, <when to upgrade>` comment on every
shortcut with a known limit. The convention and the older `ponytail:` marker
come from Ponytail 5.1.0, MIT.

`cleo lean debt` scans git-tracked files (vendored and build output skipped)
and prints a LAFS ledger. Each row gives the file, the line, the limit, the
upgrade trigger and a `noTrigger` flag for markers that name no trigger, and
carries a stable key built from the file and marker text, so moving lines does
not change it. `--marker <word>` scans another word instead.

`--file-tasks --parent <epic>` files one `lean-debt` task per marker that has
none yet. Re-running it is idempotent (a done, cancelled or archived debt task
still counts as filed), so the ledger lives in the task store instead of a file
that rots. Filing checks for a session first, so an unbound caller files
nothing.
