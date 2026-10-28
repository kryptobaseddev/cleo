---
id: main-ci-cancel-queued
tasks: [T14103]
kind: fix
summary: "main CI keeps the run in progress and cancels a run still queued for an older commit; ci: evidence for that commit resolves through the newest green main run"
---

Every main commit had its own CI concurrency group (T12189), so a merge burst
ran every commit's CI in full even after main had moved past it. Main now
shares one group per event with `cancel-in-progress: false`. The run in
progress finishes, and a newer push cancels a run that is still waiting.
Pull requests still cancel on every new push, and the nightly schedule run
never collides with a push run.

A run cancelled while queued never starts a job, so its merge commit carries
the cancelled workflow run and no job check runs. The `ci:` atom now treats a
required check missing there as superseded when its pinned workflow's latest
push run on that commit was cancelled with no check runs at all, and accepts
the newest green main run that descends from it (T12742). A job missing from
a run that did start is still refused.
