---
id: t14613-owner-playbook-gates
tasks: [T14613]
kind: fix
summary: "Playbook HITL gates: require human owner authority and private installation tokens"
---

Approve and reject share the owner override authority rule and require an explicit direct CLI source; HTTP, MCP, RPC and unknown callers cannot borrow a server's owner session or terminal. Pending and playbook run/resume redact tokens for other callers. New v2 tokens derive from the private installation machine key unless a secret is configured, and key access waits until an approval node is reached. Each approved gate is consumed atomically by one resume before any post-gate execution, so concurrent calls, historical traces and crash retries cannot replay it. Legacy gates refuse approval and resume, including previously approved gates; the owner can reject pending legacy gates and resume traces for cleanup or request a fresh run after reviewing earlier side effects. New traces are already resolved and never authorize execution.
