---
id: docs-readers-stable-lineage
tasks: [T14580]
kind: fix
summary: "Keep incoming document supersession on its original identity during blob reuse and align graph and doctor readers after sync collisions"
---

Reusing a retired version's bytes, including a sync collision version, now
rehomes incoming supersession before assigning the row a different slug.
Ambiguous ownership refuses the reuse without changing the existing edges. Provenance graph
traversal resolves document identities, including task-rooted version rows,
and docs doctor uses the same derived edge reader as wikilinks rebuild.
