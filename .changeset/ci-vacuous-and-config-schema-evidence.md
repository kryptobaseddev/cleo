---
id: ci-vacuous-and-config-schema-evidence
tasks: [T13757, T13758]
kind: fix
summary: "ci:<pr> is refused when no check is required; tool:config-schema tests a change to CLEO config alone"
---

A `ci:<pr>` atom in a project whose resolved required-workflow set is empty
(`release.prRequiredWorkflows: []`, or `CLEO_PR_REQUIRED_WORKFLOWS='[]'`) would
vouch for zero checks. It is now refused with `E_EVIDENCE_CI_VACUOUS`, whatever
`evidence.ciSatisfies` says, and the refusal names the targeted alternatives.

A change touching only CLEO-owned config (`.cleo/project-context.json`,
`.cleo/config.json`) in a repo without CI had no route except whole-suite runs.
CLEO is the consumer of these files, so `tool:config-schema` now has CLEO
validate each changed file against its CLEO schema. It satisfies testsPassed and
qaPassed, is pinned to the tree like a qa-run receipt (a moved tree voids it
for both gates), and any other changed path refuses it. `cleo done --plan`
offers it for such a change.
