# T1604 Implementation — LOC-drop gate for engine-migration tasks

## Summary

Added the `loc-drop` evidence atom kind and wired it into the `implemented` gate for tasks labelled `engine-migration`. This prevents structural-only engine migration claims (as seen in T1543) by requiring agents to prove measurable LOC reduction before marking an engine migration as implemented.

## Commits

- `452c1cea34ff845b765c5a002e5c13ab2ef5df59` on branch `task/T1604`

## Files Changed

| File | Change |
|------|--------|
| `packages/contracts/src/task.ts` | Added `loc-drop` member to `EvidenceAtom` union |
| `packages/core/src/tasks/evidence.ts` | Parse + validate `loc-drop` atoms; `checkEngineMigrationLocDrop()`; `ENGINE_MIGRATION_MIN_REDUCTION_PCT=10` |
| `packages/core/src/verification/evidence-atoms.ts` | `hasEngineMigrationLabel()`; `ENGINE_MIGRATION_LABEL` constant |
| `packages/core/src/internal.ts` | Export new functions + constants |
| `packages/cleo/src/dispatch/engines/validate-engine.ts` | Label-check wired into `validateGateVerify` |
| `packages/core/src/tasks/__tests__/loc-drop.test.ts` | 31 new tests (all passing) |

## Gates Passed

- `implemented`: commit d9e19eb3 + note
- `testsPassed`: test-run /tmp/vitest-T1604.json (107/107 passing)
- `qaPassed`: tool:lint + tool:typecheck (both exit 0)

## Design Notes

- `loc-drop` atom format: `loc-drop:<fromLines>:<toLines>` (e.g. `loc-drop:1200:800`)
- `fromLines` must be > 0 (cannot reduce from nothing)
- `toLines` must be <= `fromLines` (LOC must not increase)
- `reductionPct` is computed and stored (rounded to 2 decimal places)
- Default threshold: 10% LOC reduction (`ENGINE_MIGRATION_MIN_REDUCTION_PCT`)
- Threshold check is separate from atom validation — customizable per caller
- `loc-drop` is treated as a soft atom at re-verify time (immutable counts)
- Label injection: engine-migration label triggers loc-drop check on `implemented` gate
- Additive design: sibling task T1605 can extend `evidence-atoms.ts` cleanly
