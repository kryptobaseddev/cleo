---
id: t14646-publish-job-bounded-waits
tasks: [T14646]
kind: fix
summary: "every wait in the release publish job has its own timeout, so a stuck publish, registry fetch or install fails with its gate's message before the job timeout"
---

- `scripts/execute-payload.mjs`: each registry request is aborted after 30s
  (`FETCH_TIMEOUT_MS`), and the poll budget is now a hard deadline. A round
  still waiting on the registry when the budget runs out is abandoned instead
  of holding the gate past it, and the report after a timeout uses each
  package's latest answer instead of polling the registry one more time.
- `release.yml` Publish: every `pnpm publish` of a release shares one 60 min
  deadline (`PUBLISH_BUDGET_S`) and every `npm view` is bounded at 60s. A
  package not published by the deadline fails as `FAIL-TIMEOUT` with its name.
  The job timeout rises from 210 to 270 minutes to cover the worst case its
  comment now adds up: 251 minutes.
- `scripts/release-canary-soak.mjs` exports `soakWorstCaseMs()` (45 min), the
  number the job budget is checked against in `release-rc-gate.test.mjs`.
