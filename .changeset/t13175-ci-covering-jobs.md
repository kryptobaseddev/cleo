---
id: t13175-ci-covering-jobs
tasks: [T13175]
kind: fix
summary: ci:<pr> accepts the jobs that cover a PR's changed paths when the change filter correctly skipped the package jobs (evidence.ciChecks.covering)
---

`ci:<pr>` required every `evidence.ciChecks.jobs` glob (for example
`Unit Tests*`) to have run and succeeded. A scripts-only PR has its package unit
shards correctly skipped by CI's change detection while `Scripts Tests` runs,
so it could never attest testsPassed from CI, and the fallback was a local run.

`evidence.ciChecks.covering` now declares which jobs cover which paths, per
gate:

```json
"covering": {
  "tests": [{ "paths": ["scripts/**"], "jobs": ["Scripts Tests"] }],
  "qa": [{ "paths": ["scripts/**"], "jobs": ["Lint & Format"] }]
}
```

The skip is accepted when every required job either succeeded or was skipped on
every run, at least one was skipped, every changed path matches a rule, and that
rule's jobs ran and succeeded. A cancelled, failed, pending or missing required
job never counts as a skip, and a path no rule covers (a package file in a mixed
PR) still needs the package jobs. The required check itself must still be green,
so a skip caused by a failed upstream job is already refused. A malformed rule
voids the whole list. This repo declares the scripts rules in
`.cleo/project-context.json`, and the project-context schema accepts the key.
