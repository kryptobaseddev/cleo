---
id: spawn-doc-budget
tasks: [T14190]
kind: fix
summary: "a spawn prompt caps the inlined prose of a task's attached documents and names the rest by exact ref"
---

A spawn prompt inlined every text attachment of the task up to 32 KB each,
with no total, so linked history (review findings, earlier refusals,
outcomes) grew one VidaPeps prompt to 107k characters.

The `## Task Documents` section now inlines attachment prose up to a budget
(16,000 characters by default; `orchestration.spawnDocBudgetChars` in the
project config sets it). A document that would pass the budget is listed by
its exact ref (name and SHA-256) with `cleo docs fetch <ref>` instead, and
the section closes with the list of every document it left out and how to
read each one.
