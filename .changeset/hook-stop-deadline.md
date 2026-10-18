---
id: hook-stop-deadline
tasks: [T13890]
kind: fix
summary: cleo hook stop no longer waits on session end or a hung ask-enforce; only the bounded goal tick can delay it
---

The Stop dispatcher (`cleo hook stop`) could outlast Claude Code's 120 s Stop
timeout. The goal tick was already bounded: its process group is SIGKILLed at
the deadline, and its stdout stops being read even when an escaped
grandchild holds it. The two steps after the tick were not bounded.

- `cleo session end` (claude-code) now runs detached and is never awaited.
  It used to be a `spawnSync` with no timeout, and session end can take
  longer than the Stop timeout.
- The ask-enforce step has its own 5 s deadline (`ASK_ENFORCE_DEADLINE_MS`).
  Past that it counts as no block.

A Stop now returns within the tick deadline plus at most 5 s.
