# T5716 Bundle Complete

**Task**: T5716
**Epic**: T5701
**Date**: 2026-03-17
**Status**: complete

---

## Summary

Added a second esbuild build target `corePackageBuildOptions` in `build.mjs` that bundles `packages/core/src/index.ts` into `packages/core/dist/index.js` with all `src/core/` and `src/store/` code inlined. Updated `packages/core/package.json` to wire the `build` script.

## What Changed in build.mjs

- Added `corePackageBuildOptions` block after the existing `buildOptions` definition:
  - `entryPoints`: `['packages/core/src/index.ts']`
  - `outfile`: `packages/core/dist/index.js`
  - Plugin `bundle-core-workspace-packages`:
    - `@cleocode/contracts` → bundled inline (resolved to `packages/contracts/src/index.ts`)
    - All other `@cleocode/*` (caamp, lafs-protocol) → external
    - All other bare npm imports → external
- Added `--core-only` flag path: runs only the core bundle + TSC declarations, skips CLI/MCP
- Default (no flags) path: builds CLI/MCP first, then also builds the core bundle
- TSC declaration step runs via `spawnSync` with `--emitDeclarationOnly` after the esbuild step

## packages/core/package.json

- `build` script changed from no-op stub to: `cd ../.. && node build.mjs --core-only`
- `typecheck` script changed to: `tsc --noEmit`

## What packages/core/dist/ Now Contains

- `index.js` — 1.35 MB self-contained ESM bundle (all `src/core/` + `src/store/` + `@cleocode/contracts` inlined)
- `index.js.map` — 2.9 MB source map
- `src/` — TSC declaration output (mirrors `packages/core/src/` shape)

## Back-Reference Test

```
PASS: no back-refs
```

`grep "../../../src" packages/core/dist/index.js` returned no matches.

## Node Import Test

```
PASS: Cleo imported successfully
Has forProject? function
```

`import { Cleo } from './packages/core/dist/index.js'` succeeds with `Cleo.forProject` available as a function.

## External Dependencies (Must Be Provided by Consumer)

- `@cleocode/caamp`
- `@cleocode/lafs-protocol`
- `better-sqlite3` / `drizzle-orm` / `drizzle-orm/*`
- `pino`, `env-paths`, `zod`, `ajv`, `ajv-formats`
- `proper-lockfile`, `write-file-atomic`
- `yaml`, `sql.js`, `pino-roll`
- Node built-ins (`node:*`)

## TSC Declarations Note

The `--emitDeclarationOnly` step logs TS errors related to the `packages/core/tsconfig.json` `rootDir` constraint (files in `src/types/` outside the `include` pattern). These are pre-existing declaration errors from T5713 and do not affect the JS bundle. The bundle itself is clean. The existing `index.d.ts` (from the prior TSC run) remains valid.
