---
id: deploy-evidence-atom
tasks: [T14083]
kind: feat
summary: "deploy evidence atom - an exact-commit deployment plus a health probe naming it counts for the gates a project maps it to"
---

The 2026-10-27 audit (T14041) found 63 owner overrides whose evidence was a
deployment of the exact commit plus a health probe (`/healthz` 200). CLEO had
no atom kind for that, so each one needed an override.

A new atom covers it:

```
deploy:<provider>/<deploymentId>@<sha>=<probeUrl>
```

It counts for `testsPassed` and/or `qaPassed` only when the project lists the
gate in `evidence.deployGates`.

The validator checks three things:
- the deployed commit exists in the repository and contains every commit the
  task's `implemented` evidence records;
- the probe answers 2xx;
- the probe's response names the deployed commit.

It records the full SHA, the probe status and the probe time.
