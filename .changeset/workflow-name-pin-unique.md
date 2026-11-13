---
id: workflow-name-pin-unique
tasks: [T14540]
kind: fix
summary: "ci: evidence trusts a workflow-name pin only when one workflow carries that name; a repo 404 keeps the merge sweep waiting"
---

A `release.prRequiredWorkflows` entry pinned by workflow NAME matched any run
whose workflow had that name, and names are not unique, so a second workflow
sharing the name could satisfy the gate. `ci:` evidence now lists the
repository's workflows and judges a name pin as a pin to the one file carrying
that name; a name carried by several workflows, or by none, is refused with a
fix to pin the workflow file.

The merge sweep treated every `gh` HTTP 404 as a missing workflow file and
refused for good. It now does so only when the repository itself resolves; a
repository or permission 404 keeps waiting.
