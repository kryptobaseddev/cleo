# T1915 — Migrate cleo CLI commands to @cleocode/paths SSoT

**Status**: complete  
**Branch**: task/T1915  
**Commit**: a074a1b6a22b33c3f07783c66ce9c7c3c30b7aca

## Summary

Replaced all `join(homedir(), '.cleo')` and hardcoded `join(homedir(), '.local', 'share', 'cleo', ...)` patterns in the cleo CLI package with `getCleoHome()` from `@cleocode/paths`.

## Files Changed

- `packages/cleo/package.json` — added `@cleocode/paths: workspace:*` dependency
- `packages/cleo/src/cli/commands/daemon.ts` — 4 sites (lines 189, 271, 315, 454): replaced `join(homedir(), '.cleo')` with `getCleoHome()`; removed `homedir` import from `node:os`; added `import { getCleoHome } from '@cleocode/paths'`
- `packages/cleo/src/cli/commands/gc.ts` — 2 sites (lines 64, 115): same replacement; same import change
- `packages/cleo/src/dispatch/domains/playbook.ts` — 1 site (line 220): replaced `join(homedir(), '.local', 'share', 'cleo', 'playbooks')` with `join(getCleoHome(), 'playbooks')`; removed `homedir` import; added `import { getCleoHome } from '@cleocode/paths'`

## Verification

- `pnpm biome ci` clean on 3 modified files
- `daemon-paths-compliance.test.ts` and `daemon-service.test.ts` pass (18 tests)
- Pre-existing test failures (87 files) unchanged before/after — confirmed via `git stash` comparison
- No new TypeScript errors introduced — confirmed via `git stash` comparison

## Cross-Platform Impact

`getCleoHome()` correctly resolves to:
- Linux: `~/.local/share/cleo` (XDG_DATA_HOME)
- macOS: `~/Library/Application Support/cleo`
- Windows: `%LOCALAPPDATA%\cleo\Data`

The previous `~/.cleo` default was Linux-only and did not honor `CLEO_HOME` overrides. This is now fixed for all three CLI commands.
