---
id: t13501-typed-gate-stale-plan
tasks: [T13501]
kind: fix
summary: "cleo done --plan no longer reads a typed gate pass bound to an older criterion or gate definition as a pass; it reads not-run, as cleo complete refuses it"
---

After a typed gate's definition changes (`cleo req replace`, or
`cleo update --acceptance`), its stored result is bound to the old criterion
and gate hashes, and `cleo complete` refuses it as stale. `cleo done --plan`
still showed it as a pass, so the plan could read ready while completion
refused. The plan now compares the binding's criterion and gate hashes, and
shows a stale pass as `not-run`, meaning run it again.
