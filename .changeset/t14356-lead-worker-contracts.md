---
id: t14356-lead-worker-contracts
tasks: [T14356]
kind: feat
summary: "Contracts for the lead/worker split: LeadToolPolicy, WorkerReport, E_LEAD_TOOLS_UNSTRIPPED, E_WORKER_REPORT_PROOF and the config key orchestrate.leadWorker.v1 (default false)"
---

`@cleocode/contracts` exports the types the lead/worker split (epic T14351)
builds on: `LeadToolPolicy` with `LEAD_DENIED_TOOLS` (Bash, Edit, Write,
MultiEdit, NotebookEdit, WebFetch, WebSearch) and the provider capability
`stripSupport: 'enforced' | 'unsupported'`, `WorkerReport` and `WorkerProof`,
and the error codes `E_LEAD_TOOLS_UNSTRIPPED` and `E_WORKER_REPORT_PROOF`. The
config key `orchestrate.leadWorker.v1` exists and defaults to `false`. No
behaviour changes yet.
