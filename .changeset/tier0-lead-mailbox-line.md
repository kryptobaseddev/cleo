---
id: tier0-lead-mailbox-line
tasks: [T14429]
kind: fix
summary: "With orchestrate.leadWorker.v1 on and a lead mailbox known, tier-0 worker prompts now carry one line naming the lead mailbox and how to report"
---

Only tier 1/2 spawn prompts had the `## Agent Coordination (AgentMBX)` section, so a
worker whose task auto-resolved to tier 0 had no address to report to under the
lead/worker split. The composer now reads `orchestrate.leadWorker.v1` for tier-0
spawns that have a lead mailbox and the prompt adds a single line: `mbx_send` to the
lead (or `agentmbx send` without the MCP server) with a report of at most 100 words
(conclusion, blocker, proof). With the flag off, tier-0 prompts are unchanged.
