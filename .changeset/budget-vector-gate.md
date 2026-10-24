---
id: budget-vector-gate
tasks: [T13968]
kind: fix
summary: Budgeted retrieval no longer returns auto rows, low-quality or invalidated rows that only the vector search found
---

`retrieveWithBudget` merged vector-search hits without the quality, current-row
and auto-row checks full-text hits pass, so embedded dispatch traces, doc
attachment rows and task stubs could reach budgeted retrieval. Vector-only hits
now pass the same gate `hybridSearch` applies (`recallEligibleDate`).
