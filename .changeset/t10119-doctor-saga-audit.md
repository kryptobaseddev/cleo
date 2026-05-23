---
id: t10119-doctor-saga-audit
tasks: [T10119]
kind: feat
summary: "cleo doctor saga-depth audit (I5/I7/depth/auto-close drift)"
---

feat(T10119): cleo doctor saga-depth audit (I5/I7/depth/auto-close drift)

Extends `cleo doctor` with a Saga Hierarchy section that audits every saga for
ADR-073 §1.2 invariant violations (I5: saga parentId NOT NULL; I7: nested
sagas), depth-ladder overflow, and auto-close drift (all members done but
saga still pending — regression detector once T10116 ships).

The audit reuses the runtime guards `assertSagaInvariantI5/I7` from
`packages/core/src/sagas/enforcement.ts` (T10115) so audit + runtime share
one definition of "violation".

Surface:
- `cleo doctor --audit-sagas` — explicit, single-envelope LAFS output
- `cleo doctor` (default) — appends Saga Hierarchy section as human-only
  trailing block (silent under --json so the LAFS envelope stays clean)

Each violation names the offending IDs and a canonical repair command
(`cleo saga repair`, `cleo saga detach`, `cleo saga reconcile`).
Doctor exits with code 2 when any I5/I7/depth invariant fails;
auto-close drift is a soft warning that does NOT alone drive exit.

Saga: T10113 (SG-SAGA-FIRST-CLASS). Epic: T10209 (E-SAGA-ENFORCEMENT).
