---
id: cross-epic-readiness-reports
tasks: [T12293]
kind: fix
summary: "Cross-epic execution readiness: retain canonical prerequisite evidence and read failures"
---

Dependency reports use the shared execution-readiness policy without expanding
selected task counts. Known open dependencies remain blockers; only absent
identities are reported missing. Blocked and proposed tasks stay out of ready lists.
Saga traversal preserves failed readiness reads, and `saga next` emits an error
envelope and unsuccessful exit instead of wrapping a failure in success output.
Legacy startup and scoped sentient selection use the same canonical dependency
evidence, including archived prerequisites and required read failures.
