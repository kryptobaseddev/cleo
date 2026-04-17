# CleoOS Seed Agents

Canonical seed-agent definitions have moved. The SSoT for all CLEO `.cant`
agents is now `packages/agents/seed-agents/`.

`AgentRegistry.loadSeedAgents()` reads from that canonical path. Do not
re-add `.cant` files under this directory — keep everything in
`packages/agents/seed-agents/` to prevent drift.

See `packages/agents/README.md` for authoring guidelines and the
`AgentDefinition` contract in
`packages/cleo-os/src/registry/agent-registry.ts`.
