---
id: agentmbx-lead-mailbox
tasks: [T14379]
kind: feat
summary: "cleo init records a <project>-lead AgentMBX mailbox in project config, and spawn and fanout name it in worker prompts when --lead-mbx is not given"
---

A core AgentMBX adapter (`orchestrate/agentmbx.ts`) is now the one path to the
`agentmbx` CLI: send (with an idempotency key, derived from the message when
none is given, so a retried send is delivered once), inbox, identity claim and
status. It shells out with argv only, never spawns `agentmbx mcp`, and fails
closed with a warning when `agentmbx` is absent. `cleo init` records
`orchestrate.leadMailbox` (`{name, projectId, cli}`, the new contracts
`LeadMailbox` type) when `agentmbx` is installed; without it, init warns and
writes nothing. The spawn composer falls back to that mailbox, so both
`cleo orchestrate spawn` and fanout fill the worker's lead mailbox.
