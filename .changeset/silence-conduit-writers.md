---
id: silence-conduit-writers
tasks: [T13953]
kind: fix
summary: "CLEO stops writing conduit messages: no lifecycle hooks, no spawn or handoff events, and agent events default to the file transport"
---
Agent-to-agent messages moved to AgentMBX (D11172, mirroring agentmbx D008-D010
as D11176-D11178), but CLEO still wrote conduit messages nobody read: the
SubagentStart, SubagentStop and SessionEnd hooks, an `agent.spawned` event on
every executed spawn and an `orchestrate.handoff` event on every handoff.

- The conduit lifecycle hooks are no longer registered (their handlers stay
  exported until the conduit verbs and tables go).
- Spawn execution and handoff no longer call `sendConduitEvent`.
- `cleo event append` and `appendEvent` default to the file transport
  (`.cleo/agent-events/<agent>.jsonl`), which is what `cleo event watch`
  reads; `CLEO_EVENTS_TRANSPORT=conduit` keeps the old path while it retires.

The conduit tables, verbs and public API are unchanged (epic T13933).
