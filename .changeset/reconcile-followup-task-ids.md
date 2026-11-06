---
id: reconcile-followup-task-ids
tasks: [T14271]
kind: fix
summary: "release reconcile follow-ups are real T#### tasks the CLI can read, labelled reconcile-followup:<tag>"
---

The archive-reason invariant minted follow-up tasks as
`T-RECONCILE-FOLLOWUP-<tag>-<idx>`, an id `cleo show` rejects, so CLEO filed
tasks it could not read. A follow-up now takes the next allocated `T####`,
carries the label `reconcile-followup:<tag>` and a relates edge to the
unreconciled task. A re-run of the same tag finds that follow-up by its label
and edge instead of filing a second one.

Existing `T-RECONCILE-FOLLOWUP-*` rows are re-keyed in a follow-up change.
