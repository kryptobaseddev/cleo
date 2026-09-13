---
id: envelope-project-root
tasks: [T12150]
kind: fix
summary: every envelope discloses which project store answered it (gh#1234)
---

Task ids are project-scoped but look global: `T100` carries no qualifier, and
the store is selected by cwd. So the same command with the same id answers from
a different store depending on where it ran — and nothing in the response said
which.

Measured across one workspace with 38 CLEO stores: `cleo show T100` returned
"Task 100" from one project and "Phone management in the customer account p…"
from another, with byte-identical `meta` key sets. A reader could not
distinguish a correct answer from an answer about a different project, and the
reporter had a verification gate written to the wrong project as a result.

Per-project stores are correct (ADR-068). The defect was the absence of
disclosure, so `meta.projectRoot` now names the resolved root on **every**
envelope. It is stamped in `createCliMeta` — the one place every CLI envelope's
meta is built — rather than at call sites, because a field present wherever
someone remembered it is the same defect one level up.

A path rather than a project id: the reader's question is "which store answered
this?", and a path answers it with no further lookup, whereas an id would need
resolving to mean anything — the same indirection that made the ambiguity
invisible.

The home prefix is collapsed to `~`. Envelopes are pasted into public issue
trackers constantly, and a raw absolute path would put the user's account name
in every one of them permanently, as a side effect of a disclosure field.
`~/projects/foo` still answers the question for the reader who ran the command.
