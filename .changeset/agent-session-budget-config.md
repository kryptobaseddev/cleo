---
id: agent-session-budget-config
tasks: [T14227]
kind: feat
summary: "the agent-session budget is configurable with resources.agentSession.maxSessions, resources.agentSession.estRamMb and resources.agentSession.headroomMb, shown in cleo doctor tool-locks"
---

The spawned agent-session budget was clamp(1, (MemAvailable - 2048 MiB) /
4096 MiB, cpus - 2) with no setting, so the only way past it was
`CLEO_RESOURCES_MODE=off`, which drops every other governor protection.
When other processes hold most of the RAM (axiom codex sessions at about
30 GB on 2026-11-05), it fell to 1-2 machine-wide.

Three config keys, at project or global scope and validated by
config.schema.json, now feed it:

- `resources.agentSession.maxSessions`: a fixed budget that replaces the
  memory and CPU formula (floor and ceiling);
- `resources.agentSession.estRamMb`: RAM one session is assumed to use
  (default 4096);
- `resources.agentSession.headroomMb`: RAM kept free (default 2048).
  `resources.headroomMb` keeps its one meaning, the monitor's degraded-mode
  headroom.

`cleo doctor tool-locks` reports the budget, each input with whether config
set it, and the live leases. The at-capacity refusal names the three keys
and their current values. Unset keys keep today's budget.
