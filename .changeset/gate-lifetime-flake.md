---
id: gate-lifetime-flake
tasks: [T14532]
kind: test
summary: "Gate lifetime tests interrupt real process capture deterministically after resource admission"
---

The shared-deadline and cancellation tests started real timers before worktree
resolution and machine resource admission. On a busy runner, either interruption
could precede process capture, correctly returning an error without an execution
observation and failing an assertion intended for an interrupted capture.

Hold the operation clock until the real capture starts, then expire its original
deadline or cancel it explicitly. Keep real process launch and cleanup, the same
budgets, both interruption assertions and the checks that later gates never run.
Both cases repeat thirty times through Vitest's native `repeats` option; no
timeouts or assertions are relaxed.
