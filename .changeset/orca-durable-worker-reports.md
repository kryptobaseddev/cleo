---
id: orca-durable-worker-reports
tasks: [T14458]
kind: feat
summary: "Orca reports: ingest one validated current-dispatch report durably"
---

Adds `cleo orchestrate worker ingest-report <recordId> --message-id <messageId>`.
The read-only Orca adapter checks runtime, Run, current Task/Dispatch and sender;
core validates the original report file with `checkWorkerReport`, links its exact
manifest and retains its bytes and digest on the existing local worker record.
Concurrent deliveries and restarts preserve the first logical report. Missing or
invalid proof, failed outcome, stale provenance and conflicting reports refuse.
Task acceptance, review, integration and resource release remain separate; this
slice does not implement AgentMBX relay or provider-handle resource reconciliation.
