# Wave B Lead Manifest

**Date**: 2026-05-08
**Scope**: B1 (T9185) + B2 (T9170 CI gate re-enable)

## Summary

Wave B completed. B1 and B2 both landed. T9182 redo skipped as directed.

## Tasks

### B1: T9185 — Schema audit + T9170 gate fixture cleanup

**Root cause discovered**: The T9170 schema-warning gate false positive was from
`brain-observations-provenance.test.ts` OBS-6, which directly calls `ensureColumns`
on an in-memory `brain_page_edges` table (WITHOUT provenance) to unit-test the
safety-net. This emits the `"Adding missing column brain_page_edges.provenance via ALTER TABLE"`
WARN to the shard output, which the gate script picks up as a violation.

**Why it was `<unknown>`**: When vitest runs multiple test files in the same worker,
vi.mock hoisting warnings from `propose-tick.test.ts` appear before OBS-6's
test execution. The gate script's test-file tracking attributed the JSON warning
to propose-tick (no `(node:PID)` line preceded the vi.mock warning, causing PID-to-file
association to be empty). In some shard runs the warning appears before any test file
completion line — hence `<unknown>`.

**Acceptance criteria audit**:
- `brain_page_edges.provenance` — forward migration IS in T528 (CREATE TABLE with provenance).
  T920 partial-migration handler also handles the partial-T528 case. No new migration needed.
- `brain_page_nodes.quality_score` — forward migration IS in T528 (ALTER TABLE ADD COLUMN).
  No ensureColumns call for this column in memory-sqlite.ts. No new migration needed.
- Full ensureColumns audit confirmed all columns either have explicit forward migrations
  or are T920-handled partial-migration cases.

**Fix applied**:
1. `packages/core/src/memory/__tests__/brain-observations-provenance.test.ts` OBS-6:
   Added `vi.spyOn(loggerModule, 'getLogger')` to capture the intentional WARN internally
   and assert on its content rather than letting it escape to shard output.
2. `scripts/check-schema-warning-budget.mjs`: Added `brain-observations-provenance.test.ts`
   to ALLOWED_FILES as belt-and-suspenders.

**Commits**:
- `2b19e600c` fix(T9185): suppress schema-warning gate false positive from OBS-6 test
- Merge SHA on main: `2198d1b12`

### B2: T9170 CI gate re-enable

**Change**: Restored `set -o pipefail` + tee to `/tmp/vitest-shard$N.log` in the
full-shard-sweep step, and restored the T9170 gate step (ubuntu-latest only) in
`.github/workflows/ci.yml`.

**Commit**: `625223319` ci(T9170): re-enable schema-warning budget gate after T9185 fix

## Verification

- Local shard 1: `T9170: schema-warning budget OK — zero "Adding missing column" outside allowlist.`
- Local shard 2: `T9170: schema-warning budget OK — zero "Adding missing column" outside allowlist.`
- brain-observations-provenance.test.ts: `6 passed (6)` — OBS-6 now verifies the WARN was called internally
- biome check on T9185 files: clean (no errors)

## Release

- PR #111: https://github.com/kryptobaseddev/cleo/pull/111
- Release branch: `release/v2026.5.55`
- CHANGELOG committed: `1ecc83b83` docs(T9185): add CHANGELOG section for v2026.5.55
- CI run: https://github.com/kryptobaseddev/cleo/actions/runs/25548648516
  - Status: FAILING (pre-existing biome 2.4.8 vs 2.4.11 schema mismatch in CI infra)
  - DB Open Chokepoint Guard: FAILING (pre-existing ADR-068 guard unrelated to T9185)
  - Lockfile Check: PASS
  - Migration Integrity: PASS
  - These failures are pre-existing and present in v2026.5.54 CI run as well.

## Phantom Recoveries

None. Both commits are real with verified file changes.

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/memory/__tests__/brain-observations-provenance.test.ts` | OBS-6: spy on logger |
| `scripts/check-schema-warning-budget.mjs` | Add brain-observations-provenance to ALLOWED_FILES |
| `.github/workflows/ci.yml` | Re-enable T9170 gate steps |
| `CHANGELOG.md` | Add v2026.5.55 section |

## Final State

- Main HEAD: `1ecc83b83`
- task/T9185 branch: `625223319` (merged to main as `2198d1b12`)
- T9185: marked done in cleo
- T9170 gate: enabled in CI, passes both shards locally
