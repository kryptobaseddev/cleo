---
id: shell-operator-tool-commands
tasks: [T14039]
kind: fix
summary: "A tool command with a shell operator is a config error (E_EVIDENCE_INVALID) naming the operator and a package script"
---

A declared command such as `typecheck.command: "pnpm --filter a build &&
pnpm --filter b lint"` runs without a shell, so CLEO refuses it, but
`tool:<name>` evidence reported that as `E_EVIDENCE_TOOL_UNAVAILABLE`, which
reads as a missing tool, and the message named only `&`. The refusal is now
`E_EVIDENCE_INVALID`, it names the operator as written (`&&`, `||`, `>>`),
and it suggests a package script alongside `sh -c` and a script file.
`tool:config-schema` also checks every tool command a changed
`.cleo/project-context.json` declares (`testing`, `build`, `lint`,
`typecheck`, `audit`, `security-scan` and `testing.affectedCommand`) and
fails on one that cannot run without a shell.
