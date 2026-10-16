---
id: t13786-seed-data-typecheck
tasks: [T13786]
kind: fix
summary: "Declared seed/data globs owe dependents a typecheck, not tests, and a test file edited beside the data no longer cancels that"
---

This extends the T13783 owner decision, `evidence.typecheckOnlyDependents`, to
declared seed/data paths. VidaPeps T1305 / PR #875 edited
`lib/db/src/seed-data/glp1.ts`. Its `testsPassed` fanned out to every package
that depends on `lib/db`.

With `lib/db/src/seed-data/**` declared on the default branch, a targeted
run of `lib/db`'s tests, plus a typecheck covering the dependents, closes the
gate. A test file edited beside the data no longer makes the package count as
code; the report must still run it. A source edit beside the data still makes
the dependents owe tests.
