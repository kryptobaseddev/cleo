---
id: orca-worker-settlement
tasks: [T14458]
kind: feat
summary: "Orca workers: separate physical exit and deduplicated lead report delivery"
---

Orca worker observations now settle physical exit through verified provider
handles, emitting one lifecycle stop without accepting the CLEO task or releasing
its claim or checkout. Reports remain ingestible after exit; explicit retry
retirement preserves the execution mapping and original exit receipt separately.

Canonical report ingestion atomically reserves an AgentMBX outbox entry. The
recorded lead mailbox receives one original report using a stable
runtime/Run/Dispatch/source-message key, including across a lost acknowledgement
or CLI restart. Pending delivery remains explicit and can be retried with
`cleo orchestrate worker relay-report`. Orca worker prompts route their report
artifact through this bridge instead of sending a second mailbox report.
