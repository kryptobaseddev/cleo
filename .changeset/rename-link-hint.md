---
id: rename-link-hint
tasks: [T12716]
kind: fix
summary: "`cleo project rename` on a Nexus-linked project now hints `cleo project link`, a command that exists (it named a `--name` flag `link` does not have)"
---

When `.cleo/nexus-link.json` binds the project, `cleo project rename`
reports `nexusLabel: relink-required` with the command that pushes the new
label. That command said `cleo project link --name "<name>"`, but
`cleo project link` takes `--label`, and without it uses the project's display
name, which is the name the rename just wrote. The hint is now plain
`cleo project link`, and a test checks that every flag in the hint is one the
link command declares.
