---
id: recall-ranking-followups
tasks: [T13978]
kind: fix
summary: "`memory find --tables` fills its limit when vector or graph hits from other tables rank higher; hybrid search reuses one eligibility statement per table"
---

Follow-ups from the #2390 recall-ranking review:

- **Table filter.** `hybridSearch`'s `tables` filter now applies to every
  memory source (full-text, vector and graph) before fusion and the limit.
  Before, only the full-text source was filtered, so with `--tables` the fused
  list could fill with vector or graph hits from other tables. The filter then
  dropped them and `cleo memory find --tables …` returned fewer hits than
  `--limit`, or none. Code-symbol hits are not memory rows and are unaffected.
- **Eligibility statements.** The eligibility check prepares one statement per
  table and peer scope for each search, not one per hit.
- **Graph neighbours.** `search-hybrid` and `memory find` return only memory
  rows (decisions, patterns, learnings, observations) from graph expansion.
  Task, concept and doc nodes seed the expansion but are never results. This
  is deliberate (T13948): recall is over memory rows.
