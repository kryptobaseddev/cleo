---
id: docs-doctor-archive-publication
tasks: [T14632]
kind: fix
summary: "docs doctor publication-ledger-drift archives a gone row's only-held blob into its adopted doc's history, then prunes the row"
---

A ledger row whose mirror is gone and which was the only reference to its blob
stayed `republish-or-prune` forever, even when the doc had simply been
renumbered and another row publishes the same (ownerId, blobName) stream in sync.

- **New repair `archive-publication`.** When that stream's live row publishes the
  exact head of one adopted doc, `--apply` imports the gone row's hash-verified
  bytes as a prior conduit version of that doc (origin `archived-publication`,
  created at the row's `publishedAt`, head untouched). It writes an audit line to
  `.cleo/audit/docs-publications-prune.jsonl` first.
- **Conduit history protects a blob.** The doctor's protected set now counts
  conduit doc history, matching blob GC, so the next run plans
  `prune-publication` for the archived row.
- **Unadopted docs are refused.** If the doc has no conduit history, the finding
  stays `republish-or-prune` and names `cleo docs migrate`. Nothing is written.
