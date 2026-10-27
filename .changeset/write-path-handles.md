---
id: write-path-handles
tasks: [T12217]
kind: fix
summary: "cleo complete waits for its memory-usage write at teardown, and the health watchdog no longer keeps a one-shot session start alive"
---

- `cleo complete` recorded memory usage from an untracked `setImmediate`, so
  teardown closed the store under it and nothing waited for the write. It is
  now a tracked background operation, which teardown drains.
- The health watchdog's 60 s interval, armed on `SessionStart` when
  `brain.autoCapture` is on, kept a one-shot `cleo session start` alive until
  the 3 s exit backstop ("event loop still alive … held by: Timeout"). It is now
  unref'd: a long-lived host stays up for its own reasons and the patrol runs
  while it does.
- A CLI regression test runs `session start`, `update`, `docs add`, `docs update`
  and `session end` through the built CLI. It fails on the exit-backstop line or
  on a teardown step that timed out.
