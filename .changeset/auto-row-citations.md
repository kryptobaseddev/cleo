---
id: auto-row-citations
tasks: [T13975, T13976, T13977]
kind: fix
summary: "Typed promotion and the sentient brain ingester ignore auto rows' inflated citation counts"
---

Auto rows, meaning backfilled doc-attachment records and task stubs, kept the
citation counts that past reads gave them before T13947 stopped read-time
bumps.

- **Typed promotion.** `promoteObservationsToTyped` now leaves auto rows out
  of its candidates, so a highly cited auto row is never logged for promotion
  to a typed table.
- **Sentient brain ingester.** It now leaves auto rows out too, so they never
  become `[T2-BRAIN]` recurring-issue proposals.
- **Extraction gate.** It already merged a re-observed auto row without citing
  it. A test now pins that behaviour.
