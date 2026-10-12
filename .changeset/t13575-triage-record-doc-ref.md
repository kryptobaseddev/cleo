---
id: t13575-triage-record-doc-ref
tasks: [T13575]
kind: fix
summary: "docs triage --record links each proposed decision to its doc"
---

A proposed decision recorded by `cleo docs triage --record` now carries a
structured link to the doc it judges: a `references` graph edge from the
decision to the doc's `llmtxt:<sha256>` node, written whenever `--record`
runs (it is an explicit opt-in, so the automatic-capture setting does not
gate it). Repeated `--record` runs on the same doc and verdict keep a single
proposed decision; a test now pins that.
