---
id: hook-stop-deadline
tasks: [T13890]
kind: fix
summary: cleo hook stop waits at most 20 s for session end and 5 s for ask-enforce, so it returns under Claude Code's Stop timeout
---

The Stop dispatcher (`cleo hook stop`) could outlast Claude Code's 120 s Stop
timeout. The goal tick was already bounded: its process group is SIGKILLed at
the deadline, and its stdout stops being read even when an escaped
grandchild holds it. The two steps after the tick were not bounded.

- `cleo session end` (claude-code) used to be a `spawnSync` with no timeout.
  It is now waited for at most 20 s (`SESSION_END_WAIT_MS`), then left
  running in the background. A failure or an overrun prints one stderr line
  with the duration. In rel-qual's repro on a 1.38 GB store, session end
  spent about 150 s writing three full backups (T13891).
- The ask-enforce step has its own 5 s deadline (`ASK_ENFORCE_DEADLINE_MS`).
  Past that it counts as no block and prints one stderr line.

A Stop now returns within the tick deadline (60 s at most) plus 5 s plus
20 s, under the 120 s harness timeout.
