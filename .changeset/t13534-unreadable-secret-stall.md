---
id: t13534-unreadable-secret-stall
tasks: [T13534]
kind: fix
summary: "One unreadable credential no longer stalls every later change on the home stream"
---

A credential whose secret this machine cannot decrypt (a restored or copied
row) used to hold its group pending and stop the sealer there, so every later
global change waited behind it. The group now stays held and is retried on
each sync, a later change to the same row (or one referencing it) waits behind
it, and every unrelated change seals and syncs. `W_SYNC_SECRET_UNREADABLE`
names the credential (`account:openai:home`) and is emitted once per row per
sync.
