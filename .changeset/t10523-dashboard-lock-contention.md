---
id: t10523-dashboard-lock-contention
tasks: [T10523]
kind: feat
summary: Surface DB/evidence lock contention and stale-lock cleanup guidance in the orchestration dashboard
---

`cleo orchestrate dashboard` now includes a `lockContention` section with DB/evidence lock-marker counts, stale marker detection, locked/stale worktree counts, and operator cleanup guidance for stale DB/evidence locks and wedged worktrees.
