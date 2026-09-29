---
id: docs-update-status-alone
tasks: [T12654]
kind: fix
summary: "`cleo docs update <slug> --status <s>` works for every status --help lists, and --status alone changes only the lifecycle"
---

`cleo docs update --help` advertises six lifecycle statuses for `--status`:
`draft`, `proposed`, `accepted`, `superseded`, `archived` and `deprecated`. In
practice, specs could not be accepted, and two guards were to blame.

The input sanitizer validated every `status` param against the task and
manifest statuses. It rejected `draft`, `accepted`, `superseded` and
`deprecated` for docs with `E_VALIDATION_FAILED`. `proposed` and `archived`
got through only because they are also task statuses. A docs status is now
checked against the doc lifecycle set.

The CLI, the dispatch handler and the core also each required `--file` or
`--content`. You had to re-supply a doc's bytes just to change its status.
`--status` alone is now a lifecycle-only update. The stored bytes are kept
(`changed: false`, sha256 unchanged), no new blob is written, and an audit
entry records the transition. Passing `--file` and `--content` together is
still rejected, and so is passing none of the three.
