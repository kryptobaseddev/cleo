---
id: t14504-doctor-prunes-renamed-ledger-rows
tasks: [T14504, T14108]
kind: fix
summary: "docs doctor prunes a stale publication-ledger row recorded under an old file name, or beside another owner's in-sync row"
---

`cleo docs doctor --only publication-ledger-drift` kept reporting
`reconcile-edit` for ledger rows whose mirror was already published in sync by
a newer row at the same path. Two cases failed closed: a row recorded under an
old file name (`tmp-x-readme.md`, `ADR-054-….md`) named no doc, so its head
could not be resolved; and a newer in-sync row counted only when it had the
same owner.

The doctor now resolves such a row through the attachment that holds the blob
it published. A slugged holder resolves to its doc's head; a slugless holder
(an old version row) proves nothing about its doc, so only a newer row of the
same owner may supersede it. A row resolved this way is pruned only when its
doc never moved past that blob and a newer row at the same path is the live
publication of a doc that resolves by name. A newer in-sync row of any owner
now counts. Rows whose blob no attachment holds are still kept, and every
prune is still audited and protected by the blob-holder check.
