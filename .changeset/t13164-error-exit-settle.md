---
id: t13164-error-exit-settle
tasks: [T13164]
kind: fix
summary: A failed mutation now writes its audit_log row, and the CLI's error exits no longer kill pending hook writes or buffered telemetry
---

`cleo update T999` exited 4 and left no audit row. The audit middleware inserted fire-and-forget,
and the CLI's error path called `process.exit` right after printing the envelope, before the insert
ran. The insert is now awaited, so the row exists before the dispatcher returns, whatever exit path
follows (including the commands that call `process.exit` themselves).

The same audit of the error path found three more writes `process.exit` could kill:
- the PromptSubmit and ResponseComplete hook dispatches (work-capture BRAIN writes, adapter native
  hooks);
- tracked post-commit background operations;
- buffered telemetry, which flushed only on `beforeExit`, an event `process.exit` skips.

The hook dispatches are now tracked background operations. A new core `settleBeforeExit` waits for
tracked producers, within the 2 s shutdown budget, then flushes telemetry. It closes and latches
nothing. It runs before the error exit in `dispatchFromCli`, in `dispatchRaw` on a failure (whose
callers exit through `handleRawError`), and in the CLI's top-level error handler.
