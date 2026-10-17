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

A stale edit (one authored against a superseded version) is now merged
three ways, section by section, against the version it was authored from
and the landed head. A section another writer inserted is kept in place
instead of being dropped. An append onto a concurrently renamed
section lands on the renamed section, and any other edit to a renamed or
deleted section is recorded as a section conflict. A section the stale edit
deleted is kept as a conflict if another writer changed it. When writers
disagree on how many sections share a heading, the `~N` ids no longer name
the same sections, so the head's sections are kept and the stale change is
recorded as a conflict on that heading. Single-writer edits behave
exactly as before.

Existing docs migrate without rewriting history. A section with no local state
under its new id starts from the head version's text, which is what the legacy
positional row held. Ids already recorded in version rows and approvals keep
the positional form they were written with, so a reader must interpret them
against the version they were recorded on.
