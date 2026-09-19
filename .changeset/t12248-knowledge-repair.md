---
id: t12248-knowledge-repair
tasks: [T12248]
kind: feat
summary: Assess and repair knowledge with bounded deterministic proposals and reversible receipts
---

The new doctor knowledge surface reports independent coverage, structure, semantics, and extraction health. Findings identify evidence, repair class, supported action, verification, and recovery. Dry-run previews exact affected records; fix applies only supported deterministic repairs within its budget.

Sourced calling-agent proposals are checked against project identity, expected state, and current evidence. Repair receipts preserve previous state, reject stale proposals, deduplicate concurrent callers, and support guarded rollback. No background model is required. Existing doctor repair database-recovery semantics remain unchanged.

CLI child flags are validated before command execution. A valid doctor knowledge task flag produces one envelope; an unknown flag cannot mutate data before its error response.

Code placed in packages/core/ per Package-Boundary Check — verified against AGENTS.md. The CLI remains thin dispatch and argument validation, with shared repair contracts in packages/contracts/.
