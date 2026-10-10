---
id: t13405-display-remint
tasks: [T13405]
kind: feat
summary: "Sync re-mints a colliding display id (T####, D####, SN-###) when the origin settles a uid collision"
---

Two rows that collide on a uid also share their counter display id, so after the origin re-keys its losing row the winner stayed held as a key collision. The origin now also gives its loser the next free id (above every id it holds or has staged) in a second `rekey` frame, renaming the row's local references with it: child tasks, decision supersession links, `decision:<id>` page nodes and edges, `decision:<id>` evidence atoms in task verification, and sticky-note tags. Receivers fold that rename into the insert they held, so both rows place under distinct ids everywhere, and a replica that had placed the loser points its own referencing rows at the new id. The origin is the authority until the server re-mints at ingest for cloud-synced projects (T13404).
