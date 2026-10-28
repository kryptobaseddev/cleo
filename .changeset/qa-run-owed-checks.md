---
id: qa-run-owed-checks
tasks: [T14089]
kind: fix
summary: "qaPassed with qa-run receipts owes only the checks that read the changed paths, so a lint receipt alone covers a .mjs-only change"
---

A `qa-run` lint receipt for a change touching only `.mjs` files was refused
("needs a typecheck and a lint result; missing typecheck"), although no
typecheck reads a `.mjs` file. A receipt now records, at bind time, the
changed paths each check reads (`owedChecks`, judged with the existing
`qaRunChecks`). qaPassed requires a result only for the checks with at least
one such path. A change with any TypeScript source still owes the typecheck.
The refusal names the check and the changed paths it reads, e.g.
`missing typecheck (it reads src/open.ts)`. Receipts bound before this
change, or with nothing judged, still owe both checks.
