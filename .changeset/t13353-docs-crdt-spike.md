---
id: t13353-docs-crdt-spike
tasks: [T13353]
kind: test
summary: Section-store CRDT spike proves concurrent section edits merge losslessly via sequential crdt_apply_update; pins WASM crdt_merge_updates as lossy pending upstream fix.
---

Validates the CleoDocs re-architecture merge foundation on the real 32 KB axiom perf plan: two concurrent edits to one section both survive, other sections stay byte-identical, concatenation round-trips, and merge order does not change the final text. Spike finding: `crdt_merge_updates` in llmtxt@2026.5.15 returns an empty-doc snapshot — the write path must compose sequential `crdt_apply_update` until upstream fixes it (T13356); a tripwire test fails loudly when an upgrade repairs the WASM merge.
