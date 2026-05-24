---
id: t10342-render-invariants-docs
tasks: [T10342]
kind: feat
summary: "R8 — auto-render docs/registry/INVARIANTS.md from INVARIANTS_REGISTRY + CI drift gate"
---

Builds `packages/contracts/scripts/render-invariants-docs.mjs` to emit the
canonical `docs/registry/INVARIANTS.md` page from the central
`INVARIANTS_REGISTRY` SSoT at `packages/contracts/src/invariants/`. The
script:

- Reads the registry from the compiled `dist/`.
- Emits a deterministic markdown document grouped by source ADR with one
  table row per `(adr, code)` pair carrying `Code`, `Name`, `Severity`,
  `RuntimeGate`, `Tests`, and `Description` columns.
- Supports `--check` mode for drift detection and `--stdout` for previews.
- Carries an `AUTO-GENERATED — DO NOT EDIT` banner pointing back at the
  script and SSoT module.

Adds the `Invariants Docs Render Drift (T10342)` CI gate that re-renders +
diffs against the committed file on every PR. Drift fails CI with a
remediation hint.

Wires two top-level scripts: `pnpm render:invariants` (write) and
`pnpm render:invariants:check` (drift detection). Generated file checked
in initially with the 28 entries currently in `INVARIANTS_REGISTRY`
(ADR-073 I1-I8 + ADR-056 D1-D6 + ADR-070 ORC-001..ORC-014).

Saga: T10326 SG-SUBSTRATE-RECONCILIATION · Epic: T10327 E-INVARIANT-REGISTRY-SSOT · R8.
