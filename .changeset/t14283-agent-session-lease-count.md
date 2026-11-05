---
id: t14283-agent-session-lease-count
tasks: [T14283]
kind: fix
summary: "The spawned agent-session budget is a lease count (resources.agentSession.maxSessions, default cpus - 2) that memory outside CLEO no longer shrinks to 1; only critical memory stops a spawn, with E_RESOURCE_EXTERNAL_PRESSURE"
---

The agent-session budget was `clamp(1, (free memory - 2 GiB) / 4 GiB, cpus - 2)`
minus the live leases. Free memory already excludes the sessions it then
counted again, and 30 GB held by a codex session drove the budget to 1
machine-wide. The budget is now `resources.agentSession.maxSessions`, default
`max(1, cpus - 2)`, with each lease counted once. A spawn is refused for memory
only when memory is critical (a full memory stall, the macOS critical pressure
level, or swap at least 90% full), and then with `E_RESOURCE_EXTERNAL_PRESSURE`
naming the programs holding it. `resources.agentSession.estRamMb` and
`resources.agentSession.headroomMb` are accepted and ignored for one release,
with a deprecation note.
