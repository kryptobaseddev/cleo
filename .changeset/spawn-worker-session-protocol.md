---
id: spawn-worker-session-protocol
tasks: [T14457]
kind: fix
summary: "Spawn bootstrap: preserve allocated worker identity and disclose protocol authority before keyword fallback"
---

Spawn prompts and execution bindings carry the allocated worker session and agent
identity separately from the coordinator session. Workers preserve the existing
claim, including on resume, and return expired or foreign bindings for handoff.

Explicit protocol overrides precede task-level stage assignments proven by the
committed task audit and declared work intent. Inherited or unknown research stages
cannot downgrade work or bug assignments. Creation and explicit updates record
stage provenance without inferring authority from a parent or legacy stage value.
Protocol metadata and prompts disclose the selected authority and any
disagreement, preserving intentional research assignments without treating title
keywords or persona classification as owner decisions.

The shell role comes from the dispatch-bound worker identity, separately from the
classifier's coordination role. Shared subagent startup guidance preserves the
preallocated session and claim.
