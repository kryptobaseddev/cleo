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
- `release.yml` Publish: waves 1-5 share a 20 min publish deadline
  (`SMALL_WAVES_BUDGET_S`) and the CLI wave has its own 75 min deadline
  (`CLI_WAVE_BUDGET_S`), which starts after the stable dependency gate and
  sits above the slowest recorded publish (55m33s). Every `npm view` is bounded
  at 30s, `pnpm install` at 10 min and each artifact download at 5 min. A
  package not published by its deadline fails as `FAIL-TIMEOUT` with its name,
  and the diagnosis guide says to re-run the failed jobs so the remaining waves
  publish. The job timeout rises from 210 to 355 minutes (GitHub's cap is 360)
  to cover the worst case its comment now adds up: 341 minutes.
- `scripts/release-canary-soak.mjs` exports `soakWorstCaseMs()` (45 min), the
  number the job budget is checked against in `release-rc-gate.test.mjs`.
