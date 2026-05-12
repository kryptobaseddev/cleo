# T1177: ESM-native migration folder resolution — Implementation Complete

**Task**: T-MSR-W3-1: Rewrite 5 resolve*MigrationsFolder() to use import.meta.resolve() + createRequire().resolve() fallback
**Status**: done
**Commit**: e47c1194162dada91ee7dde8cd95892ee82732e2
**Date**: 2026-04-22

---

## Summary

Replaced fragile `__dirname` path-math in all five migration-folder resolvers with
ESM-native Node module resolution. A centralized helper was created and each DB-specific
function now delegates to it.

## Files Changed

### New: `packages/core/src/store/resolve-migrations-folder.ts`
Shared helper `resolveCorePackageMigrationsFolder(setName)` with two-strategy resolution:
1. `import.meta.resolve('@cleocode/core', import.meta.url)` — ESM-native, Node 18.19+ (two-arg form)
2. `createRequire(import.meta.url).resolve('@cleocode/core')` — CJS interop synchronous fallback

Resolution: `@cleocode/core` main entry (`dist/index.js`) → two `dirname()` calls → package root → `migrations/<setName>`.

### Rewrites (5 files)

| File | Function | DB set |
|------|----------|--------|
| `packages/core/src/store/sqlite.ts` | `resolveMigrationsFolder()` | `drizzle-tasks` |
| `packages/core/src/store/memory-sqlite.ts` | `resolveBrainMigrationsFolder()` | `drizzle-brain` |
| `packages/core/src/store/nexus-sqlite.ts` | `resolveNexusMigrationsFolder()` | `drizzle-nexus` |
| `packages/core/src/telemetry/sqlite.ts` | `resolveTelemetryMigrationsFolder()` | `drizzle-telemetry` |
| `packages/core/src/store/signaldock-sqlite.ts` | `resolveSignaldockMigrationsFolder()` | `drizzle-signaldock` |

Each becomes a one-liner: `return resolveCorePackageMigrationsFolder('<db-set>');`

### Cleanup (unused imports removed)
- `fileURLToPath` removed from: `sqlite.ts`, `memory-sqlite.ts`, `nexus-sqlite.ts`, `signaldock-sqlite.ts`, `telemetry/sqlite.ts`
- `dirname` removed from `signaldock-sqlite.ts` (was only used by the old walk loop)

### New: `packages/core/src/store/__tests__/resolve-migrations-folder.test.ts`
12 tests covering:
- Returns absolute path for all 5 DB sets
- Each path contains correct `migrations/<setName>` segment
- All 5 paths exist on disk
- All 5 paths are distinct
- All 5 wrapper functions delegate correctly
- All 5 wrapper functions resolve to the same package root

## Test Results

- New test file: **12/12 passed**
- Core package suite: 5403 passed (2 pre-existing timing failures in performance/e2e tests unrelated to T1177)
- Biome: 1795 files checked, no fixes needed
- tsc: exit 0

## Layouts Covered

| Layout | How it resolves |
|--------|----------------|
| Workspace dev (tsx source) | pnpm symlinks `@cleocode/core` → `packages/core/dist/index.js`; two dirname() → `packages/core/` |
| Bundled dist/ | Same — `@cleocode/core` in `node_modules` points to `dist/index.js` |
| Global npm install | `npm i -g @cleocode/core` → global node_modules; createRequire resolves via NODE_PATH |

## No-escalation note for R4

Both resolution strategies (import.meta.resolve + createRequire) succeed in workspace dev layout.
The bundled case (T1178) is not yet activated — this task correctly handles both layouts in parallel
until T1178 removes the bundled case.
