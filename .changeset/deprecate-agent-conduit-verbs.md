---
id: deprecate-agent-conduit-verbs
tasks: [T13986]
kind: chore
summary: "cleo agent assign, wake, reassign, poll and send are deprecated with the other conduit verbs"
---
These five `cleo agent` verbs send or read conduit messages
(`createConduit`), so they carry the same `W_DEPRECATED_COMMAND` warning as
`cleo conduit *` (T13982): they keep working with unchanged output and exit
codes and are removed or repointed with the conduit retirement (T13955,
T13983). Agents message each other over AgentMBX.
