---
id: run-no-pause
tasks: [T14075]
kind: fix
summary: "cleo run --no-pause keeps a test run with wall-clock deadlines from being SIGSTOPped"
---

Under pressure `cleo run` SIGSTOPs younger pausable jobs. A test with
wall-clock deadlines, such as one against a real database with a child
timeout, failed when it was frozen mid-run: an axiom-qa Postgres integration
test was paused for 9 minutes and its 60 s migration verifier timed out. The
only exemption was the db-heavy class, which is admitted by governor slots
rather than the memory ledger, so using it misreported memory.

`cleo run --no-pause` (core `runGoverned({ noPause: true })`) marks the run as
never paused. It is admitted and charged on the memory ledger like any run of
its class. Because pressure cannot pause it once it runs, it starts only below
backoff: while the machine is at backoff it waits in the queue (with `--wait`)
or is deferred with `E_RESOURCE_DEFERRED`. Runs without the flag are paused as
before.
