---
id: t12522-coverage-token-delta
tasks: [T12522]
kind: test
summary: "Assert the measured token reduction of emitting knowledge coverage once in briefing and focus"
---
Token economy (epic T12484). The dedup itself landed with #1711:
`knowledgeHealth` in `cleo briefing` and `cleo focus` carries `coverageRef`
instead of a second copy of the coverage object. A new unit test measures the
knowledge block with the CLI budget estimator (about 4 characters per token):
435 tokens before, 276 after, 159 saved, the size of the removed copy. It also
checks that no field with meaning was dropped: diagnostic statuses (including
`unavailable`), `findingCount`, `findingStates`, `reasonCount`,
`evidenceCount`, both revisions and `detailsCommand`.
