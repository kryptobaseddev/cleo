# T9358 Coverage Measurement + Per-Role Integration Test Audit

**Date**: 2026-05-16
**Task**: T9358 (AC3 + AC4 verification for T9354)

## AC3: LLM Coverage Report

**Command**: `pnpm --filter @cleocode/core exec vitest run --coverage --coverage.provider=v8 --coverage.include="src/llm/**" src/llm`

**Coverage Report** (saved at `.cleo/coverage/llm-coverage.json`):

| Metric | Coverage | Threshold |
|--------|----------|-----------|
| Statements | 71.33% (2391/3352) | 80% |
| Branches | 58.65% (1627/2774) | 80% |
| Functions | 80.52% (368/457) | 80% |
| Lines | 72.78% (2249/3090) | 80% |

**Status**: BELOW THRESHOLD (statements 71.33% < 80%)

### Files with 0% Coverage (Major Gaps)

| File | Purpose | Reason |
|------|---------|--------|
| `role-executor.ts` | executeForRole() - role-based transport dispatch | No tests exist |
| `api.ts` | cleoLlmCall entrypoint (retry, fallback, tool loop) | No tests exist |
| `request-builder.ts` | Low-level request assembly | No tests exist |
| `tool-loop.ts` | executeToolLoop wrapper | No tests exist |
| `types.ts` | Type definitions | Structural (types-only) |
| `rust/index.js` | Native NAPI binding | Structural (native) |
| `generated/provider-profiles.ts` | Generated data file | Structural (generated) |

### Files < 50% Coverage

| File | Coverage | Key Uncovered Lines |
|------|----------|---------------------|
| `runtime.ts` | 27.58% | 99-167 |
| `executor-factory.ts` | 44% | 96-97, 141-174, 187 |
| `stable-device-id.ts` | 45.45% | 62-91 |

### Structural Limitations (not backfillable)

- `rust/index.js`: Native NAPI binding - cannot be covered by vitest
- `generated/*.json` + `generated/provider-profiles.ts`: Generated files - no executable logic
- `types.ts` lines 126-137: Type-only runtime guards

### Gap Tasks Filed

- **T9394**: Add executeForRole mock-transport tests for extraction/derivation/hygiene/judgement
- **T9395**: Backfill coverage for api.ts, tool-loop.ts, runtime.ts (depends on T9394)

## AC4: Per-Role Integration Test Audit

**Roles**: extraction, consolidation, derivation, hygiene, judgement

### Count Methodology

Integration tests against mock transport = tests that call `createForRole('role')` or 
`executeForRole('role')` with mocked transport (no real network calls).

### Results

| Role | Tests (mock transport) | File | Meets >=3 threshold |
|------|----------------------|------|---------------------|
| extraction | 1 | session-factory.test.ts L72 | NO (gap) |
| consolidation | 8 | executor-factory (4) + session-factory (4) | YES |
| derivation | 1 | session-factory.test.ts L82 | NO (gap) |
| hygiene | 2 | session-factory.test.ts L92 + executor-factory L137 | NO (gap) |
| judgement | 0 | (none) | NO (gap - CRITICAL) |

### Role-Resolver Coverage (supplementary)

The `role-resolver-fullstack.test.ts` iterates ALL_ROLES in 2 loop tests, giving each role 2 
resolution-level integration tests (real filesystem, no transport execution). These exercise
credential resolution but NOT transport dispatch.

With resolver tests included:
- extraction: 1+2+1(label)=4, consolidation: 8+7+5=20, derivation: 1+2=3, hygiene: 2+2=4, judgement: 0+2+1=3

**Note**: Even counting resolver tests, judgement has 0 mock-transport execution tests.

### Gap Tasks Filed

- **T9394**: Add executeForRole mock-transport tests covering all 4 gap roles (extraction/derivation/hygiene/judgement) with >= 3 it() blocks each

