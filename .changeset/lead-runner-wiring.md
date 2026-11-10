---
id: lead-runner-wiring
tasks: [T14374]
kind: feat
summary: "The delivered cleo-lead agent gets the cleo_run command runner and its MCP server, and denies every LEAD_DENIED_TOOLS entry"
---

`cleo init` and `cleo upgrade` now apply the lead tool policy when they write
the `cleo-lead` agent file (`applyLeadToolPolicy`). The lead denies every
`LEAD_DENIED_TOOLS` entry (Bash, Edit, Write and the rest) even when its
`.cant` file allows one, allows `LEAD_RUNNER_TOOL` (`mcp__cleo-lead__cleo_run`),
and declares the runner's MCP stdio server (`cleo orchestrate lead-runner`).
CAAMP renders per-agent MCP servers into Claude Code agent files
(`mcpServers`, new `AgentMcpServer` type). The lead prompt tells the agent to
pass argv arrays, use `cleo merge train` to merge and give `gh` numeric ids.
Worker definitions are unchanged.
