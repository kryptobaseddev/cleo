---
id: t13257-orchestration-home-skip
tasks: [T13257]
kind: fix
summary: caamp's advanced instruction update reports a $HOME project as skipped, the same way cleo init does, instead of throwing
---

`updateInstructionsSingleOperation`, used by `caamp advanced instructions`, threw
`HomeInstructionFileError` for a project-scope update in the home directory. It now
writes nothing and returns `updatedFiles: 0` with a `skipped` reason, which the command
includes in its output. This matches how `cleo init` and `cleo upgrade` report the same
case.
