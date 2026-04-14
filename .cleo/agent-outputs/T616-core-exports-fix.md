# T616 — @cleocode/core exports map fix

**Status**: complete  
**Date**: 2026-04-14  
**Task**: T616 — BUG CRITICAL: @cleocode/core npm package missing per-file modules — NEXUS CLI broken

## Root Cause

`packages/core/package.json` exports map had:

```json
"./*": {
  "types": "./dist/*.d.ts",
  "import": "./dist/*.js",
  "require": "./dist/*.js"
}
```

In Node.js exports maps, the `*` wildcard does NOT match path separators (`/`).
So `@cleocode/core/store/nexus-sqlite` (subpath = `./store/nexus-sqlite`) failed
to resolve because `store/nexus-sqlite` contains a `/`.

The CLI dynamic imports in `packages/cleo/src/cli/commands/nexus.ts` lines 170
and 1332 use:
```ts
import('@cleocode/core/store/nexus-sqlite' as string)
```

On a fresh install (no workspace symlinks), Node.js uses the published package's
exports map to resolve subpaths. With only `./*` → `./dist/*.js`, the path
`./store/nexus-sqlite` could not be matched, causing `E_CONTEXT_FAILED: Cannot
find module` for all `cleo nexus` commands.

## Fix Applied

`packages/core/package.json` — added two explicit subdirectory wildcard entries
before the catch-all `./*`:

```json
"./store/*": {
  "types": "./dist/store/*.d.ts",
  "import": "./dist/store/*.js",
  "require": "./dist/store/*.js"
},
"./conduit/*": {
  "types": "./dist/conduit/*.d.ts",
  "import": "./dist/conduit/*.js",
  "require": "./dist/conduit/*.js"
},
```

The `./conduit/*` entry was added as defensive coverage — while no current
deep conduit subpath imports exist, the pattern guards against future breakage.

## Version

Bumped `@cleocode/core` from `2026.4.46` to `2026.4.47`.

## Verification

- `npm pack --dry-run` confirms `dist/store/nexus-sqlite.js` and
  `dist/store/nexus-schema.js` are included in the tarball.
- Node.js exports resolution simulation confirms `./store/nexus-sqlite`
  now resolves to `./dist/store/nexus-sqlite.js`.
- `pnpm run build` passes with zero errors.
- Test failures (3) are pre-existing in `brain-lifecycle` and `brain-maintenance`
  from separate uncommitted work — confirmed by running tests without this change
  and observing identical failures.

## Files Changed

- `packages/core/package.json` — exports map + version bump
- `CHANGELOG.md` — 2026.4.47 entry
