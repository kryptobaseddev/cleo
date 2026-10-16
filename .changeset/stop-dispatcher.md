---
id: stop-dispatcher
tasks: [T13796]
kind: feat
summary: "One Stop dispatcher: cleo hook stop asks a live goal runtime first and ends the CLEO session only when the goal says the turn is final"
---

A goal runtime's Stop hook (OpenCode-Goal's `ocg tick`) and CLEO's
`cleo session end` both claimed the Stop event. Run side by side, they fought:
the session ended while the goal kept the turn going.

`cleo hook stop --provider claude-code|codex` now owns the event. It runs the
goal tick (`CLEO_GOAL_TICK_COMMAND`, default `ocg tick`) with the Stop JSON on
stdin:
- a `{"decision":"block","reason"}` answer goes to the harness verbatim, and
  the session stays open;
- `{"final":false}` keeps the session open without continuing the turn;
- anything else runs `cleo session end --quiet` exactly as before. That covers
  no answer, `{"final":true}`, no goal runtime installed, and a tick that
  fails, times out or prints non-JSON.

`CLEO_GOAL_TICK=off` skips the tick.

Claude Code's native Stop hook is now the dispatcher, and an existing
`cleo session end --quiet` entry is replaced in place. Codex gets the
dispatcher in `.codex/hooks.json` beside ask-enforce, through the same writer.
