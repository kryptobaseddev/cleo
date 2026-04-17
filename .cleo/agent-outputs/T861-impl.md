# T861 Implementation Log — CLEO CLI Perfection

**Date**: 2026-04-17
**Session**: ses_20260416230443_5f23a3
**Lead**: Sonnet T861

---

## T863: Parent-run() handlers

**Status**: Complete

Added `async run({ cmd }) { await showUsage(cmd); }` to 9 command files:
- `admin.ts` — also added `showUsage` to citty import
- `cant.ts` — also added `showUsage` to citty import
- `complexity.ts` — also added `showUsage` to citty import
- `conduit.ts` — also added `showUsage` to citty import
- `decomposition.ts` — also added `showUsage` to citty import
- `diagnostics.ts` — also added `showUsage` to citty import
- `implementation.ts` — also added `showUsage` to citty import
- `migrate-claude-mem.ts` — also added `showUsage` to citty import
- `specification.ts` — also added `showUsage` to citty import

**Verification**: Python scan confirms 0 parent commands with subCommands and missing run().

Fixed pre-existing test: `packages/cleo/src/cli/__tests__/startup-migration.test.ts` was missing
`vi.mock('../commands/conduit.js')` causing the `find()` predicate to return conduit's
defineCommand instead of the root main command. Added the missing mock.

**Smoke test results** (using dev build `dist/cli/index.js`):
- `cleo admin` → shows "System administration and diagnostics" help
- `cleo cant` → shows "CANT DSL tooling" help
- `cleo complexity` → shows "Task complexity analysis" help
- `cleo conduit` → shows "Manage Conduit inter-agent messaging" help
- `cleo decomposition` → shows "Validate decomposition protocol compliance" help
- `cleo diagnostics` → shows "Autonomous self-improvement telemetry" help
- `cleo migrate` → shows "Data migration utilities" help

---

## T864: Registry params[] backfill

**Status**: Complete

Added `params:` field to all 270 operations in the OPERATIONS registry.

Before: 66 operations with params[], 204 without
After: 270 operations with params[] (100% coverage)

Types of additions:
- `params: []` for 134 operations with no requiredParams (explicitly "no params")
- `params: [{ name, type, required, description }]` for 70 operations with requiredParams
- Full params[] for `tasks.add` (11 params matching existing snapshot)

Also updated:
- `packages/cleo/src/dispatch/__tests__/parity.test.ts` — operation count updated from 268 to 270
  to reflect 2 new operations added by concurrent T820 work (release.changelog.since + release.rollback.full)

**ParamDef type**: Already in packages/contracts/src/operations/params.ts (SSoT).
`packages/cleo/src/cli/lib/registry-args.ts` exists as the bridge helper.

---

## T867: ADR-052

**Status**: Complete

Written to: `.cleo/adrs/ADR-052-caamp-keeps-commander.md`

Status: ACCEPTED

Key rationale:
1. Separate binary with separate concerns
2. commander `preAction` + `optsWithGlobals()` has no citty equivalent
3. commander `parseAsync` test isolation works; citty's `runMain` does not
4. commander@14 actively maintained (80M+ weekly downloads, no deprecation schedule)
5. Zero user-visible benefit to migration
6. 20+ command files would need restructuring

---

## Quality Gates

Build: PASS (`pnpm run build` clean)
Tests: 8542 passed, 2 failed (both pre-existing from concurrent T832/T820 work)
  - `injection-mvi-tiers.test.ts`: CLEO-INJECTION.md version changed 2.4.1→2.5.0 by T832
  - `safestop.test.ts`: `reason` arg `required: true` changed to `required: false` by T832
Biome: PASS on all 12 modified files

---

## Files Modified

1. `packages/cleo/src/cli/commands/admin.ts` — showUsage import + run() handler
2. `packages/cleo/src/cli/commands/cant.ts` — showUsage import + run() handler
3. `packages/cleo/src/cli/commands/complexity.ts` — showUsage import + run() handler
4. `packages/cleo/src/cli/commands/conduit.ts` — showUsage import + run() handler
5. `packages/cleo/src/cli/commands/decomposition.ts` — showUsage import + run() handler
6. `packages/cleo/src/cli/commands/diagnostics.ts` — showUsage import + run() handler
7. `packages/cleo/src/cli/commands/implementation.ts` — showUsage import + run() handler
8. `packages/cleo/src/cli/commands/migrate-claude-mem.ts` — showUsage import + run() handler
9. `packages/cleo/src/cli/commands/specification.ts` — showUsage import + run() handler
10. `packages/cleo/src/dispatch/registry.ts` — params[] backfill for 204 ops + tasks.add full params
11. `packages/cleo/src/dispatch/__tests__/parity.test.ts` — op count 268→270 (T820 added 2 ops)
12. `packages/cleo/src/cli/__tests__/startup-migration.test.ts` — add missing conduit.js mock
13. `.cleo/adrs/ADR-052-caamp-keeps-commander.md` — new ADR

---

## Pre-existing issues NOT caused by T861 work

- `packages/cleo/src/dispatch/engines/release-engine.ts` — `checkIvtrGates` unused import (T820)
- `packages/core/templates/CLEO-INJECTION.md` — version 2.5.0 vs test expecting 2.4.1 (T832)
- `packages/cleo/src/cli/commands/safestop.ts` — `reason` required changed (T832)
- 7 biome errors in files modified by T832 (task-engine, validate-engine, contracts index, core internal, core tasks index, evidence.test.ts, update-pipelinestage.test.ts)
