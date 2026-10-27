---
id: release-open-redispatch
tasks: [T14077]
kind: fix
summary: "cleo release open dispatches again when the recorded release-prepare run failed or was cancelled, and reports the prior run's state"
---

Re-running `cleo release open` for a version already at `pr-opened` returned
`idempotent: true` and the old run URL, even when that run had failed, so a
failed release could only be re-dispatched by hand with `gh workflow run`. It
now asks GitHub for the recorded run's status and conclusion. A run that
concluded `failure`, `cancelled`, `timed_out` or `startup_failure` is
dispatched again with the same fields, and the new run URL is recorded. A run
that is queued, in progress or succeeded keeps the idempotent no-op. Both
envelopes carry `priorRun` (`url`, `status`, `conclusion`, `redispatched`).
When GitHub cannot be asked, the call stays idempotent.
