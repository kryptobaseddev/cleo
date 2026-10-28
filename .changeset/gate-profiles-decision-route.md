---
id: gate-profiles-decision-route
tasks: [T13474, T12220]
kind: fix
summary: "Tasks with no code change declare a gate profile (profile:ops|decision|census|audit), and the testsPassed/qaPassed refusal names the decision-only route"
---

Tasks that change no code (a decision, an ops change, a census, an audit, a
data repair) had no honest way to close, and were the largest open cause of
owner overrides (T14041). A `work` task can now carry one gate profile label
from a closed set: `profile:ops`, `profile:decision`, `profile:census` or
`profile:audit`. It then owes the non-code gates a research task owes
(`implemented`, proven by `decision:` with a `note:` or an artifact), and
`testsPassed`/`qaPassed` are not applicable.

Guards:
- An unknown `profile:*` label, or a second profile, is refused.
- A profile never applies over code evidence. Adding one to a task whose
  `implemented` carries `commit:`, `pr:` or a code `files:` path is refused,
  and verify, `cleo done --plan` and complete raise such a task to the code
  gates with the reason.
- Every profile change, at creation or by update, is written to the task
  audit log (`gate_profile_changed`).
- `cleo show` reads the waived gates as `not applicable (profile:<name>)` in
  `view.gateNotes`, never as passed. `cleo done --plan` names the profile and
  the gates it waives.

The `testsPassed`/`qaPassed` evidence refusal now also names the
decision-only route (record `implemented` as `decision:<id>;note:<why>`, then
verify each relaxed gate explicitly), the `commit:` or `pr:` atom that
disqualifies it when `implemented` carries one, that re-verifying a gate
replaces its atoms, and the gate profiles. `DECISION_ONLY_INAPPLICABLE_GATES`
is renamed `DECISION_ONLY_RELAXED_GATES`, and its comments say the gates are
relaxed, not satisfied by absence (T12220).
