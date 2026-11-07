---
id: doc-metadata-on-uid
tasks: [T14288]
kind: feat
summary: "A doc's kind, lifecycle, supersession and provenance are now also kept on its immutable identity, mirrored on every write"
---

A doc's metadata lived only on the registry row that carried its slug, a row
that each content update replaces. The doc's identity row now carries the same
metadata (kind, lifecycle, supersession as doc ids, summary, keywords, topics,
related tasks, ADR display number and writing release), written by every
command that changes it and when a doc gains its identity. Nothing reads it
yet; reads move to it in a following release.
