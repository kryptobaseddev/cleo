# T5718: Fix @cleocode/core import resolution + complete dispatch rewiring

**Status**: COMPLETE
**Date**: 2026-03-17

## Problem

The previous agent (T5716) rewired 25 dispatch files from `../../core/` to `@cleocode/core` and added a `tsconfig.json` path mapping pointing to `./packages/core/src/index.ts`. TypeScript compilation failed because that path is outside `rootDir: "./src"`:

```
error TS6059: File 'packages/core/src/index.ts' is not under 'rootDir' 'src'.
```

## Solution Applied: Option C (in-tree alias resolution)

Changed all three resolution systems to map `@cleocode/core` to `src/core/index.ts` (within rootDir) for the main build, while keeping the standalone package build separate:

### 1. tsconfig.json path mapping

Changed `@cleocode/core` path from `./packages/core/src/index.ts` to `./src/core/index.ts`.

### 2. build.mjs esbuild plugin

Changed the main build's `adapterMap` entry for `@cleocode/core` from `packages/core/src/index.ts` to `src/core/index.ts`. The standalone `corePackageBuildOptions` is unaffected (it uses `packages/core/src/index.ts` as its entry point, not as an import target).

### 3. vitest.config.ts resolve alias

Changed `@cleocode/core` alias from `packages/core/src/index.ts` to `src/core/index.ts`.

## Dispatch files rewired (12 source files)

All remaining `../../core/` imports in non-test dispatch files changed to `@cleocode/core`:

- `src/dispatch/middleware/audit.ts` -- logger, project-info, audit re-exports
- `src/dispatch/middleware/protocol-enforcement.ts` -- ProtocolEnforcer
- `src/dispatch/middleware/verification-gates.ts` -- createVerificationGate
- `src/dispatch/lib/security.ts` -- input-sanitization re-exports
- `src/dispatch/lib/param-utils.ts` -- param-utils re-exports
- `src/dispatch/lib/capability-matrix.ts` -- capability-matrix re-exports
- `src/dispatch/lib/engine.ts` -- pipeline-manifest-sqlite re-exports
- `src/dispatch/engines/tools-engine.ts` -- AdapterManager, sync, diagnostics, pagination
- `src/dispatch/engines/template-parser.ts` -- template parser + types
- `src/dispatch/engines/system-engine.ts` -- 15 core system imports + 11 type re-exports
- `src/dispatch/engines/validate-engine.ts` -- validate-ops + 5 protocol validators + resolveProjectRoot
- `src/dispatch/engines/sticky-engine.ts` -- sticky operations + types

## Test files: LEFT AS-IS (8 files)

Test files were intentionally NOT rewired because they use `vi.mock()` targeting specific submodule paths (e.g., `vi.mock('../../../core/tasks/show.js')`). These mocks intercept the underlying modules that `@cleocode/core` barrel re-exports from, so the mocking works correctly without changes:

- `src/dispatch/engines/__tests__/lifecycle-engine.test.ts`
- `src/dispatch/engines/__tests__/task-engine.test.ts`
- `src/dispatch/engines/__tests__/session-handoff-fix.test.ts`
- `src/dispatch/domains/__tests__/nexus.test.ts`
- `src/dispatch/domains/__tests__/tasks-filters.test.ts`
- `src/dispatch/domains/__tests__/pipeline.test.ts`
- `src/dispatch/domains/__tests__/orchestrate.test.ts`
- `src/dispatch/domains/__tests__/check.test.ts`

## Missing export added

`validateLabels` was added to `src/core/index.ts` (from `./templates/parser.js`) because `template-parser.ts` imports it.

## Verification

- `npx tsc --noEmit` -- exits 0, clean
- `npm run build` -- exits 0, all 3 outputs produced (CLI 2.1MB, MCP 1.8MB, core 1.3MB)
- 31 engine tests pass (task-engine, session-handoff-fix, lifecycle-engine)
- 60 domain tests pass (nexus, tasks-filters, pipeline, orchestrate, check)

## Resolution mapping summary

| Context | `@cleocode/core` resolves to | Why |
|---------|------------------------------|-----|
| TypeScript (tsc) | `src/core/index.ts` | Within rootDir, full barrel |
| esbuild main build | `src/core/index.ts` | Same codebase, bundled inline |
| esbuild core package | Entry point (`packages/core/src/index.ts`) | Standalone bundle |
| Vitest | `src/core/index.ts` | Matches tsc resolution |
| npm consumers | `packages/core/dist/` | Published standalone |
