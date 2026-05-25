---
id: t10514-validator-skill-aligned
tasks: [T10514]
kind: docs
summary: "SKILL: cleo-validator aligned to shipped contracts + 4 tools + Max-N runtime (T10383 council action #5 closure)"
---

The `.cleo/skills/cleo-validator/SKILL.md` placeholder draft (T10495)
and infra-fault row catalogue (T10496) shipped before the contract +
tools + runtime existed. Now that T10510 (contracts), T10511 (4 SDK
tools), and T10512 (`runValidatorMaxN` runtime) are in `main`, this
revision aligns the SKILL to shipped reality.

Changes to `.cleo/skills/cleo-validator/SKILL.md`:

- Reference the actual shipped contract types from
  `@cleocode/contracts/validator`: `ValidatorAttestation`,
  `ValidatorRejection`, `ValidatorFinding`, `ValidatorVerdict`,
  `AgentRole`. Drop the placeholder `AcFinding` shape.
- Tool Strategy names the 4 shipped tools with EXACT signatures lifted
  from `packages/core/src/tools/sdk/`:
  - `validator.attest` — writes `evidence_ac_bindings` rows with
    `binding_type='coverage'`; returns `{ ok, bindingsWritten,
    bindingIds, processedAt }`.
  - `validator.reject` — NO DB writes; returns `{ ok, rejection,
    failingFindingCount, failingAcIds, processedAt }`.
  - `validator.ac-pull` — returns `{ ok, taskId, acs: [{ id, alias,
    ordinal, text, bindingStatus }] }`.
  - `spawn.validator` — orchestrator-tier-1+ gated; delegates to
    `orchestrateSpawn` with `protocolType='validator'`.
- Output Formats section shows REAL envelope shapes mirroring the
  shipped Zod schemas (`validatorAttestationSchema`,
  `validatorRejectionSchema`, `validatorFindingSchema`,
  `validatorVerdictSchema`). Adds the three type guards
  `isValidatorAttestation` / `isValidatorRejection` / `isValidatorVerdict`.
- NEW `## Max-N Runtime` section names `runValidatorMaxN` at
  `packages/core/src/lifecycle/validator/runtime.ts`, documents the
  `ValidatorRuntimeDeps` injection contract, the three terminal
  outcomes (`attest` / `escalate-hitl` / `escalate-permanent`), and
  preserves the T10496 infra-fault row catalogue cross-referenced to
  the shipped `MAX_N_ROWS` constant.
- `metadata.version` bumped to `2.0.0`; `metadata.lastReviewed` set to
  `2026-05-25`; `metadata.stability` stays `experimental` until T10515
  integration test runs green.

Closes T10514. Closes Council §3.1 action #5 (SKILL ships aligned with
contract). Saga T10377. Decision D013.
