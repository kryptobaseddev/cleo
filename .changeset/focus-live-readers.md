---
id: focus-live-readers
tasks: [T12684]
kind: fix
summary: "every focus read that reports the current task goes through readLiveFocus: inject, bootstrap, orchestrator startup, stats, validation, attention and drift never surface a finished task; briefing's stale warning carries W_STALE_FOCUS"
---
T12660 stopped `cleo current` and the briefing from reporting a finished task.
Its review found other readers that still did:
- raw legacy `focus_state` reads in orchestrator startup (×2), stats,
  inject-generate and validate-ops;
- `readFocusState` reads with no live-status check in inject and bootstrap.

- **One validating reader.** `readLiveFocus(accessor, sessionId)` returns the
  stored blob and the current task only while it is still workable. For a
  done, cancelled, archived or missing task it returns `staleFocus` instead.
  It looks the task up with `loadSingleTask`, so an archived task reads as
  `archived`, not missing.
- **Readers converted.** Every reader that reports or acts on the current task
  now uses it: `cleo current`, briefing, session status, inject,
  inject-generate, bootstrap, orchestrator startup and HITL summary, stats,
  validate-ops, attention, session drift and the drift watchdog.
  - The raw `readFocusState` stays only for read-modify-write of the blob.
  - A test fails on any new raw legacy read, or any raw read outside those
    writers.
  - The legacy readers also switch from the global key to the caller's
    session key, with the legacy key as fallback.
- **Inject.** Inject never puts a finished task into agent context. It used to
  drop only `done`; cancelled and archived tasks are now excluded too.
- **Another session's pointer.** When session A completes a task, session B's
  stored pointer to it is left unchanged, but every reader reports it stale.
- **Briefing.** The stale warning now starts with `W_STALE_FOCUS:`. The
  briefing carries a `staleFocus` field, and its envelope carries a coded
  `W_STALE_FOCUS` warning. validate-ops reports a stale pointer as a
  `W_STALE_FOCUS` warning on its focus check.
