---
id: deprecate-conduit-verbs
tasks: [T13982]
kind: chore
summary: "cleo conduit, orchestrate conduit-*, nexus conduit-scan and graph living conduit-scan are deprecated and will be removed in the next release"
---
Conduit messaging is retiring (epic T13933): agents message each other over
AgentMBX (`mbx_*` tools, or `agentmbx send`). Per the owner's freeze-first
plan (D11174), these verbs still work with unchanged output and exit codes;
each now adds a `W_DEPRECATED_COMMAND` warning to the envelope's
`meta.warnings`:

- `cleo conduit status|peek|start|stop|send|publish|subscribe|listen`
- `cleo orchestrate conduit-status|conduit-peek|conduit-start|conduit-stop|conduit-send`
- `cleo nexus conduit-scan` and `cleo graph living conduit-scan`

They are removed in the release after this one (T13955).
