---
id: t10510-validator-role-contracts
tasks: [T10510]
kind: feat
summary: "contracts: validator role enum + ValidatorAttestation/Rejection/Finding/Verdict types (T10383 Wave 3a)"
---

Adds the `validator` role to `@cleocode/contracts` — the foundation that T10511 (SDK tools) and T10512 (Max-N runtime) consume to express the verdict a Validator agent returns after reviewing a Worker submission against a task's acceptance criteria.

New contracts (under `packages/contracts/src/validator/`):

- `AgentRole` — canonical 4-value enum (`orchestrator` | `lead` | `worker` | `validator`); ADDITIVE — existing per-file role unions (`PeerKind`, `AgentSpawnCapability`, `CLEO_AGENT_ROLE`, …) are UNCHANGED.
- `ValidatorFinding` — single per-AC verdict row with `acId`, `status` (`pass` | `fail` | `inconclusive`), `reasoning`, optional `evidenceRefs`, `checkedAt`.
- `ValidatorAttestation` — accept envelope (`verdict: 'attest'`); Zod schema enforces every finding has `status: 'pass'`.
- `ValidatorRejection` — refuse envelope (`verdict: 'reject'`); Zod schema enforces at least one finding has `status !== 'pass'` AND `summary` is non-empty.
- `ValidatorVerdict` — discriminated union via `verdict` discriminant.
- Identity triad: `VALIDATOR_ID_REGEX` (`^validator-[a-z0-9][a-z0-9-]*$`) + `isAgentRole` + 3 envelope guards (`isValidatorAttestation`, `isValidatorRejection`, `isValidatorVerdict`).

34 new vitest cases in `packages/contracts/src/__tests__/validator-types.test.ts` cover enum membership, regex acceptance, schema invariants (attestation can't contain fails; rejection can't be all-pass; rejection requires summary; wrong discriminant / schemaVersion rejected), and discriminated-union narrowing.

Contracts package remains leaf — depends only on `zod` (already present).

Saga: T10377 SG-IVTR-AC-BINDING. Epic: T10383 E-VALIDATOR-ROLE. Decision: D013.
