---
id: issue-severity-area-enums
tasks: [T13478]
kind: fix
summary: cleo issue bug|feature rejects a --severity or --area outside its declared values (gh#1383)
---

`cleo issue` declared closed enums for `--severity` (Blocker, Major,
Moderate, Minor) and `--area` (cli, dispatch, docs, tests, other) in help
text only; `addIssue` interpolated any value into the issue body. A
`--severity P2` (the `cleo add` vocabulary) was filed unchanged.

`addIssue` now rejects an out-of-enum value before building the body, naming
the allowed values, and the `--severity` error notes that P0-P3 belongs to
`cleo add --severity`. The lists are exported from core (`ISSUE_SEVERITIES`,
`ISSUE_AREAS`) and the CLI help renders from them, so help and validation
cannot drift. The CLI still reports the failure as `E_ISSUE_CREATE`.
