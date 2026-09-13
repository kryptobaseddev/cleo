---
id: exit-backstop-preserves-exit-code
tasks: [T12166]
kind: fix
summary: the exit backstop no longer forces rc:0, discarding the failure a command already reported
---

`armExitBackstop(0)` on the CLI success path hardcoded exit code 0. When the
backstop fires, `process.exit(0)` discards whatever `process.exitCode` the
command had set — so a command that failed exits **0**.

This is not a narrow path. **199 call sites in `packages/cleo/src` report
failure by SETTING `process.exitCode` and returning normally** rather than
calling `process.exit()` — `add-batch` (`VALIDATION_ERROR`), `agent`, and many
others. Those returns go through the success-path `finally`, which is precisely
where the backstop is armed. The error branches that `process.exit(1)` bypass
the `finally` entirely, so they were never the ones at risk; the ones at risk
are the ones that look like a normal return.

And the backstop is not rare. Its own docblock says so: an unref'd timer fires
whenever the loop is alive for **any** reason at that moment, including
legitimate unawaited work — `cleo memory observe` schedules a fire-and-forget
embedding whose first call loads a ~22 MB model and will not finish inside the
grace window on a cold cache.

So the failure mode is: a failed `cleo add-batch` writes an envelope saying it
failed, lingers 3 s on unrelated background work, and exits **0**. Every caller
that checks the exit code — CI, a shell `&&`, an orchestrating agent — is told
it succeeded. The CLEO protocol instructs agents to check the exit code first,
so this inverts the signal the protocol leans on hardest.

The backstop now resolves its code at **fire** time, inheriting
`process.exitCode` when the caller did not name one, and the call site passes
nothing. Reading at fire time rather than arm time also catches a code set after
arming. An explicit argument still wins, so callers that genuinely want a fixed
code keep it.

Found by a cross-PR composition review of the open queue, which reported it
against #1258 + #1261 and was then narrowed by the adversarial pass to a
single-PR defect in #1258 — the shipped code, not the combination.
