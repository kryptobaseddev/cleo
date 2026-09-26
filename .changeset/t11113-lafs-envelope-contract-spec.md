---
id: t11113-lafs-envelope-contract-spec
tasks: [T11113]
kind: docs
summary: publish the human-readable LAFS envelope contract spec (docs/specs/LAFS-ENVELOPE-CONTRACT.md)
---

Documents the LAFS envelope for producers and consumers: `_meta` fields,
success/result/error invariants, error categories and registry mappings,
pagination modes, `_extensions`, MVI levels, transport conventions and
examples. Covers both shape families accepted by the v1 schema — the LAFS SDK
shape (`_meta`/`result`) and the CLEO CLI shape (`meta`/`data`, ADR-039).
Linked from AGENTS.md and the canonical north-star plan; SSoT slug
`lafs-envelope-contract`.
