---
id: t12530-terminal-session-start
tasks: [T12530]
kind: fix
summary: "session start conflicts only with a session the calling terminal already owns, so a second terminal starts its own session without --agent"
---

`cleo session start` (and SDK `startSession`) refused whenever any session was active, so a second terminal needed `--agent <handle>` even though T12499 had given every terminal its own binding key. The guard now reads the caller's identity without adopting anything. That identity is an active connection or env session, or a provider / pane / tab key from the environment.

- **Same terminal:** a session this terminal already holds still conflicts, with a message naming it. In the SDK it conflicts in any scope, because starting another session would orphan it.
- **Unbound sessions:** a session no binding names still blocks, with `session resume` advice.
- **Other terminals:** sessions bound to other terminals, or tagged with an agent handle, no longer block.
- **Human after an agent:** a human in a tab where an agent started a session may start their own and is never told to end the agent's session.
- **No stable identity:** a caller whose only identity is the ppid fallback (agent, CI, cron or `ssh` shells, where the key changes on every call) keeps the old single-session guard.

Other changes:

- An env session id naming an ended session no longer stops the new session from being bound.
- `details.activeSessionCount` is the total number of active sessions, and the new `blockingSessionCount` counts only the blockers.
- A binding-read error other than a missing table or column is no longer swallowed.
