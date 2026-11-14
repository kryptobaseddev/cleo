---
id: census-deterministic-timing
tasks: [T14567]
kind: fix
summary: "Make hygiene census regression tests deterministic: publish scanner PIDs atomically and verify claim times at exact daily boundaries"
---

The bounded-report fixture publishes its scanner PID through a temporary file
and atomic rename, so cancellation cannot leave a truncated marker. The test
reads the marker after the reporting process closes and verifies a positive PID.
Previously, an empty marker became PID 0, so the process termination assertion
incorrectly probed the test runner's process group.

The daily-claim test verifies the persisted injected clock and both sides of
two exact interval boundaries, protecting the T14438 scheduler-clock fix against
filesystem timing drift. All cancellation, partial-coverage and lock-release
assertions remain in place.
