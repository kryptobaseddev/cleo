---
id: census-deterministic-timing
tasks: [T14567]
kind: fix
summary: "Make hygiene census regression tests deterministic: read the scanner PID after close and verify claim times at exact daily boundaries"
---

The bounded-report test now reads its scanner PID after the reporting process
closes, when the scanner has stopped rewriting the marker. Reading during a
truncate-and-write could produce an empty string, interpreted as PID 0, so the
process termination assertion incorrectly probed the test runner's process group.
The test also verifies that the recorded PID is positive.

The daily-claim test verifies the persisted injected clock and both sides of
two exact interval boundaries, protecting the T14438 scheduler-clock fix against
filesystem timing drift. All cancellation, partial-coverage and lock-release
assertions remain in place.
