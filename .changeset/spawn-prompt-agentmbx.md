---
id: spawn-prompt-agentmbx
tasks: [T13943]
kind: fix
summary: "spawn prompts send agents to AgentMBX for coordination and to cleo docs for planning documents; the CONDUIT subscription block and .cleo/rcasd paths are gone"
---
Spawn prompts told tier-1/2 agents to subscribe to a CONDUIT wave topic with a
TypeScript snippet that could not run (`registry` was never defined), and told
research, consensus, spec and decomposition agents to write their documents
under `.cleo/rcasd/<task>/`.

- **AgentMBX for agent messages (D11172).** Tier-1/2 prompts carry an
  `## Agent Coordination (AgentMBX)` section: talk to the lead over the
  `mbx_*` tools or the `agentmbx` CLI, citing the task id; task state and
  evidence stay in CLEO. The `## CONDUIT Subscription` section, its
  `conduitSubscription` input and `deriveConduitSubscription` are removed.
  Wave numbers and `cleo orchestrate roll-up --wave <n>` are unchanged.
- **Planning documents go to `cleo docs`.** Stage guidance names `cleo docs
  add ... --type research|note|adr|spec|plan` instead of `.cleo/rcasd` paths,
  and the File Paths table drops the RCASD workspace row.
- ct-lead 1.1.0 converges on AgentMBX completion messages plus the manifest
  roll-up; ct-orchestrator 4.0.16 drafts planning documents outside
  `.cleo/rcasd/` and drops `cleo orchestrate start`.
