---
id: t10494-history-model-spike
tasks: [T10494]
kind: docs
summary: decision spike — AC history model picks dedicated _history table over docs_provenance extension (closes council §3.1 action #18)
---

Resolves SG-IVTR-AC-BINDING council §3.1 action item #18: should AC text drift across time live inside an extension of the existing docs-provenance mechanism on `attachments`, or inside a dedicated `task_acceptance_criteria_history` table, or a hybrid? This spike picks **option (b) — the dedicated `_history` table as drafted in ADR-A (T10271 §D4/§D6)**.

**Decision rationale**: ACs are machine-managed positional clauses with content-derived hashes, not human-authored canonical docs with author-decided supersession. Routing them through `attachments` would pollute `cleo docs list` / `cleo docs find --similar` with potentially 4,800+ AC snapshot rows, force a DocKind taxonomy expansion that contradicts SG-DOCS-INTEGRITY's just-shipped uniqueness invariants, contend with `cleo docs attachments gc` semantics, and add ≥2 PRs to the T10381 8-PR migration plan. The dedicated 5-column `_history` table fits inside one of the already-planned 8 PRs.

**Migration impact**: zero rewrite needed — the T10381 sequence already contains the `_history` table. Retention policy (currently unbounded, matching `task_work_history` + `audit_log`) is a Wave 2 follow-up.

Research doc filed via `cleo docs add --type research --slug ac-history-model-decision` (T10494 attachment `0d2e80cf-eac5-4c9c-9284-e6cd7721606c`). The full 14.8 KB analysis — per-option matrix, council quote, sources — lives in the docs SSoT and is fetchable via `cleo docs fetch ac-history-model-decision`.

Unblocks T10381 (E-AC-MIGRATION Drizzle 8-PR sequence).
