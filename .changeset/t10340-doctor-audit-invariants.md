---
id: t10340-doctor-audit-invariants
tasks: [T10340]
kind: feat
summary: "cleo doctor --audit-invariants walks central INVARIANTS_REGISTRY (Saga T10326 R6)"
---

Adds `cleo doctor --audit-invariants` which walks the central
`INVARIANTS_REGISTRY` (`@cleocode/contracts`) and produces a per-entry
audit report grouped by ADR + severity with actionable repair commands.
`--audit-sagas` becomes a focused alias that filters the registry walk to
ADR-073 only — both surfaces delegate to one `auditInvariantRegistry`
SSoT in `@cleocode/core/doctor/invariant-audit.ts`.

Supports `--json` for machine consumption; exits non-zero when any
`severity:'error'` violation is observed. ADR-073 saga gates (I5/I7)
delegate to the production-hardened `auditSagaHierarchy` (T10119). Spawn-
/session-/release-tag-bound runtime gates (most of ADR-070 ORC codes,
ADR-056 D4/D5) surface as `'not-applicable'` with the gate location so
the gap analysis is visible end-to-end. Entries with `runtimeGate:null`
report `'documented'` so registry-only invariants are counted.

Saga: T10326 SG-SUBSTRATE-RECONCILIATION / Epic T10327
E-INVARIANT-REGISTRY-SSOT / R6.
