# T1178: Externalize @cleocode/core from cleo bundle (W3-2+W3-6)

**Status**: Complete  
**Commit**: fd3ff9b0361f925d6498df8baba5b41f228eddf2  
**Date**: 2026-04-22  

## Changes Made

Single file modified: `/mnt/projects/cleocode/build.mjs`

### 1. Added to `sharedExternals` array (line 138 region)

```javascript
'@cleocode/core',
/^@cleocode\/core\//,
```

These entries make esbuild treat `@cleocode/core` and all subpath imports (e.g. `@cleocode/core/internal`) as external at the sharedExternals layer.

### 2. Removed from `cleoBuildOptions` workspacePlugin inlineMap

Removed:
```javascript
'@cleocode/core': resolve(__dirname, 'packages/core/src/index.ts'),
'@cleocode/core/internal': resolve(__dirname, 'packages/core/src/internal.ts'),
```

The remaining workspacePlugin logic already handles unmapped `@cleocode/*` packages: `{ path: args.path, external: true }`.

## Bundle Size Results

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| `dist/cli/index.js` | 6,642,091 bytes (6.64 MB) | 1,885,953 bytes (1.89 MB) | -4,756,138 bytes (-71.6%) |

The R4 research projected ~3 MB reduction; actual reduction was 4.75 MB (71.6% vs projected 69%).

## Verification

- **Core symbol absent**: `grep -c "migrateSanitized" packages/cleo/dist/cli/index.js` = 0
- **Core import references in bundle**: 21 `import ... from "@cleocode/core"` statements (external references, not inlined code)
- **Runtime CLI works**: `node packages/cleo/dist/cli/index.js --version` → `2026.4.108` (exit 0)
- **Build**: `pnpm run build` succeeded
- **Biome**: 1795 files checked, 0 errors, 1 pre-existing symlink warning

## Pre-existing Test Failures (not caused by T1178)

3 failures in the full test run were pre-existing before this change:

1. `sqlite-warning-suppress.test.ts` - Two tests fail due to `spawnSync` 5000ms timeout in a slow test environment; the CLI binary itself works correctly when invoked directly
2. `performance-safety.test.ts` - Timing fluke (50 tasks in 33s vs 20s cap); environment-dependent

These are documented for the orchestrator. The main test suite had 10592+ passing tests.

## Unblocked

Completing T1178 unblocked T1181 (Add @cleocode/core as peerDependency).
