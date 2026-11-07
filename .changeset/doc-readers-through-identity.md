---
id: doc-readers-through-identity
tasks: [T14288]
kind: fix
summary: "Every docs reading surface now finds a doc through its immutable identity, so an old slug still reaches a renamed doc, and an old slug can no longer be reused by a new doc"
---

Reading a doc by slug (fetch, read, lineage, the provenance graph, the viewer,
publish and find-similar), listing and indexing docs (list, search, triage,
wikilinks, the consistency check) now go through the doc's identity: the live
slug or an old alias, the doc's latest version, and the metadata kept on the
identity. A slug kept as an alias after a rename now counts as taken, so a new
doc cannot take it over, while renaming a doc back to its own old slug still
works. `cleo upgrade` fills in the identity metadata of docs that gained their
identity before it was recorded.
