# T1828 — LLM Conflict-Validator Hook on ADR Decision Writes

**Status**: complete
**Commit**: 306afb6cf279fd0019ac8e4a351cf01b99dbeb0e
**Merged**: task/T1828 → main via `git merge --no-ff`

## Summary

Added `validateDecisionConflicts()` as a pre-write semantic guard on all ADR-typed
`storeDecision()` calls (`adrPath` set). The hook runs before the existing
`verifyCandidate` gate and uses `evaluateDialectic()` from the dialectic subsystem
(cold tier, `claude-sonnet-4-6`) to detect collisions, contradictions, and
supersession-graph integrity violations.

## Files Changed

- `packages/core/src/memory/decisions.ts` — `validateDecisionConflicts()` + hook wired into `storeDecision()`
- `packages/contracts/src/errors.ts` — `DecisionValidatorFailedError` (code: `E_DECISION_VALIDATOR_FAILED`, exitCode: 106)
- `packages/contracts/src/config.ts` — `DecisionsConfig` interface + `CleoConfig.decisions` field
- `packages/contracts/src/index.ts` — exports for `DecisionsConfig` + `DecisionValidatorFailedError`
- `packages/contracts/src/exit-codes.ts` — `DECISION_VALIDATOR_FAILED = 106`
- `packages/core/src/memory/__tests__/decisions.test.ts` — 9 new tests (22 total, all passing)

## Acceptance Criteria Coverage

1. `validateDecisionConflicts()` in `decisions.ts` — calls `evaluateDialectic()` from dialectic-evaluator.ts
2. Hook BEFORE existing `verifyCandidate` gate in `storeDecision()`
3. Output: `{collisions, contradictions, supersession_graph_violations, confidence}` — throws `E_DECISION_VALIDATOR_FAILED` on confidence < threshold
4. `DecisionValidatorFailedError` in `packages/contracts/src/errors.ts`
5. Configurable threshold: `decisions.validatorConfidenceThreshold` in `.cleo/config.json` (default 0.7)
6. Skips if `CLEO_ENV === 'test'`
7. Unit tests: env-skip, non-ADR skip, Jaccard collision, supersession-graph violation, LLM-unavailable fallback, error class shape, ADR gate integration
8. Business logic in `packages/core/` — no dispatch code in `packages/cleo/`

## Test Results

22 tests passed, 0 failed. Biome lint: 0 errors. TypeCheck: clean.
