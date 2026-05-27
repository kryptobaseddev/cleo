---
id: t10503-evidence-ac-bindings
tasks: [T10503]
kind: feat
summary: "schema: evidence_ac_bindings join table (T10381 Wave 2a)"
---

Adds `evidence_ac_bindings` Drizzle schema + migration — an M:N join
between evidence atoms and acceptance criteria that lets the validator
resolve "which ACs does this evidence atom satisfy?" and the inverse
without re-parsing evidence strings at query time.

Powers ADR-079-r2 cross-task `satisfies:<task-id>#<ac-id>` evidence atoms
and (forward-compat) the T10509 H-gate coverage marker. Three binding
kinds: `direct` (Worker-emitted), `satisfies` (cross-task ADR-079-r2),
`coverage` (computed).

FK to `task_acceptance_criteria(id)` (CASCADE) — the target table ships
in T10502 (Wave 2a sibling). Migration timestamp `20260524000003` lands
AFTER T10502's `…02` so the FK target is in place at apply time. The
Drizzle schema intentionally omits `.references()` (target symbol lives
in the parallel branch); the FK is hand-encoded in the migration SQL.

Saga: T10377 (SG-IVTR-AC-BINDING). Epic: T10381.
