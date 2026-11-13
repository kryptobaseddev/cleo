---
id: docs-doctor-superseded-ledger-rows
tasks: [T14504]
kind: fix
summary: "`cleo docs doctor --apply` prunes a publication-ledger row whose path another row already publishes in sync"
---
A doc republished under a new blob name (for example `pr-cadence.md` →
`pr-cadence`) left its old `docs_publications` row behind, and `cleo docs
status` reported that row as `modified` beside the in-sync one forever. The
doctor now plans `prune-publication` for such a superseded row when its blob
stays referenced elsewhere (otherwise it asks for an archive first), with the
same backup gate and prune audit as every other ledger prune.
