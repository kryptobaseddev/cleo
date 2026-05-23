---
id: t9852-gh-409-acceptance-tokenizer
tasks: [T9852, T9839]
kind: fix
summary: "Bracket+quote-aware acceptance tokenizer + DRY collapse of 3 duplicate split impls"
prs: [412]
---

Closes #409. Replaces naive String.split('|') in parseAcceptanceCriteria with a tokenizer that tracks balanced brackets ((), [], {}) and single/double quotes, so | inside ENUM (hot|cold|batch|embed) or 'realtime-token'|'batch' is preserved as a literal character. Adds \| escape syntax at depth 0. Collapses 3 inline split sites in update.ts + saga.ts onto the canonical core helper — SOLID+DRY consolidation per AGENTS.md.
