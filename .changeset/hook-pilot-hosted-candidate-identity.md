---
id: hook-pilot-hosted-candidate-identity
tasks: [T13831]
kind: fix
summary: Require exact-commit hosted dispatches for future hook promotion evidence
---

Version 2 hook promotion evidence requires a successful workflow_dispatch
run on the declared VidaPeps commit. A pull-request run reports its branch
head while checking a synthetic merge commit, so its head SHA alone cannot
identify the checked candidate. Existing hosted-job checks remain required,
and historical version 1 evidence stays verifiable through 2026.10.17.
