---
id: ci-newest-run-and-push-waits
tasks: [T14611, T14617]
kind: fix
summary: "ci: judge jobs within the newest workflow run and wait on push checks"
---

Merge closure waits on push-scoped required checks even when PR checks run in a
separate workflow. Event-pin refusals name the missing configuration side and
explain that commit statuses cannot attest a triggering event. Job evidence uses
the newest workflow run per workflow, app and event, so superseded matrix skips
do not veto green legs and older jobs cannot fill a missing required leg.
