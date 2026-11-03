---
id: first-add-onboarding
tasks: [T14186]
kind: fix
summary: "the first cleo add on an empty project names cleo saga create in its message, and cleo init's next steps start with the root saga"
---

On a fresh project the first `cleo add` is refused because only a saga may
be a root (T11811), and the message said "create the root saga first"
without naming the command (it was only in the fix field). The message now
carries `cleo saga create --title ... --acceptance ...` and the epic step
under it.

`cleo init`'s next steps name the root saga as the first step on a project
with no tasks, the seed epic step files under that saga (the old bare
`cleo add ... --type epic` was itself refused), and the session step carries
the required `--name`.
