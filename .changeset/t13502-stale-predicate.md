---
id: t13502-stale-predicate
tasks: [T13502]
kind: fix
summary: "cleo done --plan and cleo complete judge a stored typed result as stale with one shared predicate, so the plan never reads as a pass a result completion refuses"
---

`cleo complete`'s typed revalidation refuses a stored result whose binding
belongs to another task, project, project root or criterion id, or to an older
criterion text or gate definition. `cleo done --plan` compared only the two
hashes. Both now call one exported predicate, `typedResultStaleReason`. A
binding moved to another root, or a changed criterion id, now reads `not-run`
in the plan.
