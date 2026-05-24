---
id: t9824-uppercase-task-id-labels
tasks: [T9824]
kind: fix
summary: "validateLabels: accept canonical uppercase task-ID labels (T9813) per ADR-073"
---

`cleo add --labels T9813` and `cleo add-batch` with `labels: ['T9813']`
previously failed with `E_VALIDATION: Invalid label format: must be
lowercase alphanumeric with hyphens/periods`. Agents canonically tag
tasks with the parent task ID in canonical uppercase form per
ADR-073, so the validator now accepts labels matching `/^T\d{3,}$/`
alongside the existing lowercase-alnum rule. Case is preserved at
storage (Option A — no auto-lowercasing) so the stored label keeps
its ADR-073 canonical form.

Existing lowercase labels (`bug`, `v0.5.0`, `security`) are
unaffected. Malformed task-ID-like strings (`T12`, `T9813x`,
`XT9813`) are still rejected.
