# T756 — project-admin CI Fix

**Date**: 2026-04-16
**Commit**: 7962f6bd
**CI Run**: 24486605879 — GREEN

## Root Cause

The test failures were NOT envelope drift. The actual error was:

```
Error: Cannot find module '$lib/server/cli-action.js'
imported from .../routes/api/project/[id]/+server.ts
```

CI runs tests via `pnpm exec vitest run --shard=N/2` from the monorepo root,
which uses `vitest.config.ts` at the root. That config had aliases for all
`@cleocode/*` workspace packages but was missing the SvelteKit `$lib` path
alias. Locally the tests passed because running via
`pnpm --filter @cleocode/studio test` picked up `packages/studio/vitest.config.ts`
which already had `'$lib': ./src/lib`.

The T722 handlers (`[id]/+server.ts`, `[id]/index/+server.ts`,
`[id]/reindex/+server.ts`, `clean/+server.ts`, `scan/+server.ts`) all import
`$lib/server/cli-action.js`. This module was created by T722 after the root
vitest config was last updated — the alias gap was not caught because local
runs always use the per-package config.

## Fix

Added one alias to `vitest.config.ts` (root):

```ts
'$lib': new URL('./packages/studio/src/lib', import.meta.url).pathname,
```

No test changes. No implementation changes. Tests and implementation were
correct; only the test resolution environment was broken in CI.

## Verification

- Local: `pnpm exec vitest run packages/studio/src/routes/api/project/__tests__/project-admin.test.ts` — 31/31 pass
- Full suite: 448 files, 7957 tests passed, 0 failures
- Typecheck: clean
- CI run 24486605879: all jobs GREEN including both shards
