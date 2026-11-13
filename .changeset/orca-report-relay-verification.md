---
id: orca-report-relay-verification
tasks: [T14502]
kind: fix
summary: "Orca report relay: serialize report reservations and delivery acknowledgements"
---

Throwaway AgentMBX 0.5.58 checks confirmed self-addressed unread mail and original-message ids on duplicate-key replay; the lead's canary relay check remains separate. Serialize report/outbox reservations and receipt updates before reading their shared metadata to prevent stale SQLite snapshots, and cover pending and missing outboxes with a source-backed two-process regression; ingress tests describe the paths they actually exercise.
