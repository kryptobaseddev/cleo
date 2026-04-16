# T755 — v2026.4.63 CI Deep Fix

**Date**: 2026-04-16
**Status**: complete
**Version target**: v2026.4.63 → v2026.4.64

## Summary

Fixed 8 TypeScript errors and 1 install-test runtime crash that broke CI on v2026.4.63 main.

## Class A: TypeScript Errors Fixed (8 total → 0)

### 1. `@cleocode/core` missing subpath exports for transcript modules (5 errors)

**Files changed**:
- `packages/core/package.json` — added `"./memory/transcript-scanner.js"` and `"./memory/transcript-extractor.js"` subpath exports with `.js` extension keys (required by NodeNext module resolution to match the `.js` import specifiers in transcript.ts)
- `build.mjs` — added `coreBuildOptions.entryPoints` for `packages/core/src/memory/transcript-scanner.ts` and `packages/core/src/memory/transcript-extractor.ts`
- `.github/workflows/release.yml` — added `dist/memory/transcript-scanner.js` and `dist/memory/transcript-extractor.js` to the tarball verify required files gate

**Root cause**: `transcript.ts` imports via `@cleocode/core/memory/transcript-scanner.js` (dynamic import, `.js` extension). The `package.json` exports map had no entry for `./memory/transcript-scanner.js`. TypeScript 6 + NodeNext resolves subpath exports from `package.json`, so without the export key, TypeScript reported TS2307.

The export keys must use the exact `.js` extension because the import specifiers include `.js`. A wildcard `"./memory/*"` would incorrectly expand `*` = `transcript-scanner.js` producing `./dist/memory/transcript-scanner.js.d.ts`.

### 2. `transcript.ts:346` implicit `any` on parameter `w` (1 error)

Added explicit `: string` annotation to `(w: string) => w.includes('Already extracted')`. The parameter type is `string` (from `string[]`), but TypeScript 6 inferred `any` in this context.

### 3. `memory-brain.ts:1338` unsafe CountdownRow cast (1 error)

Replaced `.all() as CountdownRow[]` with a typed `.map()` that converts each `Record<string, unknown>` row into a properly typed `CountdownRow` using `String()`, `Number()`, and null-check on `quality_score`. No `as unknown as X` chains used.

### 4. `gc/runner.ts:279` check-disk-space not callable (1 error)

**Root cause**: TypeScript 6 + NodeNext resolves `check-disk-space` to its `.d.ts` via the `"types"` condition in `package.json` exports. The package ships `.mjs` for ESM but no `.d.mts`. TypeScript 6 in ESM mode requires `.d.mts` for proper default export inference when the runtime file is `.mjs`. Without it, TypeScript 6 widens the inferred type to the module namespace (`typeof import(...)`) which has no call signatures.

**Fix**: Added `packages/cleo/src/types/check-disk-space.d.ts` — a module declaration shim that provides the correct callable default export type. This is the standard TypeScript pattern for fixing broken third-party type declarations without unsafe casts.

## Class B: Install-Test Runtime Crash Fixed

**Error**: `Dynamic require of "events" is not supported at node-cron@4.2.1/dist/esm/tasks/inline-scheduled-task.js`

**Root cause**: `node-cron@4.2.1` contains CJS-style `require('events')` calls in its ESM distribution. When esbuild bundles the CLI, it inlines `node-cron`'s source, producing a bundle that uses `require()` for Node built-ins — which isn't supported in ESM output.

**Fix**: Added `'node-cron'` to `sharedExternals` in `build.mjs`. esbuild now emits `import cron from "node-cron"` in the bundle instead of inlining the source. The CLI loads `node-cron` at runtime from `node_modules`.

`node-cron` was already in `packages/cleo/package.json` as a runtime dependency — no new dependency entry required.

## Verification

```
pnpm run typecheck  → exit 0 (0 errors, down from 8)
pnpm run build      → Build complete (transcript-scanner.js + transcript-extractor.js in dist/memory/)
node packages/cleo/dist/cli/index.js --version → 2026.4.63 (no Dynamic require crash)
pnpm run test       → 31 failed (pre-existing studio failures, no new failures introduced)
```

Transcript dist files confirmed:
- `packages/core/dist/memory/transcript-scanner.js`
- `packages/core/dist/memory/transcript-extractor.js`

node-cron externalized confirmed:
- `import cron from "node-cron"` in dist/cli/index.js (not bundled)

## Files Changed

| File | Change |
|------|--------|
| `packages/core/package.json` | Added `./memory/transcript-scanner.js` + `./memory/transcript-extractor.js` subpath exports |
| `build.mjs` | Added transcript entry points to `coreBuildOptions` + `node-cron` to `sharedExternals` |
| `.github/workflows/release.yml` | Added transcript files to tarball verify gate |
| `packages/cleo/src/cli/commands/transcript.ts` | Explicit `: string` type on parameter `w` at line 346 |
| `packages/cleo/src/cli/commands/memory-brain.ts` | Typed map replacing unsafe `as CountdownRow[]` cast |
| `packages/cleo/src/gc/runner.ts` | Default import for `check-disk-space` (was unchanged; shim handles the type) |
| `packages/cleo/src/types/check-disk-space.d.ts` | New module declaration shim for TypeScript 6 + NodeNext default import fix |
