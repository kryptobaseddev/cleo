# T1827: publishAdr Sequential ADR Numbering

## Summary

Implemented the `publishAdr()` flow with sequential ADR numbering, closing the T1826 adrNumber-write gap.

## Changes

### `packages/core/src/docs/docs-ops.ts`
- New `publishAdr(params: PublishAdrParams): Promise<PublishAdrResult>`
  - Acquires `MAX(adr_number)+1` via `selectNextAdrNumber()` 
  - Writes `.cleo/adrs/ADR-{NNN:03d}.md` via tmp-then-rename
  - Inserts `brain_decisions` row with `adrNumber`, `adrPath`, `confirmationState='accepted'`, `decidedBy`
  - Retries up to 3 times (50ms backoff) on UNIQUE constraint collision
  - Returns `{adrNumber, adrPath, decisionId}`
- New `selectNextAdrNumber(db: AdrSequenceDb): Promise<number>` — exported helper
- New `AdrSequenceDb` interface — duck-typed for test mocking

### `packages/core/src/memory/decisions.ts`
- Added `adrNumber?: number` field to `StoreDecisionParams`
- `storeDecision()` auto-calls `selectNextAdrNumber()` when `adrPath` is set and `adrNumber` not provided

### `packages/cleo/src/cli/commands/docs.ts`
- Extended `cleo docs publish` with `--as-adr` flag (thin dispatch only)
- Added `--decision`, `--rationale`, `--content`, `--decided-by` args

### `packages/core/src/internal.ts`
- Exported `publishAdr`, `selectNextAdrNumber`, `AdrSequenceDb`, `PublishAdrParams`, `PublishAdrResult`

### `packages/core/src/docs/__tests__/docs-ops.test.ts`
- 8 new tests: `selectNextAdrNumber` (3 cases), `publishAdr` concurrency retry loop (5 cases)

## Evidence

- Commit: `233327a266f2e0a9e9fc2f639b74435334f54dd7` on `task/T1827` branch
- Tests: 27/27 passed (vitest-t1827.json: passCount=27, failCount=0)
- Lint: biome check clean (0 errors)
- Typecheck: 0 new errors in changed files
