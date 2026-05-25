---
id: t10512-validator-max-n-runtime
tasks: [T10512]
kind: feat
summary: "runtime: Lead↔Worker Max-N retry loop for Validator round-trip (T10383 Wave 3b)"
---

Implements `runValidatorMaxN(workerTaskId, deps, opts)` — the Max-N retry runtime that orchestrates the canonical Lead↔Worker↔Validator round-trip defined by the `cleo-validator` SKILL.md (T10495 + T10496). Lives at `packages/core/src/lifecycle/validator/runtime.ts` with a barrel re-export from `packages/core/src/lifecycle/validator/index.ts`.

Key design contracts:

- **Dependency-injected** — the runtime never imports T10511's SDK tools directly. Callers pass `spawnValidator` and `respawnWorker` callbacks via the `ValidatorRuntimeDeps` contract. Tests stub them; production wiring (a follow-up task) supplies real adapters around `spawn.validator`, `validator.attest`, `validator.reject`, and `validator.evidence-run`. The runtime only depends on the verdict envelope types shipped by T10510 (`ValidatorVerdict`).
- **Shared retry counter** — semantic faults (REJECT) and infra faults (`timeout`, `conduit-drop`, `validator-OOM`) share a single `validatorRetryAttempts` counter bounded by `validatorRetryMax` (default N=3). This prevents adversarial fault-kind alternation from bypassing the cap (VAL-007 in the SKILL.md).
- **Canonical Max-N row catalogue** — `MAX_N_ROWS` table encodes per-fault retry counts, backoff strategies, and transient/permanent classification per the SKILL.md table. `permanent` rows short-circuit on first occurrence; `transient-then-permanent` (validator-OOM) escalates permanent after the per-row retry budget exhausts.
- **Backoff strategies** — `immediate`, `exponential(firstMs, secondMs)`, and `immediate-downgrade` (zero delay + advisory `downgradeModelTier` flag on next spawn for context shrinkage).
- **Append-only JSONL audit** — every retry attempt (semantic or infra) emits one row to `.cleo/audit/validator-retries.jsonl` with `timestamp`, `taskId`, `attemptNumber`, `faultFamily`, `faultKind`, `classification`, `backoffMs`, `retryDecision`, `message`, and optional `detail`. Matches the `force-bypass.jsonl` / `contract-violations.jsonl` convention. Suppressible via `suppressAudit: true` for tests.
- **Defensive error handling** — thrown errors from `spawnValidator` are normalized to `timeout` infra-fault envelopes so the runtime never propagates unhandled rejections.

20 unit tests cover happy path (attest first try, reject→fix→attest), each infra-fault row (timeout exponential backoff, conduit-drop immediate, validator-OOM downgrade + second-OOM permanent), shared-counter exhaustion via mixed fault kinds, adversarial REJECT↔timeout alternation, per-row counter exhaustion, custom `validatorRetryMax`, audit JSONL append behaviour, `suppressAudit`, Worker re-spawn failures, defensive thrown-error translation, and the discriminated-union result type narrowing.

Saga: T10377 (SG-IVTR-AC-BINDING). Epic: T10383 (E-VALIDATOR-ROLE). Decision: D013.
