# T1845-ci-fix: CI Bench Binary Resolution Fix

**Status**: complete
**Task**: T1845 (Worker T1845-CI-FIX)
**Commit**: f334f3763522e6b16095f776d988439863293120
**Branch**: task/T1845-ci-fix

## Problem

CI run at https://github.com/kryptobaseddev/cleo/actions/runs/25405224396 failed:
```
[bench] FATAL: cleo nexus analyze failed to spawn: spawnSync cleo ENOENT
```

The bench script used `spawnSync('cleo', ...)` which requires a global `cleo` install.
CI runners have no global install.

## Fix Applied

File: `scripts/bench/nexus-vs-gitnexus.mjs`

### 1. `resolveCleoBin()` logic inlined in `runCleoNexus()`

Priority resolution for the cleo binary:
1. `CLEO_BIN` env var (explicit override)
2. `packages/cleo/dist/cli/index.js` (local build, exists after `pnpm run build`)
3. PATH fallback (`cleo`) — dev machine convenience

The CI workflow already runs `pnpm run build` before the bench step (line 521-522 in `ci.yml`),
so `packages/cleo/dist/cli/index.js` is guaranteed to exist by the time the bench runs.

### 2. `resolveGitnexusBin()` helper added

Returns the binary name/path or `null` if absent. Checks `GITNEXUS_BIN` env first, then PATH.

### 3. gitnexus is now optional

- `runGitnexus()` return type updated to `| null`
- Returns `null` when `resolveGitnexusBin()` returns null (not on PATH)
- Returns `null` with graceful log when spawn fails with ENOENT (binary path doesn't exist)
- `main()` detects `cleoOnlyMode = gitnexusStats === null`
- Emits `"gitnexus": null, "delta": null` in output JSON
- Exits 0 in cleo-only mode (no regression = success)

## CI Workflow

`.github/workflows/ci.yml` nexus-bench job already has:
- `pnpm run build` step before the bench run step (line 521-522)
- `npm install -g gitnexus || true` (best-effort, line 523-524)
- `continue-on-error: true` (line 501)

No workflow changes required — the build step was already there.

## Verification

- Biome check: pass (0 errors)
- Typecheck: pass (tsc -b exit 0)
- Bench with local cleo + gitnexus: exit 0, 184 nodes detected
- Bench with local cleo + absent gitnexus (GITNEXUS_BIN=/nonexistent): exit 0, cleo-only mode
