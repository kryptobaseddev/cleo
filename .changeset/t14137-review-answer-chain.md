---
id: t14137-review-answer-chain
tasks: [T14137]
kind: feat
summary: "cleo review check lists each answered unmet verdict with both reviewers, so one reviewer answering every finding stands out"
---

`cleo review check` now reports, per task, every `unmet` verdict on the PR
head that a later `met` answered (T14128), with the unmet verdict id and its
reviewer and the answering met verdict id and its reviewer.
