---
id: t12458-session-decisions-brain-first
tasks: [T12458]
kind: fix
summary: session decisions are recorded to and read from BRAIN first, with the audit ledger as fallback
---

`recordDecision` now writes the BRAIN `brain_decisions` row (best-effort, no LLM
validation requested) before the mandatory `.cleo/audit/decisions.jsonl` line. A
ledger record whose BRAIN write succeeded carries the id `<brainId>:dec-<hex>`,
linking the two stores.

`getDecisionLog` reads current BRAIN decisions first and supplements them from
the ledger, deduplicating by link and by content; when BRAIN is unavailable the
ledger is the sole source. BRAIN rows have no session column, so under a
`sessionId` filter a BRAIN row is returned only when a linked ledger record
proves its session. A ledger record linked to a BRAIN decision that has since
been invalidated or superseded is omitted, so the ledger cannot resurrect
retired decisions.

Code placed in packages/core/ per Package-Boundary Check — verified against AGENTS.md.
