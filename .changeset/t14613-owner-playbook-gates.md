---
id: t14613-owner-playbook-gates
tasks: [T14613]
kind: fix
summary: "Playbook HITL gates: require human owner authority and private installation tokens"
---

Approve and reject share the owner override authority rule and require the direct CLI; HTTP, MCP and RPC clients cannot borrow a server's owner session or terminal. Pending and playbook run/resume redact tokens for other callers. New v2 tokens derive from the private installation machine key unless a secret is configured, and key access waits until an approval node is reached. Legacy gates refuse decisions and resume, including previously approved gates, with an explicit fresh-run recovery instruction that preserves their rows. Old pending resume audit traces can be rejected by the owner for cleanup; new traces are already resolved and never authorize execution.
