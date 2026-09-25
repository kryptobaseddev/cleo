---
id: release-plan-gate-states
tasks: [T12359]
kind: fix
summary: "`cleo release plan` judges verification gate outcomes, not atom presence, and reports per-task gate states"
---

**T12359.** `cleo release plan v2026.9.17` returned success with
`evidenceComplete: true` while every one of its 15 in-scope tasks had
`verification.gates.implemented = false`. Each task carried a `tool:` or
`test-run:` atom, and the plan checked only that *some* atom was present.
Having a test atom does not show that a task was implemented.

The plan now uses the same required-gate policy that `cleo complete` enforces
(`verification.enabled` + `verification.requiredGates`). That policy moved out of
`complete.ts` into `tasks/verification-policy.ts`, so the two commands cannot
disagree about what "verified" means. A task that is not `done` blocks the plan
with `E_EVIDENCE_INSUFFICIENT` when it has no evidence atoms, or when
verification is enforced and one of its required gates is not `true`. The error
names each blocking task and the gate values it has (`implemented=false`).

The plan envelope reports gate outcomes, not just the atoms present:
`taskGates[]` gives each task's `gates`, `missingGates`, `evidenceAtoms`,
`verdict` (`verified` | `unverified` | `grandfathered` | `not-required`) and
`reasons`. `verificationEnforced` and `requiredGates` are also reported. The
refusal's `details` carries the same per-task states.

These cases are unchanged and still report their gate states: tasks that are
already `done` are grandfathered (ADR-051 §11.1), projects with
`verification.enabled: false` enforce no gates, and container epics are exempt
from gates as they are in `cleo complete`. A leaf epic planned as its own
singleton task is gate-checked, because it is the unit being shipped.
