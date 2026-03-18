# T5716 Waves 0-3 Complete (Adapted Approach)

**Date**: 2026-03-17
**Branch**: feature/T5701-core-extraction
**Agent**: wave-relay

## Summary

Completed the practical extraction work for @cleocode/core with an adapted approach
that respects the root tsconfig `rootDir: "./src"` constraint. Rather than physically
moving 350+ files (which would break the rootDir and require rewriting every import
in the codebase), we:

1. Created `src/primitives/` layer to break store→core circular deps
2. Added `@cleocode/core` to build.mjs and vitest.config.ts
3. Created the Cleo facade class
4. Extended the purity gate for packages/core/
5. Finalized publishConfig

## Commits (6 total)

1. `d48a8b9d` — Wave 0: primitives + package.json + tsconfig
2. `78519dd5` — Wave 1: rewire 14 store files to use primitives
3. `fa7879fb` — Build: @cleocode/core in esbuild + vitest aliases
4. `3db4549b` — Cleo facade class
5. `8d36e642` — Purity gate extension + publishConfig
6. `25e413bc` — Smoke test (10/10 passing)

## Architecture Decision

The original plan to physically move files from `src/core/` to `packages/core/src/`
was blocked by TypeScript's rootDir constraint. Files in `src/` cannot import from
`packages/core/src/` when rootDir is `./src`. The re-export barrel approach (Option A
from T5713) is the correct architecture for this monorepo structure:

- `packages/core/src/index.ts` re-exports from `src/core/index.js`
- `build.mjs` and `vitest.config.ts` resolve `@cleocode/core` to source
- Consumers can `import { tasks, Cleo } from '@cleocode/core'`

## Verification

- TSC: PASS (zero errors)
- Build: PASS
- Purity gate: PASS
- Smoke test: 10/10 PASS
- Full test suite: running (background)
