---
id: t10136-perf-contract
tasks: [T10136]
kind: test
summary: "B11 renderEnvelopeForHuman perf contract — 100/1000/10000 rows + 100/1000 nodes"
prs: [559]
---

Adds `packages/core/src/render/__tests__/perf.test.ts` asserting render
path latency budgets per ADR-077 §7:

- table 100 rows  < 30ms   (measured 0.50 ms)
- table 1000 rows  < 100ms  (measured 5.41 ms)
- table 10000 rows < 500ms  (measured 10.08 ms)
- tree 100 nodes  < 50ms   (measured 0.38 ms)
- tree 1000 nodes < 200ms  (measured 0.77 ms)

All budgets pass with ≥20× headroom. Failure messages name the budget +
actual ms so regressions are easy to read.
