---
id: one-doc-resolver
tasks: [T14288]
kind: fix
summary: "docs fetch, update, supersede and publish resolve a slug through the doc's immutable identity to its head, and cleo upgrade gives every legacy doc that identity"
---

A doc was found by whichever registry row carried its slug, so a renamed doc
(an old slug) or a head that moved by sync could resolve to the wrong bytes.
Fetch, update, supersede and publish now resolve a slug, live or an old alias,
through the doc's immutable uid to its head version and read its bytes from
there. The version an update reports is counted from the doc's version
history; the docs-versioning log is audit-only.

A doc that has no identity yet still resolves (through its registry row) with a
`W_DOC_NOT_MIGRATED` warning, and `cleo upgrade` now runs `cleo docs migrate`,
so every store gains the identity on its next upgrade.
