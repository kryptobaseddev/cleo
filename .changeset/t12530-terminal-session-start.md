---
id: t12530-terminal-session-start
tasks: [T12530]
kind: fix
summary: "session start conflicts only with a session the calling terminal already owns, so a second terminal starts its own session without --agent"
---

`cleo session start` (and SDK `startSession`) refused whenever any session was active, so a second terminal needed `--agent <handle>` even though T12499 had given every terminal its own binding key. The guard now reads the caller's identity (connection, env session id, or its own terminal binding row) without adopting anything: a session the same terminal already holds still conflicts, with a message naming it and the ways out, and a session no binding names still blocks with `session resume` advice. Sessions bound to other terminals, or tagged with an agent handle, no longer block. A caller with no identity at all keeps the old single-session guard. SDK `startSession` keeps writing the terminal binding; a test now pins it.
