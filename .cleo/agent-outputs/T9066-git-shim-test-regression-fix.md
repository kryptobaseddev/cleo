# T9066 — Fix git-shim boundary-enforcement test regression

## Summary

Fixed 5 failing tests in `packages/git-shim/src/__tests__/boundary-enforcement.test.ts` caused by T9016 migrating `worktree-path.ts` and `audit-log.ts` to consume `@cleocode/paths`.

## Root Cause

`@cleocode/paths` creates `cleoResolver` via `createPlatformPathsResolver('cleo', 'CLEO_HOME')`. The env-var override is `CLEO_HOME`, not `XDG_DATA_HOME`. Tests set `process.env['XDG_DATA_HOME'] = workspace` in `beforeEach`, which the resolver never reads.

## Fix Applied

1. Added `CLEO_HOME` to `ENV_KEYS` array for proper save/restore in `afterEach`
2. Changed `process.env['XDG_DATA_HOME'] = workspace` to `process.env['CLEO_HOME'] = workspace`
3. Updated path expectations to match actual resolver behaviour:
   - `resolveCleoWorktreesRoot()` → `join(workspace, 'worktrees')` (not `join(workspace, 'cleo', 'worktrees')`)
   - `resolveAuditLogPath()` → `join(workspace, 'audit', 'git-shim.jsonl')` (not `join(workspace, 'cleo', 'audit', ...)`)
4. Renamed misleading test: "resolveCleoWorktreesRoot uses XDG_DATA_HOME" → "resolveCleoWorktreesRoot honours CLEO_HOME override"

## Commit

`1fb6d2fdc592b9811635159a3ac25518bde1f01e` on `task/T9066`

## Results

- 33/33 `boundary-enforcement.test.ts` tests pass (was 28/33)
- 105/105 total git-shim tests pass
- biome: clean (no fixes applied)
