---
id: t13477-evidence-quickwins
tasks: [T13477]
kind: fix
summary: verify --all help names the required --evidence; a failing tool reason prints the resolved command (gh#1343, gh#1445)
---

`cleo verify --help` described `--all` as "Mark all required gates as passed",
but ADR-051 rejects a bare `--all` with `E_EVIDENCE_MISSING`. The help now says
it sets every required gate at once and requires `--evidence`.

`E_EVIDENCE_TOOL_FAILED` was the only tool-failure reason that did not name
the command it ran. It now matches its siblings: `Tool "x" → <cmd> <args>
(<resolution source>) exited with code N in <root>`, so an operator can see
whether the failure came from the command they expected.
