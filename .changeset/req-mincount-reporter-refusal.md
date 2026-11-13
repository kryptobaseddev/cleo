---
id: req-mincount-reporter-refusal
tasks: [T14526]
kind: fix
summary: "cleo req add and replace refuse a minCount test gate whose command prints no countable report"
---

A `test` gate with `minCount` passes only on a report its own command prints. A
Vitest, Jest or node:test command with no reporter flag was accepted at write time
and errored only when `cleo verify --run` ran it at close. `cleo req add` and
`cleo req replace` now refuse such a gate and name the corrected gate with the
runner's reporter flag (`--reporter=json`, `--json`, `--test-reporter=tap`). The
flag comes from the same runner detection the run-time error uses.
