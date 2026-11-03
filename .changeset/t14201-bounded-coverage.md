---
id: t14201-bounded-coverage
tasks: [T14201]
kind: fix
summary: "cleo verify, cleo complete and cleo start carry a bounded knowledge-coverage summary instead of the full repo-wide report"
---

`cleo verify`, `cleo complete` (including the already-done reply) and
`cleo start` attached the full repo-wide knowledge-coverage assessment to
every envelope: thousands of per-file reasons and evidence references
(8,385 reasons on the CLEO repository; about 330k tokens in one measured
envelope). They now carry the same bounded summary as orientation: status,
maintenance state, next action, the true reason and evidence counts, two
sample reasons, one evidence reference, and `detailsCommand: cleo doctor
knowledge`, which still returns the full report.
