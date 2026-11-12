---
id: t14498-awaited-admission-writes
tasks: [T14498]
kind: fix
summary: "Admission cleanup awaits pending ledger writes within one deadline before returning"
---

Queued cancellations and grant release drain ledger updates within the cooperative
250 ms cleanup bound. Timed-out updates cannot start another write after teardown;
the retry and the reaper after process exit own any remaining retirement.
