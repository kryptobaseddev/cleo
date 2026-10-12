---
id: t13355-crdt-writepath
tasks: [T13355]
kind: feature
summary: Wire the llmtxt Loro CRDT merge into the docs update write path — section merge engine, head projection under docs.head.max-hlc, append-only DAG versions
---

`cleo docs update` carrying inline text now projects through the section
CRDT merge layer (spec `cleodocs-rearch-design` §2 option b): the doc splits
deterministically into sections, each section's edit applies to its
local-only Loro state in `section_crdt_states` via sequential
`crdt_apply_update` composition — the WASM `crdt_merge_updates` is lossy in
llmtxt@2026.5.15 (kryptobaseddev/llmtxt#17, T13356) and stays unused — and
the merged text projects into one syncing current-version row per doc under
the typed `docs.head.max-hlc` rule: the max-HLC head wins, a losing
concurrent head is recorded as a conflict (never silently shadowed), and
every write appends an append-only DAG version row keyed by the Stage C row
uid. A legacy doc is adopted into the conduit family on first sight; the
existing whole-row write remains the fallback and the first-write path.

Concurrency acceptance is test-proven on the real WASM: two concurrent
section edits from one base both survive the merge, the merge result is
order-independent, and non-edited sections stay byte-identical.
