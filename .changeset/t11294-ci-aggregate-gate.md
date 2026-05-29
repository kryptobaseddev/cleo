---
id: t11294-ci-aggregate-gate
tasks: [T11294]
kind: chore
summary: add an aggregate CI gate job so the required 'CI' branch-protection context resolves to a real check (was a phantom blocking every PR)
---

Branch protection on main requires a status context named 'CI', but GitHub posts one check-run per job, not per workflow — so the workflow being named 'CI' never produced a 'CI' check and the required context was a phantom that only an admin override could satisfy. New aggregate gate job (name: CI, if: always(), needs: every job) fails iff any upstream job failed/cancelled and accepts skipped (path-filtered) jobs, making the required context a real, durable check robust to skips.
