---
id: count-summary-zod-drift
tasks: [T14061]
kind: fix
summary: "minCount gates accept a last-line count summary again; zod is pinned to the version CI tests"
---

A typed test gate with `minCount` whose command prints a bare count summary
(`{"numPassedTests":7,...}`) as its last stdout line always errored with "no
machine-readable test report". The summary schema declared `testResults:
z.undefined()`, and the zod that published installs resolve (4.6.7, from
`^4.3.6`) treats an absent `z.undefined()` key as required, so every summary
was rejected. The repo lockfile pins 4.3.6, so CI never saw it.

The key is now `z.never().optional()`: absent passes, a present `testResults`
is still rejected under both zod lines. `@cleocode/contracts` and
`@cleocode/core` now pin `zod` to exactly 4.3.6, the version the lockfile
tests, so an install cannot resolve a zod CI never ran.
