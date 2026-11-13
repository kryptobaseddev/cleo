---
id: docs-doctor-superseded-ledger-rows
tasks: [T14504]
kind: fix
summary: "`cleo docs doctor --apply` prunes a publication-ledger row only when a newer in-sync row of the same owner provably supersedes it"
---
A doc republished under a new blob name (for example `pr-cadence.md` →
`pr-cadence`) left its old `docs_publications` row behind, and `cleo docs
status` reported that row as `modified` beside the in-sync one forever. The
doctor now plans `prune-publication` for such a row only when it is provably
superseded: a newer row of the same owner publishes the same path in sync, and
the doc's canonical head (its conduit head, else its registry row; never the
best-effort blob manifest) is already published there or never moved past this
row's publish. A moved head is a pending publication, and a head that does not
resolve keeps the row. A blob is protected only by an
attachment or by a ledger row that survives the run, so two prune candidates
never protect each other and the last row naming a blob is never deleted. Same
backup gate and prune audit as every other ledger prune.
