---
id: done-shared-evidence
tasks: [T14072]
kind: fix
summary: "cleo done accepts --shared-evidence, the remedy its shared-atom warning names"
---

When one evidence atom (`ci:<pr>`, `pr:<n>`) is applied to more than three
tasks in a session, the gate write warns `W_EVIDENCE_AUDIT_MISS` and says
"Pass --shared-evidence to suppress this warning", or refuses under
`CLEO_STRICT_EVIDENCE=1`. Only `cleo verify` accepted that flag; `cleo done`
rejected it as `E_UNKNOWN_FLAG`, so closing several tasks from one merged PR
had no working remedy, and no way through at all in strict mode. `cleo done`
now takes `--shared-evidence` and passes it to the gate write, as it already
passes `--run-typed`.
