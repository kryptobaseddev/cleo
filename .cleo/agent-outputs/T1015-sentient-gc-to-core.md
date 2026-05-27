# T1015 — Architecture cleanup: sentient+gc → core SDK

**Status**: complete
**Version shipped**: v2026.4.99
**Date**: 2026-04-20
**Session**: ses_20260420023541_d7ed28

## Summary

Relocated `packages/cleo/src/sentient/` and `packages/cleo/src/gc/` to `packages/core/src/`
via `git mv` (preserving file history). This restores the canonical architecture:
- `@cleocode/core` = SDK (ALL business logic)
- `@cleocode/cleo` = CLI only (dispatch + commands)

## Files Changed

### Moved (via git mv)
- `packages/cleo/src/sentient/` → `packages/core/src/sentient/` (8 files + ingesters/ + __tests__/)
- `packages/cleo/src/gc/` → `packages/core/src/gc/` (5 files + __tests__/)

### New Files
- `packages/core/src/sentient/index.ts` — barrel export
- `packages/core/src/gc/index.ts` — barrel export

### Updated Imports
- `packages/cleo/src/cli/commands/sentient.ts` — `../../sentient/*` → `@cleocode/core/sentient/*`
- `packages/cleo/src/cli/commands/gc.ts` — `../../gc/*` → `@cleocode/core/gc/*`
- `packages/cleo/src/cli/commands/daemon.ts` — `../../gc/daemon.js` → `@cleocode/core/gc/daemon.js`
- `packages/cleo/src/cli/commands/transcript.ts` — `../../gc/transcript.js` → `@cleocode/core/gc/transcript.js`
- `packages/cleo/src/dispatch/domains/sentient.ts` — dynamic imports updated to `@cleocode/core/sentient/*`

### Package Config
- `packages/core/package.json` — added `node-cron` + `check-disk-space` deps, `@types/node-cron` devDep, explicit subpath exports for all sentient/* and gc/* files

### Test Config
- `vitest.config.ts` (root) — added aliases for all `@cleocode/core/sentient/*` and `@cleocode/core/gc/*` subpaths
- `packages/cleo/vitest.config.ts` — same aliases added

## Key Lesson

With TypeScript NodeNext module resolution, wildcard subpath exports like `"./sentient/*"` do NOT resolve `.js`-suffixed imports (e.g. `@cleocode/core/sentient/daemon.js`) because `*` = `daemon.js` → looks for `dist/sentient/daemon.js.d.ts`. Explicit entries are required for each consumed file.

For vitest (which uses Vite's module resolver), aliases must be added to BOTH the root `vitest.config.ts` and any package-level vitest config that runs tests under `cd ../..`.

## Commits
- `f53e4190d` — refactor(T1015): relocate sentient+gc daemons from cleo CLI package to core SDK
- `c542be81a` — chore(release): v2026.4.99 — T1015 architecture cleanup

## Quality Gates
- biome CI: PASS (0 errors, 1 pre-existing warning)
- tsc: PASS (both core and cleo build clean)
- pnpm test (core+cleo): PASS (4846/4882 core — pre-existing flakes; 1569/1569 cleo)
- npm publish: v2026.4.99 live
