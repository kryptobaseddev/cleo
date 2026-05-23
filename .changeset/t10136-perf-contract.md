---
"@cleocode/core": patch
---

test(T10136): renderEnvelopeForHuman perf contract — 100/1000/10000 rows + 100/1000 nodes (B11)

Adds packages/core/src/render/__tests__/perf.test.ts asserting render path latency budgets per ADR-077 §7. Runs on every CI build.

Closes T10136. Epic: T10114. ADR: adr-077-human-render-contract.
