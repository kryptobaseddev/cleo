---
id: orca-report-relay-verification
tasks: [T14502]
kind: fix
summary: "Orca report relay: serialize concurrent delivery acknowledgements"
---

Live AgentMBX 0.5.58 checks confirmed that self-addressed reports remain unread and duplicate idempotency keys return the original message id. Serialize receipt updates before reading their shared outbox to prevent stale SQLite snapshots after concurrent sends, and add a source-backed two-process regression; ingress tests now describe the paths they actually exercise.
