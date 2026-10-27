---
id: docs-only-classification
tasks: [T14048, T14065]
kind: fix
summary: "A task with no declared files is classified by what it names and changes: an all-docs PR or docs-only criteria make it documentation, any code path keeps it code"
---

`cleo verify --gate implemented` refused a documentation-only PR as
implementation of any `kind:work` task that declared no files, even when the
PR changed only `.md` files and every acceptance criterion named only
documents (T14028 via #2453, T14035 via #2458, EscapePlan T800 / PR #348).

`classifyEvidenceTask` now reads the task's acceptance criteria and the
inspected change set. Declared files, a research/spike kind, a bug, or a code
path named in an acceptance criterion decide first; a task none of these
decide is documentation when its `pr:`/`commit:` change set holds only
documents, and code when it holds any code path. Without a change set,
criteria naming documents (and no code) or a docs label make it
documentation. A docs label never hides code. `cleo done --plan` and
`cleo complete` classify through the same function, so they agree.

The `E_EVIDENCE_CONTENT_MISMATCH` refusal now names the fixes:
`cleo update <id> --files <doc paths>` or `cleo update <id> --add-labels docs`.
