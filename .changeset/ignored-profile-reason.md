---
id: ignored-profile-reason
tasks: [T14193]
kind: fix
summary: "a gate profile the task's record overrides is named, with the deciding rule, the exact file or token and the fix"
---

A `profile:<name>` label applies only when the task's record leaves it
non-code. A task that declares a non-document file, names a code path in an
acceptance criterion, or is kind bug stays code, so the profile is ignored,
and nothing said so (VidaPeps T2383).

`ignoredProfileReason` (core verification-policy) names the deciding rule
and the exact file, criterion and token, or the kind, with the fix: drop the
non-document entry from the task's files, reword the criterion, or set the
kind. It is never a waiver. The reason appears where the gates are decided:
`cleo done --plan` ("<id> owes the code gates: profile:… does not apply: …"),
`cleo complete`, the `implemented` refusal of a decision ("A research
decision alone cannot implement a code-fix task: profile:… does not
apply: …"), and `cleo verify`'s evidence-minimum refusal.
