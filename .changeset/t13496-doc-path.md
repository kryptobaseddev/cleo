---
id: t13496-doc-path
tasks: [T13496]
kind: fix
summary: "a research task's planned files atom now names the attachment-store file that cleo docs fetch resolves, falling back to the blob store"
---

A research or documentation task's `cleo done --plan` named its review doc as
`.cleo/blobs/blobs/<sha256>`, while `cleo docs fetch` resolved the same doc at
`.cleo/attachments/sha256/<prefix>/<rest>.<ext>`. The planned `files:` atom
now names the attachment-store file when one exists, and falls back to the
blob store, which holds the same bytes for canonical docs. Both paths hash to
the same sha256, so plans recorded with the old path keep validating.
