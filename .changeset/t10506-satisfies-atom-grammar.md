---
id: t10506-satisfies-atom-grammar
tasks: [T10506]
kind: feat
summary: "evidence: satisfies:<tid>#<aid> atom kind parser (T10381 Wave 2b)"
---

Adds the `satisfies:<task-id>#<ac-id>[@<version-pin>]` evidence atom kind
to the ADR-051 grammar per ADR-079-r2 §2.1 ABNF.

PARSING ONLY — accepts both UUID form
(`satisfies:T1234#a1b2c3d4-5e6f-4890-abcd-ef1234567890`) and positional-
alias form (`satisfies:T1234#AC2`), with the optional 14-digit version-pin
suffix (`@YYYYMMDDhhmmss`). Strict per-field regexes enforce: task-id
`/^T[0-9]{1,7}$/`, ac-uuid strict lowercase UUIDv4, ac-alias
`/^AC[0-9]{1,4}$/`, version-pin 14 digits.

The 5-check validator semantics (target task exists, target not terminal,
AC exists by UUID-or-alias lookup, same-saga scope rule, alias-drift
detection) ship in T10507 alongside the `evidence_satisfies_bindings`
side-effect table writes. Until T10507 lands, the runtime validator
returns `E_AC_BINDING_VALIDATOR_PENDING` to make the deferral explicit.

Surfaces:
- `packages/contracts/src/evidence-atom-schema.ts` — `satisfiesAtomSchema`
  Zod discriminator, exported regexes (`AC_UUID_REGEX`, `AC_ALIAS_REGEX`,
  `SATISFIES_TASK_ID_REGEX`, `SATISFIES_VERSION_PIN_REGEX`), and the new
  `parseEvidenceString` case.
- `packages/contracts/src/task.ts` — validated `EvidenceAtom` union gains
  the `satisfies` shape with reserved `resolvedAcUuid` for T10507.
- `packages/core/src/tasks/evidence.ts` — `ParsedAtom` union + runtime
  validator switch updated; deferred-validator case added.

Saga: T10377 (SG-IVTR-AC-BINDING). Epic: T10381. Decision: D013.
