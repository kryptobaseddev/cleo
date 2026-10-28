---
id: stage-forward-bulk-move
tasks: [T12883]
kind: fix
summary: "tasks.bulk-move refuses a pipeline_stage that would move a task backwards (T12883 R3)"
---

`tasks.bulk-move` wrote any `pipelineStage` it was given, so a task could move
backwards through the pipeline (testing back to implementation), which
`cleo update` refuses. It now applies the same forward-only rule
(`validatePipelineTransition`) to every task before moving any of them.
Restoring a cancelled task still resets its stage by design, and imports keep
recorded stages as-is.
