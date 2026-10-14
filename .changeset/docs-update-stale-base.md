---
id: docs-update-stale-base
tasks: [T13674]
kind: fix
summary: cleo docs update detects a stale declared base — append edits three-way merge, non-mergeable edits record a named section conflict, an unresolvable base is refused (T13674)
---

Two writers fetch the same doc and each append to one section. The first
`cleo docs update` lands; the second — authored against the now-superseded
head — silently replaced the head text: the first writer's tail vanished from
the current text with `sectionConflicts` null, surviving only in its own
version row. `applySectionTextEdit` treats stored === headText as a single
writer and re-seeds from the incoming text, and `updateDocBySlug` took no base
parameter, so the second writer's stale fetch could not be detected.

`docs.update` now accepts `--base-version-uid` (the `metadata.headVersionUid`
from the writer's `cleo docs fetch`). The declared base's section texts
replace the previous head's as the merge discriminator inside the section CRDT
projection: an append-shaped stale edit composes onto the stored state so both
writers survive (`staleBaseMerged: true` + a `W_DOC_STALE_BASE` remedy
warning), and a non-mergeable edit is recorded as a named section conflict
(`sectionConflicts`) with the authored text preserved in its own append-only
version row — never a silent drop, never fabricated text. A declared base
that does not resolve to the doc's version history is refused with
`E_DOC_BASE_UNKNOWN` before any write. Omitting the base keeps the
pre-existing single-writer semantics (documented risk for callers that edited
from an older fetch).

Only inline-content updates project through the section CRDT; `file`-based
updates stay on the whole-doc path (T13355) and do not take the base into
account.
