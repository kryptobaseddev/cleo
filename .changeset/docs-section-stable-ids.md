---
id: docs-section-stable-ids
tasks: [T13584]
kind: fix
summary: docs CRDT section ids are anchored to headings, so inserting a section no longer shifts later ids
---

Section ids were positional (`s0`, `s1`, …). Inserting or removing a section
shifted every later id, so the write path paired each section with its
neighbour's stored state and reference text. That re-seeded unchanged sections,
reported spurious conflicts, could drop a concurrent edit, and left per-section
approvals pointing at whatever section moved into the old position.

The preamble keeps `s0`. Each `## ` section is now `h-<heading slug>`, and a
repeated heading gets `~2`, `~3` and so on. Every device derives the same id
from the text alone. Renaming a heading gives the section a new identity.

Existing docs migrate without rewriting history. A section with no local state
under its new id starts from the head version's text, which is what the legacy
positional row held. Ids already recorded in version rows and approvals stay
as written, and `resolveSectionId` maps a legacy `sN` against the version it
was recorded on.
