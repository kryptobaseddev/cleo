---
id: docs-lineage
tasks: [T14110]
kind: feat
summary: "docs fetch shows a doc's lineage, and briefing and memory find surface current docs, never superseded ones; wire contract change: BrainCompactHit gains optional docs and SearchBrainCompactResult gains optional taskDocs"
---

Docs are now tied to the tasks and decisions they serve, with supersession,
using only what the store already records: `supersedes`/`superseded_by`,
task refs, `related_tasks` and `decision_adr_links`.

- **`cleo docs fetch`** returns `lineage`: the lifecycle status, the doc it
  replaced, the doc that replaced it, `currentSlug` (the end of the chain, the
  doc to read), `servesTasks`, and `supersedesDecisions`. A doc supersedes a
  decision by linking the decision that replaced it (`docs link-decision`),
  which records `supersedes` in BRAIN.
- **The session briefing** names a superseded doc's current replacement
  (marked `replaces`), once.
- **`cleo memory find`** attaches each decision hit's linked docs, and
  `taskDocs` for every task the query or a decision hit names. Both resolve to
  current docs.
