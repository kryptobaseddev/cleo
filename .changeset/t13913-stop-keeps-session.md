---
id: t13913-stop-keeps-session
tasks: [T13913]
kind: fix
summary: A Claude Code turn end no longer ends the CLEO session; the SessionEnd hook does
---

Claude Code fires Stop at the end of every turn, and the Stop dispatcher ran
`cleo session end` there, so the session ended (and its terminal binding was
deleted, and the session-end snapshot ran) after every turn. The next mutation
then failed with E_CLEO_SESSION_REQUIRED until `cleo session resume`.

`cleo hook stop` now runs only the goal tick and ask-enforce, for Claude Code
and Codex alike. A new `cleo hook session-end --provider claude-code` is
installed as Claude Code's `SessionEnd` hook (`cleo init`, `cleo upgrade`,
`cleo doctor heavy-command-hook --fix`, `cleo goal install`) and runs
`cleo session end --quiet` detached, waited for at most 20 s. Codex has no
session-end event, so its sessions end explicitly, as before.
