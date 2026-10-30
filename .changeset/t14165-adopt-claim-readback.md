---
id: t14165-adopt-claim-readback
tasks: [T14165]
kind: fix
summary: "worktree list, cleo show and session show now read back what worktree adopt, cleo claim and cleo start wrote"
---

`cleo worktree adopt <path> --task-id T#### --source manual`, `cleo claim` and
`cleo start` all persisted their writes, but three read surfaces looked
elsewhere:

- `cleo worktree list` took a git worktree's `taskId` from its branch name
  only, ignoring the task adopt recorded in `.cleo/worktrees.json`, and its
  branch rule (`task/T####` exactly) disagreed with adopt's. It now prefers the
  recorded task, and list and adopt share one rule: `task/T####` or
  `feat/T####`, optionally followed by `-<slug>`. `owningAgent` was read from a
  `.git/worktree.json` that a linked worktree cannot have; it now shows the
  adopter recorded in the index, and stays null for a worktree adopt never
  recorded.
- `cleo show` never included the claim lease. The task record now carries
  `claim` when the task is leased.
- `cleo session show` / `session status` reported the session row's
  `taskWork`, which was set at session start and never updated, while
  `cleo current` reads the live focus. `cleo start` and `cleo stop` now record
  the change on the session row too, so `memory observe` and handoffs see the
  started task as well.
