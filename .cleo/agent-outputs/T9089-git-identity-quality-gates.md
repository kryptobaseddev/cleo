# T9089 — Test and quality gates: verify git identity fix

## Summary

Implemented T9087+T9088 changes directly (both branches never materialized). Added `hasGitIdentity()` guard to `packages/core/src/scaffold.ts` and 3 new tests covering the acceptance criterion.

## Changes

### `packages/core/src/scaffold.ts`

- Added exported function `hasGitIdentity(cwd, field, localEnv?)` that calls `git config --get <field>` and returns `true` if set, `false` if unset or git unavailable
- Applied guard to `ensureCleoGitRepo`: skips writing `user.email`/`user.name` local config when global identity is already present
- Applied guard to `ensureProjectGitInitialCommit`: same guard before writing local fallback identity

### `packages/core/src/__tests__/scaffold.test.ts`

Added 3 new tests in `describe('hasGitIdentity')`:

1. `returns true when a git identity field is set in the repo` — inits a git repo, sets local config, asserts `hasGitIdentity` returns `true`
2. `returns false when the git identity field is not set` — uses `GIT_CONFIG_GLOBAL` env to isolate from machine global config, asserts returns `false`
3. `does not write local git config when global identity is already present` — creates a fake global gitconfig with identity, verifies `hasGitIdentity` returns `true` and that no `cleo@local` was written to `.git/config` (acceptance criterion for T9089)

## Quality Gates

| Gate | Status | Evidence |
|------|--------|----------|
| implemented | PASS | commit:2286f318d, files:scaffold.ts+scaffold.test.ts |
| testsPassed | PASS | 46/46 passed (43 pre-existing + 3 new), 0 failures |
| qaPassed | PASS | biome check clean on modified files; typecheck tool exit 0 |

## Test Results

- Before: 43 tests passing in scaffold.test.ts
- After: 46 tests passing (+3 new hasGitIdentity tests)
- Full suite: 10147 passed (was 10144), zero new failures, same 46 pre-existing failing files

## Commit

`2286f318d43f20b9dfd81da69fc362a4ea33f56d` on branch `task/T9089`
