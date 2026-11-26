---
id: global-agent-dir-unified
tasks: [T14600]
kind: fix
summary: "cleo agent install --global now writes to <cleoHome>/cant/agents, the directory create, the seed and the resolver already use, so a globally installed agent is found"
---

`cleo agent install --global` wrote to `<cleoHome>/agents/` while
`cleo agent create --global`, the postinstall seed and the resolver scan used
`<cleoHome>/cant/agents/`, so file discovery never saw a globally installed
agent.

- Every global agent path now goes through `getCleoGlobalCantAgentsDir()`.
  `getCleoGlobalAgentsDir()` is a deprecated alias that returns the same
  directory.
- Agents an older CLEO installed to `<cleoHome>/agents/` are still found: the
  resolver scans that directory after the canonical one, and their registry
  rows keep resolving by id.
