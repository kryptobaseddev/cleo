---
id: t10507-satisfies-validator
tasks: [T10507]
kind: feat
summary: "validator: 5-check satisfies atom semantics (T10381 Wave 2c)"
---

Implements the 5-check runtime validator for the
`satisfies:<task-id>#<ac-id>[@<version-pin>]` evidence atom per ADR-079-r2
§2.4. Replaces the `E_AC_BINDING_VALIDATOR_PENDING` placeholder T10506
inserted in `packages/core/src/tasks/evidence.ts`.

Pipeline (runs IN ORDER, first-failure-wins, NO further checks after
the first failure):

1. **malformed** → `E_AC_BINDING_MALFORMED` — defence-in-depth re-check
   of the grammar (covers callers that bypass `parseEvidenceString`).
2. **target-not-found** → `E_AC_BINDING_TARGET_NOT_FOUND` — target task
   ID does not exist in the local `tasks` table.
3. **target-terminal** → `E_AC_BINDING_TARGET_TERMINAL` — target task
   is `cancelled` or `archived`. `done` is OK (workers routinely satisfy
   ACs on already-shipped tasks per ADR-079-r2 §2.4 row 3).
4. **ac-not-found** → `E_AC_BINDING_TARGET_AC_NOT_FOUND` — the AC
   (resolved by UUID PK lookup OR `(task_id, ordinal)` alias lookup)
   does not exist on the target task.
5. **out-of-scope** → `E_AC_BINDING_OUT_OF_SCOPE` — source and target
   tasks do not share a saga (or a root epic when neither is a saga
   member). Same-saga membership resolved via the
   `task_relations.relation_type='groups'` graph until T10494 ships
   the forward-looking `tasks.saga_id` column.

Alias-drift detection (ADR-079-r2 §3, hard-error path):
`E_AC_ALIAS_DRIFTED` fires when an alias atom (`AC<n>`) resolves to a
different canonical UUID than the one previously persisted in
`evidence_ac_bindings` for the same `(source, target, alias)` triple.
The worker MUST re-state the atom using the canonical UUID form. The
soft `W_AC_ALIAS_DRIFTED` warning path is reserved for the
AC-coverage gate (T10508).

Surfaces:
- `packages/core/src/lifecycle/verification/satisfies-validator.ts` —
  new module owning the 5-check pipeline. Pure function of `(atom,
  source-task-id, projectRoot)`; no side-effect writes (the binding
  row insert is the dispatch layer's responsibility per the validator
  invariant).
- `packages/core/src/tasks/evidence.ts` — dispatch switch now delegates
  the `satisfies` case to `validateSatisfiesAtom` via dynamic import,
  mirroring the existing `validatePrAtom` pattern.
- `packages/core/src/lifecycle/verification/__tests__/satisfies-validator.test.ts` —
  25 tests covering all 5 failure paths, both happy paths (UUID + alias),
  first-failure-wins ordering, alias drift detection (positive,
  negative, UUID-form-immune), same-root-epic fallback, and
  validateAtom-dispatch integration (regression guard against the
  PENDING placeholder).

Saga: T10377 (SG-IVTR-AC-BINDING). Epic: T10381. Decision: D013.
ADR-079-r2 §2.4 + §3.
