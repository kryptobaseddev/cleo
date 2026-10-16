---
id: t13808-manifest-local-rows
tasks: [T13808, T13777]
kind: fix
summary: the vault manifest leaves out rows that stay on their device, so a store holding them pushes and verifies in sync
---

A row local by its row-identity spec (no uid: a NULL key column under
`localWhenNull`, or a later handoff of one session under `localUnlessFirst`)
never travels in the change journal, but the vault manifest counted and hashed
it. A store holding one refused `cleo cloud push` ("a write landed outside the
journal") or showed `ahead` in `cleo cloud verify`, and a peer never matched it.

The manifest now leaves such rows out (vault manifest format 3). The first
checkpoint over a parent of format 2 names the rows that parent counted as
`pruned`, so the server's row rule holds without a server change. A snapshot of
format 2 still restores and verifies: it is checked with local rows counted, as
it was hashed. An older cleo reads a format-3 head as a newer format and asks to
be upgraded.
