# T816 — EvidenceRecord Contract

**Task**: IVTR-06: Ship `EvidenceRecord` typed contract in `packages/contracts`
**Status**: complete
**Agent**: T816-worker (claude-sonnet-4-6)
**Date**: 2026-04-16

## Files Produced

| File | Role |
|------|------|
| `packages/contracts/src/evidence-record.ts` | TypeScript discriminated union types |
| `packages/contracts/src/evidence-record-schema.ts` | Zod discriminated union + per-variant schemas |
| `packages/contracts/src/__tests__/evidence-record.test.ts` | Round-trip tests (5 variants × 2 cases + routing/rejection) |
| `packages/contracts/src/index.ts` | Updated — all types and schemas exported |

## Variants Shipped

| `kind` | `phase` | Description |
|--------|---------|-------------|
| `impl-diff` | `implement` | Code diff produced by implement-phase agent |
| `validate-spec-check` | `validate` | REQ-ID satisfaction check by validate-phase agent |
| `test-output` | `test` | Test command run with pass/fail counts |
| `lint-report` | `implement` \| `test` | Static-analysis run (biome, tsc, etc.) |
| `command-output` | `implement` \| `validate` \| `test` | Generic CLI command invocation |

## Quality Gate Results

```
$ grep -c "kind: 'impl-diff'\|kind: 'validate-spec-check'\|kind: 'test-output'\|kind: 'lint-report'\|kind: 'command-output'" packages/contracts/src/evidence-record.ts
6

$ pnpm --filter @cleocode/contracts run build
> @cleocode/contracts@2026.4.70 build /mnt/projects/cleocode/packages/contracts
> tsc -b --force
(clean exit, zero errors)

$ pnpm --filter @cleocode/contracts run test 2>&1 | tail -5
 Test Files  4 passed (4)
      Tests  117 passed (117)
   Start at  09:27:23
   Duration  410ms (transform 526ms, setup 0ms, import 759ms, tests 41ms, environment 0ms)
```

## Design Notes

- Mirrors the `acceptance-gate.ts` / `acceptance-gate-schema.ts` split pattern exactly.
- `evidenceBaseSchema` (unexported) holds the four shared provenance fields (`agentIdentity`, `attachmentSha256`, `ranAt`, `durationMs`) and is composed into each variant via `.extend()`.
- `attachmentSha256` validated as exactly 64 hex characters (`z.string().length(64)`).
- `ranAt` validated as ISO 8601 datetime via `z.string().datetime()`.
- `durationMs` validated as `z.number().nonnegative()` — no fractional restriction since sub-ms precision is valid.
- All 5 variant schemas, the discriminated union, and inferred input types are exported from `index.ts`.
