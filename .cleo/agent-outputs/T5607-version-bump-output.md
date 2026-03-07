# T5607 Version Bump Pipeline Implementation

## Changes Made

### 1. `.cleo/config.json`
Added `release.versionBump.files` with VERSION (plain strategy) and package.json (json strategy, field: version).

### 2. `src/dispatch/engines/release-engine.ts`
- Imported `bumpVersionFromConfig` and `getVersionBumpConfig` from version-bump.js
- Added `bump?: boolean` to `releaseShip()` params (default: true)
- Computed `bumpTargets = getVersionBumpConfig(cwd)` and `shouldBump = bump && bumpTargets.length > 0`
- Added Step 0: "Bump version files" — runs before all other steps when configured
- Updated all `logStep(n, 7, ...)` → `logStep(n, 8, ...)`
- Updated dry-run `wouldDo` to include bump step and list all staged files
- Updated `git add` to stage `['CHANGELOG.md', ...bumpTargets.map(t => t.file)]`

### 3. `src/cli/commands/release.ts`
- Added `--no-bump` option to `ship` subcommand
- Passed `bump: opts['bump'] !== false` to dispatch params

### 4. `src/dispatch/domains/pipeline.ts`
- Passed `bump` param from MCP/dispatch layer through to `releaseShip()`

## Verification
- `npx tsc --noEmit`: 0 errors
- `npx vitest run` (release suite): 137 tests pass
- `npm run build`: build complete
