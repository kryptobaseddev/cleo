---
id: done-plan-already-done-reason
tasks: [T14095]
kind: fix
summary: "cleo done --plan names why a plan is not ready: an already-done task says so instead of ready:false with no blocker"
---

`cleo done <id> --plan` on a task whose status is already `done` returned
`ready: false` with every gate passed, no blockers and nothing saying why.
The plan now carries a `readyReason` whenever it is not ready and no blocker
explains it: `<id> is already done: there is nothing left to record or
complete.` for a done task, and a no-command-to-run reason naming the
`implemented` fix for any other plan with neither a blocker nor a command.
A plan with `ready: false` always carries a blocker or a `readyReason`.
