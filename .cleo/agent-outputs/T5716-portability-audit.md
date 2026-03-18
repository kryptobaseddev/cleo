# T5716 Portability Audit: @cleocode/core

**Date**: 2026-03-17
**Auditor**: Deep portability audit agent
**Branch**: `feature/T5701-core-extraction`

---

## Verdict: MONOREPO-ONLY

`@cleocode/core` is **NOT standalone**. It is a thin re-export shell that only works when the full monorepo directory structure is present. If published to npm and installed in an external project, it will fail immediately at import time.

---

## Evidence

### 1. Entry point contains back-references to monorepo root

**File**: `packages/core/src/index.ts:15`
```typescript
export * from '../../../src/core/index.js';
```

This is a relative path that escapes `packages/core/` and reaches into `src/core/` at the monorepo root. When published as an npm tarball, this path will not exist.

### 2. Cleo facade contains 10 back-references

**File**: `packages/core/src/cleo.ts`

Every import in this file escapes the package boundary:
- Line 16: `export { tasks, sessions, memory, lifecycle } from '../../../src/core/index.js'`
- Line 19-25: 7 type imports from `../../../src/core/tasks/*.js`
- Lines 68-93: 7 dynamic `import('../../../src/core/tasks/*.js')` calls in the facade methods

### 3. TypeScript compilation fails standalone

Running `npx tsc --noEmit` inside `packages/core/` produces **cascading TS6307 errors**:
```
error TS6307: File '/mnt/projects/claude-todo/src/core/index.ts' is not listed within
the file list of project 'packages/core/tsconfig.json'.
```

The `tsconfig.json` sets `rootDir: "../../"` (the monorepo root) and `include: ["src/**/*"]` (only `packages/core/src/`). TypeScript follows the `../../../src/core/` imports but those files are outside the `include` pattern, causing errors for every transitively imported file.

### 4. dist/ contains raw back-references (not resolved)

**File**: `packages/core/dist/index.js`
```javascript
export * from '../../../src/core/index.js';
```

The compiled JavaScript in `dist/` still contains the literal `../../../src/core/index.js` import. The build did NOT resolve, bundle, or rewrite these paths. A consumer doing `import { tasks } from '@cleocode/core'` would get:
```
Error: Cannot find module '../../../src/core/index.js'
```

### 5. dist/ also contains the entire monorepo compiled output

The `dist/` directory contains:
- `dist/index.js` -- the broken re-export entry point
- `dist/core/` -- compiled copies of ALL `src/core/` modules (~40+ subdirectories)
- `dist/store/` -- compiled copies of ALL `src/store/` modules
- `dist/types/` -- compiled copies of type definitions
- `dist/config/` -- compiled config module
- `dist/packages/core/src/` -- a NESTED copy of the entry point (artifact of rootDir: "../../")
- `dist/src/core/` -- ANOTHER nested copy under `src/` prefix

The `dist/index.js` entry point does NOT reference the compiled `dist/core/` modules. It still points to `../../../src/core/index.js` which would be outside the npm tarball.

### 6. Build script is a no-op

**File**: `packages/core/package.json` build script:
```json
"build": "echo '@cleocode/core: monorepo shell -- full build in T5716' && exit 0"
```

The package's own build script does nothing. The `dist/` contents were produced by the root-level esbuild, which compiled the entire monorepo and placed output into `packages/core/dist/` as a side effect -- but with unresolved import paths.

### 7. npm pack would publish broken files

`npm pack --dry-run` shows it would include:
- `dist/` (with broken `../../../` imports)
- `src/` (TypeScript source with broken `../../../` imports)

Neither would work for a consumer.

### 8. package.json exports point to broken dist/

```json
"main": "./dist/index.js",      // contains: export * from '../../../src/core/index.js'
"types": "./dist/index.d.ts"     // contains: export * from '../../../src/core/index.js'
```

### 9. Smoke test only works within monorepo

The e2e test (`tests/e2e/core-package-smoke.test.ts`) imports `@cleocode/core` which resolves via npm workspace symlinks + Vitest resolve aliases. It passes because in the monorepo, the `../../../src/core/` path DOES exist. This test does NOT validate standalone portability.

### 10. No source files were moved into packages/core/

`packages/core/src/` contains only 2 real source files:
- `index.ts` (re-export shell)
- `cleo.ts` (facade with back-references)

Plus 4 pre-compiled artifacts (`index.js`, `index.d.ts`, and their `.map` files). Zero business logic files live inside `packages/core/`. All 40+ core modules remain in `src/core/` at the monorepo root.

---

## What T5716 DID Accomplish

1. **Circular dependency fix**: Extracted `src/primitives/` layer to break store-to-core circular imports
2. **Cleo facade class**: Created `packages/core/src/cleo.ts` with a project-bound API design
3. **esbuild alias**: Added `@cleocode/core` to the root esbuild config so monorepo-internal consumers can import it
4. **Vitest resolve alias**: Added mapping so tests can import `@cleocode/core`
5. **Smoke test**: Added e2e test that validates exports (within monorepo only)
6. **package.json**: Proper metadata, dependencies, publishConfig
7. **Purity gate extension**: Updated `dev/check-core-purity.sh`

## What T5716 Did NOT Accomplish

1. **No file moves**: Zero `src/core/` files were moved or copied into `packages/core/src/`
2. **No standalone build**: The build script is a no-op placeholder
3. **No import rewriting**: `dist/` contains raw `../../../` paths that break outside the monorepo
4. **No standalone compilation**: `tsc --noEmit` fails with hundreds of TS6307 errors
5. **No publishable tarball**: `npm pack` would produce a broken package
6. **No external consumer test**: The smoke test only validates monorepo-internal resolution

---

## What Would Be Required for True Standalone Portability

### Option A: File Move (Clean but Large)
Move all `src/core/**` files into `packages/core/src/core/`. Update all imports throughout the monorepo. This is the "real" extraction but touches hundreds of files.

### Option B: Bundle at Build Time (Pragmatic)
Use esbuild/rollup to produce a self-contained `dist/` that inlines all `src/core/` code. The source stays in `src/core/` but the published artifact is standalone. Requires:
1. A real build script in `packages/core/package.json`
2. esbuild config that resolves `../../../src/core/` imports and bundles them
3. Type declaration generation (either bundled .d.ts via dts-bundle-generator or API Extractor)
4. Removal of `src` from the `files` array (only publish `dist/`)
5. An external-project integration test (not just monorepo smoke test)

### Option C: TypeScript Path Aliases + Build Rewrite
Use `tsconfig.json` path aliases (`@core/*` -> `../../src/core/*`) and a build step that rewrites them. Less invasive than Option A but still requires tooling.

---

## Summary Table

| Check | Result | Detail |
|-------|--------|--------|
| Source back-references | FAIL | 10+ `../../../src/core/` imports |
| Standalone tsc | FAIL | Cascading TS6307 errors |
| dist/ self-contained | FAIL | Raw `../../../` paths in compiled JS |
| Build script | FAIL | No-op placeholder |
| npm pack viable | FAIL | Would publish broken package |
| Smoke test validates portability | FAIL | Only tests monorepo resolution |
| Business logic in packages/core/ | FAIL | 0 files; all in src/core/ |

**Bottom line**: `@cleocode/core` is currently a monorepo-internal convenience alias, not a publishable standalone package. It works within the monorepo via workspace symlinks and build aliases, but cannot function as an independent npm package.
