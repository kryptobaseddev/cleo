---
id: t12558-move-help-refusals
tasks: [T12558]
kind: docs
summary: "`cleo project move` help now states it refuses while sessions are active or worktrees exist"
---

The move help already covered cross-device and in-project targets. It now also
names the E_MOVE_BLOCKED refusals (active sessions, CLEO or git worktrees),
which the code has enforced since #1606. project-command.test asserts both.
