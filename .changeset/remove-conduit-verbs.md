---
id: remove-conduit-verbs
tasks: [T13955]
kind: chore
summary: "Remove the deprecated conduit messaging verbs, the conduit dispatch domain and the conduit-backed cleo agent verbs"
---
Conduit messaging is retired: agents message each other over AgentMBX
(`mbx_*` tools, or `agentmbx send`). The verbs deprecated in T13982 and
T13986 are gone:

- `cleo conduit status|peek|start|stop|send|publish|subscribe|listen`
- `cleo orchestrate conduit-status|conduit-peek|conduit-start|conduit-stop|conduit-send`
- `cleo nexus conduit-scan` and `cleo graph living conduit-scan`
- `cleo agent start|assign|wake|reassign|watch|poll|send`

`cleo agent work` keeps its task work loop but no longer starts the conduit
message poller. The `conduit` dispatch domain, its 8 operations and
`nexus.conduit-scan` leave the operations registry and the generated gateway
SDK. The agent registry and the docs-history tables are unchanged.
