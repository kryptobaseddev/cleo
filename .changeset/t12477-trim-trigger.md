---
id: t12477-trim-trigger
tasks: [T12477]
kind: fix
summary: shorten the doctor projects trigger note so the tier-1 spawn prompt stays under the AUTO-005 budget
---

The trigger row added in #1613 grew CLEO-INJECTION.md, which tier-1 spawn
prompts embed. On macOS, where worktree paths contain "Application Support",
the AUTO-005 spawn-prompt budget test then measured 43006 characters against
its 43000 cap. The note is shortened; the flags stay documented in ct-cleo.
