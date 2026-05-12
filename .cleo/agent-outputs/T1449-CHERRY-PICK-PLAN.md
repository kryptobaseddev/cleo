# T1449 cherry-pick plan — completed domains → main

**Generated**: 2026-04-27 00:25 UTC
**Status**: STAGED — execute after T1458 completes
**Current main HEAD**: `c6db48f3e` (T1451 admin WIP, includes T1436 OpsFromCore)
**Origin/main HEAD**: `be730c92a` (v2026.4.148) — local is 3 commits ahead

## Substantive commits to cherry-pick (in order)

The order minimizes conflicts on `packages/core/src/cleo.ts` (touched by every domain) and engine wrappers.

| # | Task | Domain | Commit | Status |
|---|---|---|---|---|
| 1 | T1450 | session | `fbc15644c` feat(T1450): refactor session sibling Core fns | branch deleted; cherry-pick by SHA |
| 2 | T1452 | check | `3980da79a` feat(T1452): check domain Core API alignment per ADR-057 D1 | task/T1452 still exists |
| 3 | T1453 | conduit | `e8034924d` feat(T1453): add @cleocode/core/conduit vitest alias | branch deleted; cherry-pick by SHA |
| 4 | T1455 | pipeline | `eedaf60f8` feat(T1455): pipeline domain Core API alignment per ADR-057 D1 | task/T1455 still exists |
| 5 | T1456 | playbook | `e73eea1bf` feat(T1456): playbook domain ADR-057 alignment | task/T1456 still exists |
| 6 | T1457 | sentient | `36b5986c7` chore(T1457): WIP — recovered from crash | branch deleted; this IS the substantive work per worker verification |
| 7 | T1454 | nexus | `70cf9a435` feat(T1454): nexus domain Core API alignment per ADR-057 D1 | task/T1454 (this session) |
| 8 | T1458 | tasks | `<TBD>` | pending T1458 worker completion |

**WIP recovery commits to SKIP** (these were partial states — substantive commits supersede them):
- `f0261b37b` (T1455 WIP)
- `863ad1aa6` (T1456 WIP)
- `91452eb64` (T1454 WIP — orphan)
- `9df5308a1` (T1458 WIP — orphan)
- Per-branch duplicate copies of T1436 OpsFromCore: `76385ee78`, `fb4d712ae`, `dc377e6d7` — these are the same code, already on main as `c83bd0307`

## Cherry-pick conflict expectations

- **packages/core/src/cleo.ts**: HIGH conflict risk (touched by every domain). Resolve in order; later cherry-picks need to merge their facade method changes with prior ones.
- **packages/cleo/src/dispatch/engines/<domain>-engine.ts**: domain-isolated (session-engine, pipeline-engine, nexus-engine, task-engine, etc. — different files). NO cross-domain conflict.
- **packages/cleo/src/dispatch/domains/<domain>.ts**: domain-isolated. NO cross-domain conflict.
- **packages/contracts/src/operations/<domain>.ts**: domain-isolated. NO cross-domain conflict.
- **packages/core/src/<domain>/**: domain-isolated. NO cross-domain conflict.

## Procedure

```bash
# From /mnt/projects/cleocode (main checked out)
# Confirm clean working tree first (deal with .cleo/agent-outputs and dev/sandbox staging separately)
git status

# Cherry-pick in order
git cherry-pick fbc15644c  # T1450
# resolve cleo.ts conflicts if any, then continue
git cherry-pick 3980da79a  # T1452
git cherry-pick e8034924d  # T1453
git cherry-pick eedaf60f8  # T1455
git cherry-pick e73eea1bf  # T1456
git cherry-pick 36b5986c7  # T1457
git cherry-pick 70cf9a435  # T1454
git cherry-pick <T1458-sha> # T1458 (pending)

# Validate
pnpm install
pnpm biome ci .
pnpm run build 2>&1 | tail -30
pnpm run test 2>&1 | tail -30
node scripts/lint-contracts-core-ssot.mjs --exit-on-fail   # T1459 lint, after T1459 wired
```

## Branches to delete after cherry-pick lands on main

- `task/T1452` (locally only — never pushed to origin)
- `task/T1454` (local + worktree — clean up worktree first)
- `task/T1455`
- `task/T1456`
- `task/T1458` (after T1458 cherry-pick lands)
- `task/T1451` (already cherry-picked into main as `c6db48f3e`)

```bash
# After cherry-pick verified
for t in T1451 T1452 T1454 T1455 T1456 T1458; do
  git worktree remove /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/$t 2>/dev/null
  git branch -D task/$t
done
```

## Push

```bash
git push origin main
# Watch CI — should be green if all gates passed locally
```

This sets up the v2026.4.150+ release (T1460) which can then proceed with version bump + tag + push.

## Post-cherry-pick validation

After all 7+ cherry-picks land on main:

1. Run lint script: `node .cleo/agent-outputs/T1459-lint-contracts-core-ssot-DRAFT.mjs` — should report ZERO domain violations (utility-helper false-positives still expected per codex deferred fixes)
2. Verify origin: `git log origin/main..main --oneline` should show all cherry-picks
3. T1459 ADR can now have its implementation table filled with concrete commit SHAs
4. T1460 release can ship v2026.4.150+

## Open questions for orchestrator decision

1. **T1454 dispatch**: nexus.ts uses `TypedDomainHandler<NexusOps>` (T1424 form) not `OpsFromCore<typeof coreOps>` (ADR-057 D3 form). File as follow-up `T-NEXUS-DISPATCH-FORM`?
2. **Backward-compat positional overloads** in T1454: cleanup epic to remove overloads after CLI/tests/Studio fully migrated? File as `T-CORE-OVERLOAD-CLEANUP`?
3. **T1450 remaining alias** in `session.ts:246` (params.startTask ?? params.focus): fold into T1458's Part B alias-removal pattern, or file as separate?
