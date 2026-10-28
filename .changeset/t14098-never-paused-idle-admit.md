---
id: t14098-never-paused-idle-admit
tasks: [T14098]
kind: fix
summary: "a never-paused cleo run (a test run, --no-pause) at backoff now starts by the idle rule when CLEO holds nothing, instead of deferring forever"
---

Since T14093, a run that executes tests is never paused, so it started only
below backoff. On a host held at backoff by processes outside CLEO it never
started while CLEO held nothing: macOS main CI on d603f57f4 deferred
`cleo run --passthrough --class test -- node -e …` with exit 75.

For the ledger classes the backoff hold now lives in the admission ledger and
reuses the T14088 idle rule: a never-paused waiter at backoff starts one at a
time, in queue order, when no CLEO run is admitted and its charge fits the
reclaimable memory. Non-tiny runs queued behind it keep their place, so a
stream of pausable runs cannot starve it. Above the memory gate's refuse line
nothing starts. The wait names the rule that holds the run, and an idle-rule
admission says so. `run-passthrough-cli.test.ts` sets
`CLEO_ADMISSION_PRESSURE=off`, so host pressure no longer decides whether its
runs start.
