---
id: t13494-spawn-agent-id
tasks: [T13494]
kind: fix
summary: "orchestrate spawn names the agent identity, persona and role separately: data.agentId now matches the session and worktree agent id"
---
`data.agentId` in the spawn envelope carried the classifier's persona (e.g. `project-security-worker`), while the spawned agent's session, `worktreeEnv.CLEO_AGENT_ID` and the worktree lock all used its identity, `agent-<task>` (axiom T1797).

The envelope now names three things separately:
- `agentId`: the spawned agent's identity, the same value as `CLEO_AGENT_ID`, the session handle and the lock holder.
- `persona`: the agent profile the classifier routed to, mirroring `meta.classify.agentId`.
- `role`: what it runs as (unchanged).

`OrchestrateSpawnResult` in contracts documents all three.

Breaking for any reader that took the persona from `data.agentId`: read `data.persona` or `meta.classify.agentId` instead.
