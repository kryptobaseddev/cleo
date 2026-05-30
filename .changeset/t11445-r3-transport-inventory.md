---
id: t11445-r3-transport-inventory
tasks: [T11445, T11254]
kind: test
summary: Add R3 transport-inventory golden regression net (CLI/MCP/SSE current-state baseline) + topology spec
---

R3-T1 for SG-RUNTIME-UNIFICATION. Pins the current transport surface so the R3-T3 dispatcher relocation + R3-T4..T6 adapters prove no-behavior-change: CLI baseline (>=5 ops conform to the frozen gateway contract), MCP 3-tool ALL_TOOLS surface, 2 Studio SSE streams event-ordering, and topology invariants (no packages/gateway; adapters is the provider pkg). Spec doc slug r3-transport-inventory. Verified 17/17 assertions against current code.
