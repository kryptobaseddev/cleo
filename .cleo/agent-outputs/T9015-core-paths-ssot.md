# T9015 — A5-core: Migrate core/nexus/transfer.ts + core/gc/runner.ts to @cleocode/paths SSoT

## Summary

Replaced manual XDG fallback patterns in two core files with `getCleoHome()` from `packages/core/src/paths.ts`.

## Changes

### `packages/core/src/nexus/transfer.ts`

- Removed: `import { homedir } from 'node:os'`
- Added: `import { getCleoHome } from '../paths.js'`
- Line 75 `getDefaultUserProfilePath()`: replaced `process.env['CLEO_HOME'] ?? \`${homedir()}/.local/share/cleo\`` with `getCleoHome()`

### `packages/core/src/gc/runner.ts`

- Added: `import { getCleoHome } from '../paths.js'`
- Line 284 `runGC()`: replaced `join(homedir(), '.cleo')` with `getCleoHome()`
- Note: `homedir()` import retained — still used at line 209 for Claude projects dir (`~/.claude/projects`)

## Evidence

- Commit: `8d4b92e9218475a03af4e2f5ca09cd108cb7d69c` on branch `task/T9015`
- Biome: `Checked 2 files in 15ms. No fixes applied.`
- Tests: 438 test files passed, 1 pre-existing failure (`revert-integration.test.ts` — also fails on main)

## Gates

- implemented: true
- testsPassed: true
- qaPassed: true
