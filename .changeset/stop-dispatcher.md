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
1. The goal tick, only when a goal workspace (`.opencode/goals/`) exists:
   `CLEO_GOAL_TICK_COMMAND` (default `ocg tick`) with the Stop JSON on stdin.
   - The tick must write JSON only.
   - A block answer is re-serialised as exactly `{decision, reason}`, with the
     reason capped, so a tick cannot inject other hook fields. Nothing else
     runs after it.
   - `{"final":false}` keeps the session open.
   - The tick runs in its own process group, which is SIGKILLed at its
     deadline (at most 60 s).
2. Ask-enforce. Its block wins next, and the session is not ended while the
   agent owes the owner an ask. A warning is forwarded.
3. For Claude Code, `cleo session end --quiet`, exactly as before. Codex's
   Stop never ended the session and still does not: its Stop fires every turn.

Each step fails open to today's behaviour: no goal runtime installed, a tick
that fails, times out or prints non-JSON, or an ask-enforce error.
`CLEO_GOAL_TICK=off` skips the tick. Ask-enforce keeps its opt-outs, now read
when the hook runs: `CLEO_ASK_ENFORCE=off`, or heavy-command mode `off`
(`CLEO_HEAVY_COMMAND_HOOK` / `resources.heavyCommandHook`).

Syncing folds the separate ask-enforce and old session-end Stop entries into
the dispatcher in place, for Claude Code and Codex.
