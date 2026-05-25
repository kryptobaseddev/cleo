---
id: t10511-ivtr-sdk-tools
tasks: [T10511]
kind: feat
summary: "sdk-tools: validator.attest/reject/ac-pull + spawn.validator (T10383 Wave 3b)"
---

Ships the four IVTR-feeding SDK tools per T10511 (Saga T10377 SG-IVTR-AC-BINDING, Epic T10383 E-VALIDATOR-ROLE):

1. **`validator.attest`** — terminal validator-role tool. Accepts a `ValidatorAttestation` envelope, schema-validates via `validatorAttestationSchema`, checks every `finding.acId` resolves to a real `task_acceptance_criteria` row, then transactionally writes one `evidence_ac_bindings` row per AC with `binding_type='coverage'`. UNIQUE (atom, ac, type) index collapses idempotent re-attests.

2. **`validator.reject`** — terminal validator-role tool. Schema-validates a `ValidatorRejection` envelope and emits a structured echo envelope with `failingFindingCount` + `failingAcIds`. CRITICAL invariant — writes ZERO `evidence_ac_bindings` rows (rejection = absence of binding).

3. **`validator.ac-pull`** — read-only tool. Returns `{ taskId, acs: [{ id, alias, ordinal, text, bindingStatus: 'satisfied' | 'unsatisfied' }] }` so a Validator can see at a glance which ACs already have coverage.

4. **`spawn.validator`** — orchestrator-tier-1+ tool. Delegates to existing `orchestrateSpawn(taskId, 'validator', …)` after enforcing `caller.role==='orchestrator' && caller.tier>=1`. No parallel registry per council §3.1 ADR-D rejection.

Per-tier scoping is enforced inside each tool's `fn` (no new SdkToolIdentity fields, no parallel registry). All four use the existing `defineSdkTool` factory at `packages/core/src/tools/task-tools/sdk-tool.ts`.

Adds one new `TransactionAccessor` method — `insertAcBindings(rows)` — wired through `packages/contracts/src/data-accessor.ts` and `packages/core/src/store/sqlite-data-accessor.ts`. Idempotent via `ON CONFLICT DO NOTHING` against the existing `uq_evidence_ac_bindings_atom_ac_type` index.

19 new unit tests in `packages/core/src/tools/__tests__/sdk/validator-tools.test.ts` cover: registration sanity, auth-path rejection (all three wrong roles), happy-path attestation, idempotent re-attest, E_VALIDATOR_AC_NOT_FOUND, E_VALIDATOR_ATTESTATION_INVALID, rejection envelope shape, NO-bindings-on-reject invariant, ac-pull empty/mixed/unknown-task paths, and spawn-validator role+tier gating.
