---
id: t14269-per-agent-claim-identity
tasks: [T14269]
kind: fix
summary: "agents sharing one harness session keep separate claims and focus when each sets CLEO_AGENT_ID"
---

Agent-tool teammates inherit their lead's `CLAUDE_CODE_SESSION_ID`, so every
teammate bound the same CLEO session: one teammate's `cleo start` released
another's claim, and they could never review each other's work.

- With `CLEO_AGENT_ID` set, the provider key is qualified by the agent
  (`…|agent:<id>`). The agent resolves only its own binding, never the shared
  harness session.
- An agent's first mutation (`cleo start`, `cleo claim`, a focus write, a
  review verdict, any `requireBoundSession` caller) creates its own session,
  once, with the shared harness session as `parentSessionId`. Reads never
  create a session.
- The claim compare is on (session, agent): within one session, a lease held
  by a different named agent is not the caller's own: `cleo start` refuses
  it like another session's, and a refocus never releases it.
- The unqualified caller keeps the session bound to the plain provider key
  (owner decision D11234), so a lead without `CLEO_AGENT_ID` works as before.
- The spawn prompt's Session Linkage block now tells a spawned agent to
  export `CLEO_AGENT_ID`, also when no worktree was provisioned.
