---
id: t13437-mcp-fanout
tasks: [T13437]
kind: feat
summary: "`cleo doctor system` MCP fan-out: per-session presence, orphaned servers, and an owner-agreed remedy for agentmbx"
---
Each `mcp-fanout` finding now reports more evidence:
- how many agent sessions run the server (`sessionsWithServer` of `sessionsTotal`, and `inEverySession`)
- RSS per process
- orphaned copies whose parent session is gone

The generic remedy says plainly that the doctor cannot see tool calls. A server present in every session is the candidate for project scope or on-demand use.

agentmbx gets the remedy its lead asked for. It never suggests killing or removing agentmbx, because its leases are tied to the processes. Instead it says to upgrade to the release that ships T487/T488 (pending), run `agentmbx doctor`, and restart idle sessions.

Measured before the change on 2026-10-10 (macbook, 25 sessions): 54 agentmbx (2.3 GiB), 36 playwright-mcp, 36 mcpvault, 36 railway, 30 mcpbridge. The after count waits on the agentmbx release and on sessions restarting after the owner disabled playwright and obsidian.
