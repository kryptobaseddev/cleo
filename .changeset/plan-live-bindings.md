---
id: plan-live-bindings
tasks: [T14209]
kind: fix
summary: "done --plan counts a criterion a live binding covers, such as a cleo verify --criterion receipt, as linked, so it needs no --satisfies"
---

A criterion covered by a per-criterion receipt (`cleo verify --criterion`,
T14199) still blocked `cleo done --plan` with `ac-mapping-needed` unless it
was named in `--satisfies`, and naming it would have bound it to the change's
code as well. The plan's criterion mapping now reads the coverage
`cleo complete` reads, through the shared `completionCoverageAccessor`: a
criterion with a live (non-stale) binding is linked. A stale binding (the
criterion edited after it) still blocks.
