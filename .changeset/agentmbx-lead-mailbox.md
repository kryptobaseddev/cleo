---
id: agentmbx-lead-mailbox
tasks: [T14379]
kind: feat
summary: "With orchestrate.leadWorker.v1 on, cleo init records a project-qualified lead AgentMBX mailbox in project config, and spawn and fanout name it in worker prompts when --lead-mbx is not given"
---

A core AgentMBX adapter (`orchestrate/agentmbx.ts`) is now the one path to the
`agentmbx` CLI: send (with the caller's idempotency key, so a retried send is
delivered once; no key is sent when none is given), inbox, identity claim and
status, plus `claimLeadMailbox` for the lead to take its mailbox. It shells out
with argv only, never spawns `agentmbx mcp`, and fails closed with a warning
when `agentmbx` is absent. With `orchestrate.leadWorker.v1` on, `cleo init`
records `orchestrate.leadMailbox` (`{name, projectId, cli}`, the new contracts
`LeadMailbox` type, also in `config.schema.json`) as `<project>-<id-hash>-lead`
when `agentmbx` is installed; without it, init warns and writes nothing. The
spawn composer falls back to that mailbox, so both `cleo orchestrate spawn` and
fanout fill the worker's lead mailbox. With the flag off nothing changes.
