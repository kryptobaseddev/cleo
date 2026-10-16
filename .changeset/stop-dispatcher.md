---
id: stop-dispatcher
tasks: [T13796]
kind: feat
summary: "One Stop entry per provider: cleo hook stop runs goal tick, then ask-enforce, then session end, so they no longer fight"
---

A goal runtime's Stop hook (OpenCode-Goal's `ocg tick`), CLEO's ask-enforce
Stop hook and `cleo session end` each claimed the Stop event. They fought: the
session ended while a goal or an owed owner ask kept the turn going.

`cleo hook stop --provider claude-code|codex` is now the one CLEO Stop entry.
It runs, in order:
1. The goal tick (`CLEO_GOAL_TICK_COMMAND`, default `ocg tick`, Stop JSON on
   stdin). A `{"decision":"block","reason"}` answer goes to the harness
   verbatim, and nothing else runs. `{"final":false}` keeps the session open.
2. Ask-enforce. Its block wins next, and the session is not ended while the
   agent owes the owner an ask. A warning is forwarded.
3. `cleo session end --quiet`, exactly as before.

Each step fails open to today's behaviour: no goal runtime installed, a tick
that fails, times out or prints non-JSON, or an ask-enforce error.
`CLEO_GOAL_TICK=off` and `CLEO_ASK_ENFORCE=off` skip their steps.

Syncing folds the separate ask-enforce and old session-end Stop entries into
the dispatcher in place, for Claude Code and Codex.
