---
id: t14613-owner-playbook-gates
tasks: [T14613]
kind: fix
summary: "Playbook HITL gates: require human owner authority and private installation tokens"
---

Approve and reject share the owner override authority rule; pending redacts tokens for other callers. New v2 tokens derive from the private installation machine key unless a secret is configured. Legacy gates refuse new decisions with an explicit fresh-run recovery instruction, preserving their rows.
