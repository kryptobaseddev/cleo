---
id: spawn-worker-session-protocol
tasks: [T14457]
kind: fix
summary: "Spawn bootstrap: preserve allocated worker identity and disclose protocol authority before keyword fallback"
---

Spawn prompts and execution bindings carry the allocated worker session and agent
identity separately from the coordinator session. Workers preserve the existing
claim, including on resume, and return expired or foreign bindings for handoff.

Explicit protocol overrides precede the task pipeline stage and declared work
intent. Protocol metadata and prompts disclose the selected authority and any
disagreement, preserving intentional research assignments without treating title
keywords or persona classification as owner decisions.
