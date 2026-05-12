# T1929 Close-out: v2026.5.37 Hotfix Release

**Date**: 2026-05-06
**Task**: T1929 close-out (T1936 commit + v2026.5.37 hotfix release)
**Session**: ses_20260505154343_764261

## Summary

Landed the missing T1936 classifier registry-validation work and shipped v2026.5.37 as a hotfix for v2026.5.36.

## What Was Done

### Step 1 — T1936 typedAll fixup
Replaced the forbidden `as unknown as string[]` cast in `classify.ts:312` with the project's canonical `typedAll<{ agent_id: string }>(stmt, ...REGISTRY_QUERY_TIERS)` pattern from `packages/core/src/store/typed-query.ts`. No `any`, no `unknown`, no chained casts.

**Files changed in T1936 commit (`26ed6b63e`)**:
- `/mnt/projects/cleocode/packages/core/src/orchestration/classify.ts` — import `typedAll`, replace forbidden cast
- `/mnt/projects/cleocode/packages/core/src/orchestration/__tests__/classify.test.ts` — 35 tests all passing
- `/mnt/projects/cleocode/packages/core/src/orchestration/index.ts` — exports `validateClassifierRules`
- `AGENTS.md`, `CLAUDE.md`, `.cleo/project-context.json` — auto-managed

### Step 2 — Quality Gates
- `pnpm biome ci .` — exit 0 (2158 files checked)
- `pnpm run typecheck` — exit 0 (tsc -b strict)
- `pnpm run build` — exit 0 (full dep graph)
- `pnpm run test` — 19-21 failures (pre-existing Cat B flaky tests, zero classify-related failures)
- All 35 classify tests pass in isolation

### Step 3 — Version bump + CHANGELOG
- All packages bumped to `2026.5.37`
- CHANGELOG.md entry added at top

### Step 4 — Release commit (`4c38374a2`)
- Commit: `chore(release): bump to v2026.5.37 — T1936 classifier hotfix + T9021 perf bundle`
- Tag: `v2026.5.37`
- Push: `origin main` + `origin v2026.5.37`

### Step 5 — CI Verification
- Release workflow (`25444641044`): `completed/success`
- CI workflow (`25444640409`): `completed/failure` — pre-existing Cat B unit test shards (not new failures)
- Lockfile Check (`25444640139`): `completed/success`
- npm registry: `@cleocode/cleo@2026.5.37` confirmed
- pnpm global install: `cleo --version` = `2026.5.37`

### Step 6 — E2E Verification
- `cleo orchestrate spawn T1820 --json` → `"success":true` confirmed
- Classify metadata in spawn response: `"classify":{"agentId":"project-docs-worker","role":"worker","confidence":1,"usedFallback":false}`

## Key Findings
- `typedAll<T>` in `packages/core/src/store/typed-query.ts` is the centralized approach for node:sqlite typed queries
- `REGISTRY_QUERY_TIERS` is `readonly ['project', 'global', 'packaged']` — string literals are valid `SQLInputValue`s and can be spread directly
- The classifier now properly routes tasks through the DB-backed registry when a `DatabaseSync` handle is provided
- `validateClassifierRules()` correctly throws `ClassifierUnregisteredAgentError` on startup drift
