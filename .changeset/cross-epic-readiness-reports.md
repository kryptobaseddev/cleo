---
id: cross-epic-readiness-reports
tasks: [T12293]
kind: fix
summary: "Cross-epic readiness reports: retain archived evidence and cancelled or missing blockers"
---

Dependency reports use the shared execution-readiness policy without expanding
selected task counts. Known open dependencies remain blockers; only absent
identities are reported missing. Blocked and proposed tasks stay out of ready lists.
Saga traversal preserves failed readiness reads, and `saga next` emits an error
envelope and unsuccessful exit instead of wrapping a failure in success output.
